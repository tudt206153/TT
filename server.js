'use strict';
/**
 * Live View cho WooCommerce – web app độc lập (Node.js 18+, không cần thư viện ngoài).
 *  - /t.js                 script theo dõi, nhúng vào web WordPress
 *  - /collect              nhận tín hiệu từ trình duyệt khách
 *  - /webhook/woocommerce  nhận đơn hàng từ Webhook có sẵn của WooCommerce
 *  - /                     màn hình Live View (có mật khẩu)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Cấu hình ----------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// Người dùng có thể nhập "shopcuaban.vn", "https://www.shopcuaban.vn/" … app tự chuẩn hoá và thêm bản có/không có www.
function normalizeOrigins(raw) {
  const out = new Set();
  for (let item of String(raw || '').split(',')) {
    item = item.trim();
    if (!item) continue;
    if (!/^https?:\/\//i.test(item)) item = 'https://' + item;
    try {
      const u = new URL(item);
      const host = u.hostname.replace(/^www\./, '');
      out.add(u.protocol + '//' + host + (u.port ? ':' + u.port : ''));
      out.add(u.protocol + '//www.' + host + (u.port ? ':' + u.port : ''));
    } catch (e) { console.warn('Bỏ qua địa chỉ web không hợp lệ:', item); }
  }
  return [...out];
}

const CFG = {
  port: Number(process.env.PORT) || 3000,
  origins: normalizeOrigins(process.env.SITE_ORIGIN),
  user: process.env.ADMIN_USER || 'admin',
  pass: process.env.ADMIN_PASSWORD || '',
  webhookSecret: process.env.WC_WEBHOOK_SECRET || '',
  tz: process.env.TIMEZONE || 'Asia/Ho_Chi_Minh',
  trustProxy: process.env.TRUST_PROXY === '1',
  onlineMs: 60 * 1000,
};
if (!CFG.pass) { console.error('Thiếu ADMIN_PASSWORD trong file .env'); process.exit(1); }
if (!CFG.origins.length) console.warn('Cảnh báo: chưa đặt SITE_ORIGIN, app đang nhận dữ liệu từ mọi tên miền.');

const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

// Nếu chưa có mã bí mật webhook thì tự tạo và lưu lại.
if (!CFG.webhookSecret) {
  try { CFG.webhookSecret = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).webhookSecret || ''; } catch (e) {}
  if (!CFG.webhookSecret) {
    CFG.webhookSecret = crypto.randomBytes(24).toString('hex');
    try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify({ webhookSecret: CFG.webhookSecret })); } catch (e) {}
  }
}

// Trạng thái kết nối, hiển thị ở trang "Kết nối web".
const health = { lastCollect: 0, lastWebhook: 0, webhookError: '', webhookErrorAt: 0, rejectedOrigin: '', rejectedAt: 0 };
const PAGE_TYPES = new Set(['product', 'shop', 'category', 'cart', 'checkout', 'thankyou', 'home', 'other']);

// ---------- Dữ liệu ----------
const sessions = new Map();
let feed = [];
let feedSeq = 0;
let orders = {};
let today = freshToday();

function dateKey(t = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}
function freshToday() {
  return { date: dateKey(), visitors: new Set(), productViews: 0, addToCart: 0, orders: 0, revenue: 0, currency: '' };
}
function rollDay() { if (today.date !== dateKey()) today = freshToday(); }

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    feed = d.feed || []; feedSeq = d.feedSeq || 0; orders = d.orders || {};
    if (d.today && d.today.date === dateKey()) today = { ...d.today, visitors: new Set(d.today.visitors || []) };
  } catch (e) { /* lần chạy đầu */ }
}
function save() {
  try {
    const ids = Object.keys(orders);
    if (ids.length > 1000) ids.sort((a, b) => (orders[a].at || 0) - (orders[b].at || 0)).slice(0, ids.length - 1000).forEach(k => delete orders[k]);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ feed, feedSeq, orders, today: { ...today, visitors: [...today.visitors] } }));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('Không lưu được dữ liệu:', e.message); }
}

// ---------- Tiện ích ----------
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function siteUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return '';
    if (CFG.origins.length && !CFG.origins.includes(x.origin)) return '';
    return x.href.slice(0, 500);
  } catch { return ''; }
}
function anyUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ''; } catch { return ''; }
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function isBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return !ua || /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|preview|facebookexternalhit/.test(ua);
}
function clientIp(req) {
  if (CFG.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > 60000) { h = { t: now, n: 0 }; hits.set(ip, h); }
  return ++h.n > 120;
}

// ---------- Ghi nhận hoạt động ----------
function addEvent(type, s, extra = {}) {
  const e = { id: ++feedSeq, t: Date.now(), type, sid: s.sid || '', label: s.label || 'Khách', ...extra };
  feed.unshift(e);
  if (feed.length > 300) feed.length = 300;
  if (type === 'view_product') today.productViews++;
  if (type === 'add_to_cart') today.addToCart++;
  return e;
}

function statusOf(s, now = Date.now()) {
  if (s.page.type === 'thankyou') return 'purchased';
  if (s.page.type === 'checkout') return 'checkout';
  if (s.cart && s.cart.count > 0) return 'cart';
  if (s.orderAt && now - s.orderAt < 15 * 60000) return 'purchased';
  return 'browsing';
}

function handleCollect(d) {
  const sid = str(d.sid, 64);
  if (!/^[a-zA-Z0-9]{8,64}$/.test(sid)) return;
  rollDay();
  const now = Date.now();
  let s = sessions.get(sid);
  const isNew = !s;
  if (!s) {
    s = {
      sid, label: 'Khách #' + sid.slice(0, 4).toUpperCase(), named: false, member: false,
      page: {}, product: null, cart: null, orderId: '', orderAt: 0, orderTotal: 0, orderCurrency: '',
      device: d.mobile ? 'mobile' : 'desktop', source: str(d.source, 100), firstSeen: now, lastSeen: now, lastPageAt: 0,
    };
    sessions.set(sid, s);
  }
  s.lastSeen = now;
  today.visitors.add(sid);
  s.member = !!d.member;
  const name = str(d.customer, 80);
  if (name) { s.label = name; s.named = true; }

  // Trang đang xem
  if (d.type === 'page' || isNew) {
    const p = d.page || {};
    const type = PAGE_TYPES.has(p.type) ? p.type : 'other';
    const prod = type === 'product' && d.product && num(d.product.id) > 0 ? {
      id: num(d.product.id), name: str(d.product.name, 200) || 'Sản phẩm #' + num(d.product.id),
      price: str(d.product.price, 60), image: anyUrl(d.product.image), url: siteUrl(p.url),
    } : null;
    const samePage = s.page.type === type && (s.product && s.product.id) === (prod && prod.id) && now - s.lastPageAt < 5 * 60000;
    const prevType = s.page.type;
    s.page = { type, title: str(p.title, 250), url: siteUrl(p.url) };
    s.product = prod;
    if (d.type === 'page' && !samePage) {
      s.lastPageAt = now;
      if (prod) addEvent('view_product', s, { product: prod.name });
      else if (type === 'cart') addEvent('view_cart', s);
      else if (type === 'checkout' && prevType !== 'checkout') addEvent('begin_checkout', s);
    }
  }

  // Giỏ hàng: so với lần trước để biết khách vừa thêm hay bỏ món nào
  if (d.cart && typeof d.cart === 'object') {
    const items = {};
    for (const it of (Array.isArray(d.cart.items) ? d.cart.items : []).slice(0, 100)) {
      const key = str(String(it && it.key || ''), 64);
      if (key) items[key] = { name: str(it.name, 200), qty: Math.max(0, Math.floor(num(it.qty))), price: num(it.price) };
    }
    const cart = {
      count: Math.max(0, Math.floor(num(d.cart.count))), total: num(d.cart.total),
      currency: str(d.cart.currency, 3).toUpperCase(), items,
    };
    if (s.cart) {
      for (const [k, it] of Object.entries(items)) {
        const before = s.cart.items[k] ? s.cart.items[k].qty : 0;
        if (it.qty > before) addEvent('add_to_cart', s, { product: it.name, qty: it.qty - before, value: it.price * (it.qty - before), currency: cart.currency });
      }
      if (s.page.type !== 'thankyou') {
        for (const [k, it] of Object.entries(s.cart.items)) {
          const after = items[k] ? items[k].qty : 0;
          if (after < it.qty) addEvent('remove_from_cart', s, { product: it.name, qty: it.qty - after });
        }
      }
    }
    s.cart = cart;
  }

  if (d.order && num(d.order.id) > 0) {
    recordPurchase(d.order.id, { sid, total: num(d.order.total), currency: s.cart && s.cart.currency });
  }
  changed();
}

function recordPurchase(orderId, info) {
  const id = String(Math.floor(num(orderId)));
  if (id === '0') return;
  rollDay();
  const o = orders[id] || (orders[id] = { at: Date.now() });
  if (info.sid) o.sid = info.sid;
  if (info.total && (!o.total || info.fromWebhook)) o.total = info.total;
  if (info.currency) o.currency = info.currency;
  if (info.name) o.name = info.name;

  const s = o.sid && sessions.get(o.sid);
  if (s) {
    s.orderId = id;
    s.orderAt = s.orderAt || Date.now();
    s.orderTotal = o.total || 0;
    s.orderCurrency = o.currency || '';
    if (o.name && !s.named) { s.label = o.name; s.named = true; }
  }

  if (!o.logged) {
    o.logged = true;
    today.orders++;
    const ev = addEvent('purchase', s || { sid: o.sid, label: o.name || 'Khách' }, { orderId: id, value: o.total || 0, currency: o.currency || '' });
    o.eventId = ev.id;
  } else {
    const ev = feed.find(e => e.id === o.eventId);
    if (ev) { ev.value = o.total || ev.value; ev.currency = o.currency || ev.currency; if (o.name) ev.label = o.name; }
  }
  if (o.total && !o.counted) {
    today.revenue += o.total;
    today.currency = o.currency || today.currency;
    o.counted = true;
  }
  changed();
}

function handleWebhook(raw, req) {
  if (!CFG.webhookSecret) return 404;
  const sig = String(req.headers['x-wc-webhook-signature'] || '');
  const expected = crypto.createHmac('sha256', CFG.webhookSecret).update(raw).digest('base64');
  if (!sig || !safeEqual(sig, expected)) {
    health.webhookError = 'Mã bí mật (Secret) không khớp'; health.webhookErrorAt = Date.now();
    return 401;
  }
  health.lastWebhook = Date.now(); health.webhookError = '';
  let o;
  try { o = JSON.parse(raw.toString('utf8')); } catch { return 200; } // WooCommerce gửi "ping" khi tạo webhook
  if (!o || !o.id) return 200;
  if (o.created_via && !['checkout', 'store-api'].includes(o.created_via)) return 200; // bỏ qua đơn tạo trong trang quản trị
  if (['failed', 'cancelled', 'trash', 'checkout-draft'].includes(o.status)) return 200;
  const b = o.billing || {};
  recordPurchase(o.id, {
    total: num(o.total), currency: str(o.currency, 3).toUpperCase(),
    name: [str(b.first_name, 40), str(b.last_name, 40)].filter(Boolean).join(' '), fromWebhook: true,
  });
  return 200;
}

// ---------- Dữ liệu cho màn hình Live View ----------
function snapshot() {
  rollDay();
  const now = Date.now();
  const online = [...sessions.values()].filter(s => now - s.lastSeen < CFG.onlineMs).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 300);
  const viewing = new Map();
  const visitors = online.map(s => {
    if (s.product) {
      const v = viewing.get(s.product.id) || { ...s.product, viewers: 0 };
      v.viewers++; viewing.set(s.product.id, v);
    }
    return {
      sid: s.sid, label: s.label, member: s.member, status: statusOf(s, now),
      pageType: s.page.type || 'other', pageTitle: s.page.title || '', pageUrl: s.page.url || '',
      product: s.product, cartCount: s.cart ? s.cart.count : 0, cartTotal: s.cart ? s.cart.total : 0,
      currency: (s.cart && s.cart.currency) || s.orderCurrency || '', orderId: s.orderId, orderTotal: s.orderTotal,
      device: s.device, source: s.source,
      idle: Math.round((now - s.lastSeen) / 1000), duration: Math.round((now - s.firstSeen) / 1000),
    };
  });
  return {
    window: CFG.onlineMs / 1000,
    connected: health.lastCollect > 0 || feed.length > 0,
    visitors,
    hot: [...viewing.values()].sort((a, b) => b.viewers - a.viewers).slice(0, 8),
    feed: feed.slice(0, 40).map(e => ({ ...e, ago: Math.round((now - e.t) / 1000) })),
    today: {
      visits: today.visitors.size, productViews: today.productViews, addToCart: today.addToCart,
      orders: today.orders, revenue: today.revenue, currency: today.currency,
    },
  };
}

const streams = new Set();
let pending = null;
function changed() {
  if (pending || !streams.size) return;
  pending = setTimeout(() => { pending = null; broadcast(); }, 800);
}
function broadcast() {
  if (!streams.size) return;
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of streams) res.write(msg);
}

setInterval(broadcast, 10000);
setInterval(() => {
  const cut = Date.now() - 30 * 60000;
  for (const [k, s] of sessions) if (s.lastSeen < cut) sessions.delete(k);
  hits.clear();
}, 5 * 60000);
setInterval(save, 30000);

// ---------- Máy chủ HTTP ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, code, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(body);
}
function sendFile(res, file, type, extra = {}) {
  fs.readFile(path.join(PUBLIC, file), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, type, extra));
}
function authed(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return safeEqual(u, CFG.user) && safeEqual(p.join(':'), CFG.pass);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = req.method + ' ' + url.pathname;

  try {
    if (route === 'GET /t.js') {
      return sendFile(res, 'tracker.js', 'application/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
    }
    if (route === 'POST /collect') {
      const origin = String(req.headers.origin || '');
      if (CFG.origins.length && !CFG.origins.includes(origin)) {
        health.rejectedOrigin = origin.slice(0, 200); health.rejectedAt = Date.now();
        return send(res, 403, 'origin');
      }
      if (isBot(req) || rateLimited(clientIp(req))) return send(res, 204);
      const raw = await readBody(req, 32 * 1024);
      let d; try { d = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'json'); }
      health.lastCollect = Date.now();
      handleCollect(d);
      return send(res, 204);
    }
    if (route === 'POST /webhook/woocommerce') {
      const raw = await readBody(req, 2 * 1024 * 1024);
      return send(res, handleWebhook(raw, req));
    }
    if (route === 'GET /health') return send(res, 200, 'ok');

    // Từ đây trở xuống cần đăng nhập
    if (!authed(req)) return send(res, 401, 'Cần đăng nhập', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="Live View", charset="UTF-8"' });

    const secure = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };
    if (route === 'GET /') return sendFile(res, 'dashboard.html', 'text/html; charset=utf-8', secure);
    if (route === 'GET /api/setup') {
      const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
      const base = proto + '://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
      const now = Date.now();
      const since = t => (t ? Math.round((now - t) / 1000) : null);
      return send(res, 200, JSON.stringify({
        base, https: proto === 'https',
        snippet: '<script src="' + base + '/t.js" defer></script>',
        webhookUrl: base + '/webhook/woocommerce',
        secret: CFG.webhookSecret,
        sites: CFG.origins.filter(o => !/\/\/www\./.test(o)),
        health: {
          lastCollect: since(health.lastCollect), lastWebhook: since(health.lastWebhook),
          webhookError: health.webhookError, webhookErrorAgo: since(health.webhookErrorAt),
          rejectedOrigin: health.rejectedOrigin, rejectedAgo: since(health.rejectedAt),
        },
      }), 'application/json; charset=utf-8', secure);
    }
    if (route === 'GET /api/live') return send(res, 200, JSON.stringify(snapshot()), 'application/json; charset=utf-8', secure);
    if (route === 'GET /api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n');
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      streams.add(res);
      const ka = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ka); streams.delete(res); });
      return;
    }
    return send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) send(res, 400, 'Bad request');
  }
});

load();
server.listen(CFG.port, () => console.log(`Live View đang chạy tại http://localhost:${CFG.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
