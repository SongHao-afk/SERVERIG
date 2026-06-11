# IG Downloader MVP

Project Node.js dùng Express + Playwright để xử lý tải nội dung Instagram và gửi cảnh báo qua email thông qua SMTP.

## 1. Yêu cầu

Cài trước:

```bash
node -v
npm -v
git --version
```

Nếu chưa có Node.js thì cài Node.js bản LTS.

## 2. Cài thư viện

Sau khi clone project về máy, vào thư mục project:

```bash
cd ig-downloader-mvp
```

Cài các module cần thiết:

```bash
npm install
```

Nếu cần cài thủ công lại từ đầu, dùng:

```bash
npm install express cors dotenv nodemailer playwright
```

Các thư viện chính:

| Thư viện     | Chức năng                                       |
| ------------ | ----------------------------------------------- |
| `express`    | Tạo server API                                  |
| `cors`       | Cho phép client gọi API từ domain khác          |
| `dotenv`     | Đọc biến môi trường từ file `.env`              |
| `nodemailer` | Gửi email cảnh báo qua SMTP                     |
| `playwright` | Điều khiển trình duyệt để xử lý phiên Instagram |

Sau khi cài xong, thư mục `node_modules/` sẽ được tạo tự động. Không cần push `node_modules/` lên GitHub.

## 3. Tạo file `.env`

Tạo file `.env` ở thư mục gốc của project:

```bash
cp .env.example .env
```

Nếu dùng Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Nội dung file `.env`:

```env
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=false
SMTP_USER=emailcuaban@gmail.com
SMTP_PASS=
ALERT_EMAIL_TO=emailcuaban@gmail.com
```

Ví dụ dùng Gmail SMTP:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cunhamatheus@gmail.com
SMTP_PASS=your_app_password_here
ALERT_EMAIL_TO=cunhamatheus@gmail.com
```

Lưu ý: với Gmail nên dùng App Password, không dùng mật khẩu tài khoản chính.

