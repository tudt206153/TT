# Live View cho WooCommerce

Xem trực tiếp khách nào đang ở trên web, đang xem sản phẩm nào, đã thêm vào giỏ, đang thanh toán hay vừa đặt hàng. Không cần cài plugin vào WordPress.

Bạn chỉ cần nhập **địa chỉ web** và **mật khẩu**. Mọi thứ khác app tự làm. Sau khi cài xong, mở app sẽ thấy trang **"Kết nối web"** có sẵn đoạn mã và thông tin webhook kèm nút Sao chép. Trang này tự báo khi web đã kết nối thành công.

---

## Cách 1: Không cần VPS (Render, bấm Deploy)

1. Tạo tài khoản miễn phí tại github.com. Bấm **New repository**, đặt tên (vd `live-view`), chọn **Private**, rồi bấm Create.
2. Trong repo vừa tạo, bấm **uploading an existing file** và kéo **toàn bộ các file bên trong** thư mục `live-view-app` vào (kéo các file, không kéo cả thư mục). Bấm **Commit changes**.
3. Tạo tài khoản tại render.com, chọn đăng nhập bằng GitHub.
4. Trong Render, bấm **New → Blueprint**, chọn repo `live-view` rồi bấm Connect.
5. Render hỏi đúng 2 ô:
   - `SITE_ORIGIN`: địa chỉ web bán hàng, vd `shopcuaban.vn`
   - `ADMIN_PASSWORD`: mật khẩu đăng nhập Live View
6. Bấm **Deploy Blueprint**. Đợi khoảng 1 đến 2 phút.
7. Mở đường link dạng `https://woocommerce-live-view-xxxx.onrender.com`. Đăng nhập với tên `admin` và mật khẩu vừa đặt, rồi làm theo trang "Kết nối web".

HTTPS, mã bí mật webhook và tự khởi động lại đều do Render lo. Cấu hình đang chọn gói Starter (trả phí theo tháng). Gói Free sẽ "ngủ" khi không có truy cập nên không hợp với live view.

## Cách 2: Có VPS Ubuntu (một lệnh)

1. Ở nơi quản lý tên miền, tạo bản ghi **A**: tên `live`, giá trị là IP của VPS.
2. Tải thư mục `live-view-app` lên VPS (bằng WinSCP/FileZilla, hoặc lệnh `scp`).
3. Đăng nhập VPS và chạy:
   ```bash
   cd live-view-app
   sudo bash install.sh
   ```
4. Trả lời 4 câu hỏi: địa chỉ web, tên miền phụ, email, mật khẩu.
5. Script tự cài Node.js, Nginx, HTTPS, chạy nền và tự khởi động cùng VPS. Xong sẽ hiện đường link, ví dụ `https://live.shopcuaban.vn`. Mở link đó và làm theo trang "Kết nối web".

---

## Trang "Kết nối web" (giống nhau cho cả hai cách)

Trang này hướng dẫn hai việc làm trong WordPress, mỗi việc chỉ cần sao chép rồi dán:

1. **Dán đoạn mã vào footer của theme.** Ví dụ với Flatsome: Flatsome → Advanced → Global Settings → Footer Scripts. Sau đó xoá cache.
2. **Thêm webhook đơn hàng** trong WooCommerce → Cài đặt → Nâng cao → Webhooks.

Mỗi bước có nhãn trạng thái:
- **Đang chờ** → **Đã kết nối**: kết nối thành công.
- **Sai địa chỉ web**: app cho biết web đang gửi từ địa chỉ nào, để bạn sửa lại cho khớp.

Nút **Kết nối web** ở góc màn hình Live View sẽ mở lại trang này bất cứ lúc nào.

## Lưu ý
- Khi kiểm tra, mở web bằng cửa sổ ẩn danh. Người đang đăng nhập có thanh admin của WordPress sẽ không được tính.
- Nếu dùng WP Rocket hoặc LiteSpeed với tính năng trì hoãn JavaScript (Delay JS), thêm `t.js` vào danh sách loại trừ.
- Nếu có plugin bảo mật chặn REST API, hãy cho phép đường dẫn `/wp-json/wc/store/` để app đọc được giỏ hàng.
- App dùng cookie `lsm_sid` để nhận diện phiên truy cập và không lưu IP. Bạn nên ghi chú điều này trong chính sách quyền riêng tư của web.

## Lệnh hữu ích trên VPS
```bash
pm2 logs live-view      # xem nhật ký
pm2 restart live-view   # khởi động lại
sudo bash install.sh    # chạy lại để đổi địa chỉ web hoặc mật khẩu (mã bí mật webhook được giữ nguyên)
```
