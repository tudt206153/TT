/* Live View – script theo dõi nhúng vào web WooCommerce */
(function () {
  'use strict';
  var me = document.currentScript;
  var BASE = window.LSM_BASE || (me && me.src ? me.src.replace(/\/t\.js(\?.*)?$/, '') : '');
  var body = document.body;
  if (!BASE || !body || !window.fetch || navigator.webdriver) return;
  var cls = body.classList;
  // Không tính quản trị viên/nhân viên (người có thanh admin bar).
  if (cls.contains('admin-bar') && !(me && me.getAttribute('data-track-admin') === 'true')) return;

  var origFetch = window.fetch.bind(window);

  // ----- Mã phiên của khách -----
  function getCookie(n) { var m = document.cookie.match('(?:^|; )' + n + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }
  function randomId() {
    var out = '', cr = window.crypto;
    if (cr && cr.getRandomValues) {
      var a = new Uint8Array(12); cr.getRandomValues(a);
      for (var i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    }
    return (Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '');
  }
  var sid = getCookie('lsm_sid');
  if (!/^[a-zA-Z0-9]{8,64}$/.test(sid)) sid = randomId();
  document.cookie = 'lsm_sid=' + sid + '; path=/; max-age=86400; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');

  // ----- Nguồn truy cập (lấy ở trang đầu tiên của phiên) -----
  var source = '';
  try {
    source = sessionStorage.getItem('lsm_src');
    if (source === null) {
      var q = new URLSearchParams(location.search), ref = '';
      if (q.get('utm_source')) ref = q.get('utm_source');
      else if (q.get('fbclid')) ref = 'facebook';
      else if (q.get('gclid')) ref = 'google ads';
      else if (document.referrer) {
        var h = new URL(document.referrer).hostname.replace(/^(www|m|l|lm)\./, '');
        if (h !== location.hostname.replace(/^www\./, '')) ref = h;
      }
      source = ref;
      sessionStorage.setItem('lsm_src', source);
    }
  } catch (e) { source = ''; }

  // ----- Loại trang (dựa vào class của WooCommerce trên thẻ body) -----
  var pageType =
    (cls.contains('woocommerce-order-received') || /order-received/.test(location.pathname)) ? 'thankyou' :
    cls.contains('woocommerce-checkout') ? 'checkout' :
    cls.contains('woocommerce-cart') ? 'cart' :
    cls.contains('single-product') ? 'product' :
    (cls.contains('post-type-archive-product') || cls.contains('woocommerce-shop')) ? 'shop' :
    (cls.contains('tax-product_cat') || cls.contains('tax-product_tag') || cls.contains('tax-product_brand')) ? 'category' :
    cls.contains('home') ? 'home' : 'other';

  function meta(p) { var m = document.querySelector('meta[property="' + p + '"]'); return m ? m.getAttribute('content') || '' : ''; }
  function text(sel) { var el = document.querySelector(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }

  var product = null;
  if (pageType === 'product') {
    var idm = body.className.match(/\bpostid-(\d+)\b/);
    var img = document.querySelector('.woocommerce-product-gallery img');
    product = {
      id: idm ? +idm[1] : 0,
      name: text('.product_title') || text('h1') || meta('og:title') || document.title,
      price: text('.summary .price') || text('.wc-block-components-product-price') || meta('product:price:amount'),
      image: meta('og:image') || (img ? (img.currentSrc || img.src) : '')
    };
  }

  // ----- Giỏ hàng: đọc qua Store API có sẵn của WooCommerce -----
  var apiLink = document.querySelector('link[rel="https://api.w.org/"]');
  var API = (apiLink ? apiLink.href : location.origin + '/wp-json/').replace(/\/?$/, '/');
  var EMPTY = { count: 0, total: 0, currency: '', items: [] };
  var cart = null, customer = '', order = null;

  function readCart() {
    return origFetch(API + 'wc/store/v1/cart', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (!c) return;
        var t = c.totals || {}, minor = +t.currency_minor_unit || 0, div = Math.pow(10, minor);
        try { sessionStorage.setItem('lsm_minor', String(minor)); } catch (e) {}
        cart = {
          count: +c.items_count || 0,
          total: (+t.total_price || 0) / div,
          currency: t.currency_code || '',
          items: (c.items || []).map(function (i) {
            return { key: i.key, name: i.name, qty: i.quantity, price: (+(i.prices && i.prices.price) || 0) / div };
          })
        };
        var b = c.billing_address || {};
        customer = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
      })
      .catch(function () {});
  }

  function readOrder() {
    if (pageType !== 'thankyou') return;
    var m = location.pathname.match(/order-received\/(\d+)/) || location.search.match(/[?&]order(?:-received|_id)?=(\d+)/);
    if (!m) return;
    var minor = 0;
    try { minor = +(sessionStorage.getItem('lsm_minor') || 0); } catch (e) {}
    var t = text('.woocommerce-order-overview__total .amount') ||
            text('.wc-block-order-confirmation-totals__total .wc-block-formatted-money-amount') ||
            text('.woocommerce-table--order-details tfoot tr:last-child .amount');
    order = { id: +m[1], total: t ? (+(t.replace(/[^\d]/g, '')) || 0) / Math.pow(10, minor) : 0 };
  }

  function send(type) {
    var data = {
      sid: sid, type: type,
      page: { type: pageType, title: document.title.slice(0, 250), url: location.href.slice(0, 500) },
      product: product, cart: cart, customer: customer, order: order,
      member: cls.contains('logged-in'), source: source,
      mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    };
    try {
      origFetch(BASE + '/collect', {
        method: 'POST', mode: 'no-cors', keepalive: true,
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(data)
      }).catch(function () {});
    } catch (e) {}
  }

  // Lần đầu: chỉ gọi Store API khi khách có hàng trong giỏ hoặc đang ở trang giỏ/thanh toán.
  var needCart = /(?:^|; )woocommerce_items_in_cart=1/.test(document.cookie) || /^(cart|checkout|thankyou)$/.test(pageType);
  var first = needCart ? readCart() : Promise.resolve(cart = EMPTY);
  first.then(function () { readOrder(); send('page'); });

  // Khi giỏ hàng thay đổi (cả kiểu cũ lẫn kiểu Block) thì đọc lại và báo về.
  var timer = null;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(function () { readCart().then(function () { send('cart'); }); }, 500);
  }
  if (window.jQuery) {
    window.jQuery(document.body).on('added_to_cart removed_from_cart updated_cart_totals updated_wc_div wc_cart_emptied', refresh);
  }
  window.fetch = function (input, init) {
    var p = origFetch.apply(null, arguments);
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' && /\/wc\/store\/(v1\/)?(cart|batch)/.test(u)) p.then(refresh, refresh);
    } catch (e) {}
    return p;
  };

  // Báo "vẫn đang ở đây" mỗi 20 giây khi tab đang mở.
  setInterval(function () { if (document.visibilityState === 'visible') send('ping'); }, 20000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') send('ping'); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) send('page'); });
})();
