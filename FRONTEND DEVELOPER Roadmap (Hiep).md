# **LỘ TRÌNH FRONTEND DEVELOPER** (Beginner) 

Ứng dụng phương pháp **Vibe Coding** (sử dụng AI và các công cụ như Google Antigravity IDE để tự động hóa viết code/boilerplate), cháu sẽ không phải "gõ từng dòng code" backend, mà thay vào đó là học tư duy **Kiến trúc hệ thống (Architecture), Thiết kế cơ sở dữ liệu (Database Design) và Luồng nghiệp vụ (Business Logic)** . 

Dưới đây là lộ trình triển khai chi tiết dựa trên PRD và Tech Stack đã chốt: React + Tailwind + Lucide + Chart.js cho Frontend; PostgreSQL, Supabase (Self-host) và Docker trên Ubuntu cho Backend/Infra. 

## **LỘ TRÌNH TRIỂN KHAI (8 - 12 TUẦN)** 

**Giai đoạn 1 (Tháng 1 - Tuần 1 đến Tuần 4): Vượt qua ranh giới Frontend - Xây dựng nền tảng Full Stack** 

Mục tiêu giai đoạn này là tương đương với **S1 & S2 trong PRD** , giúp cháu làm quen với Backend, Database và hoàn thiện luồng dữ liệu lõi. 

- **Tuần 1: Khởi tạo kiến trúc & Database Schema** 

   - **Nhiệm vụ:** Thiết lập dự án (Next.js hoặc React + Node.js API), cấu hình Tailwind, Lucide. 

   - **Khởi tạo khung giao diện (UI template)** (cài đặt React, Tailwind). 

   - Xây dựng các giao diện chính (Đăng nhập, Quên mật khẩu, Hồ sơ…) 

   - Xử lý thông báo. 

   - Xây dựng sơ đồ CSDL PostgreSQL dựa trên phần 13.2 của PRD. 

   - **Vibe Coding:** Dùng AI tạo toàn bộ câu lệnh SQL tạo bảng (building, floor, apartment, person, tenant, contract) và các ràng buộc (Foreign Keys, Unique constraints). 

- **Tuần 2: Xác thực (Auth) & Phân quyền (RLS/RBAC)** 

   - **Nhiệm vụ:** Tích hợp đăng nhập OTP qua số điện thoại. Thiết lập Row Level Security (RLS) trên Supabase để đảm bảo dữ liệu Tòa nhà/Căn hộ được phân quyền đúng theo vai trò (OWNER, MANAGER, RESIDENT). 

- **Tuần 3: Module Bất động sản (M03) & Cư dân (M04)** 

   - **Nhiệm vụ:** Xây dựng API và giao diện CRUD cho Tòa nhà, Khu, Tầng, Căn hộ. Phát triển sơ đồ trạng thái căn hộ (AVAILABLE, OCCUPIED...). 

Xây dựng hồ sơ cư dân. 

##### ● **Tuần 4: Nghiệp vụ Hợp đồng (M05) & Tiền cọc (M06)** 

- **Nhiệm vụ:** Viết luồng tạo hợp đồng thuê (kiểm tra chồng lấn kỳ hạn, chọn dịch vụ). Viết luồng thu/hoàn cọc (cọc không được cấn trừ vào tiền thuê, hoàn trong 3-5 ngày). 

- **Tiêu chí đánh giá Giai đoạn 1:** 

   - Hệ thống chạy local, đăng nhập thành công bằng OTP giả lập. 

   - Tạo thành công cây dữ liệu Tòa nhà -> Căn hộ -> Cư dân -> Hợp đồng. 

   - Code Backend (API/Supabase) gọi trơn tru từ Frontend. 

#### **Giai đoạn 2 (Tháng 2 - Tuần 5 đến Tuần 8): Làm chủ Business Logic & Tích hợp AI** 

Tương đương **S3, S4, S5 trong PRD** . Đây là lúc cháu thể hiện tư duy xử lý logic phức tạp và sử dụng mô hình Gemini Pro. 

##### ● **Tuần 5: Engine Tính tiền & Hóa đơn (M08, M09)** 

   - **Nhiệm vụ:** Viết logic tính tiền thuê pro-rata (chia theo số ngày), phí dịch vụ (ưu tiên giá theo hợp đồng trước, rồi đến giá tòa nhà). Xây dựng cron job chạy hằng ngày để sinh hóa đơn nháp theo billing_day của từng hợp đồng. Tính phí phạt chậm 100.000 ₫/ngày. 

   - **Vibe Coding:** Yêu cầu AI viết các Unit Test cho logic tính tiền (đây là FR rủi ro cao, NFR-001/014 yêu cầu test chặt chẽ). 

- **Tuần 6: Quản lý Yêu cầu (M11) & Thông báo (M13)** 

   - **Nhiệm vụ:** Xây dựng luồng báo hỏng cho cư dân. Tính năng copy nội dung thông báo chuẩn bị sẵn để dán sang nhóm Zalo. 

#### ● **Tuần 7: Tích hợp AI Gateway (M15)** 

   - **Nhiệm vụ:** Tích hợp Gemini Pro API (gọi từ Backend) để thực hiện 3 tác vụ MVP: Trích xuất dữ liệu CCCD/Hợp đồng, Đọc chỉ số đồng hồ điện/nước từ ảnh, Phân loại yêu cầu báo hỏng. 

   - **Lưu ý cốt lõi:** Áp dụng nguyên tắc "AI đề xuất, người quyết định". 

- **Tuần 8: Dashboard Chart.js (M14) & Hoàn thiện UI/UX** 

   - **Nhiệm vụ:** Dựng các biểu đồ doanh thu, công nợ, lấp đầy bằng Chart.js. Đảm bảo tính responsive, thiết kế mobile-first cho cổng cư dân. 

   - **Tiêu chí đánh giá Giai đoạn 2:** 

      - Sinh thành công hóa đơn kỳ cho 50 căn hộ tự động và chính xác. 

      - AI đọc được ảnh đồng hồ và phân loại được text báo hỏng. 

#### **Giai đoạn 3 (Tháng 3 - Tuần 9 đến Tuần 12): DevOps, Triển khai & Chuyển giao** 

Tương đương **S6 trong PRD** . Đưa ứng dụng từ máy local ra internet. 

##### ● **Tuần 9-10: Triển khai (Deployment) với Docker** 

- **Nhiệm vụ:** Đóng gói (Dockerize) toàn bộ ứng dụng (Web app + API + Cron jobs). Triển khai (Self-host) lên máy chủ Ubuntu tại Việt Nam theo yêu cầu của chủ đầu tư. 

##### ● **Tuần 11-12: Kiểm thử (UAT) & Tối ưu hóa** 

- **Nhiệm vụ:** Tối ưu hóa hiệu năng (API response < 500ms, trang tải < 2s). Chạy thử song song 1 kỳ thu phí với dữ liệu thực tế (quy mô ~50 căn). 

- **Tiêu chí đánh giá Giai đoạn 3:** 

   - Ứng dụng truy cập được qua Domain, có SSL/TLS (HTTPS). 

■ Vượt qua bài test sai lệch 0 đồng so với tính tay. 

### **YÊU CẦU BÁO CÁO & QUẢN LÝ TIẾN ĐỘ** 

Để tối ưu hóa Vibe Coding và quy trình đào tạo, cần tuân thủ format báo cáo sau: 

1. **Daily Stand-up (Cập nhật hằng ngày qua Chat/Git hoặc tạo Doc lưu lại lịch sử):** 

   - _Hôm qua làm gì? Hôm nay làm gì? Có blocker nào không?_ 

   - Chủ yếu tập trung vào việc cháu đã prompt AI như thế nào để giải quyết logic khó. 

2. **Weekly Review (Họp Review 1-1 mỗi cuối tuần):** 

   - **Demo sản phẩm:** Chạy các luồng user story (VD: AC-001.1, AC-015.1...) trên màn hình. 

   - **Code Review:** Anh sẽ review cấu trúc thư mục, cách chia component, và đặc biệt là các policy phân quyền (RLS) ở Backend xem có rủi ro lộ dữ liệu (NFR-008) không. 

3. **Báo cáo kỹ thuật (Sprint Retrospective):** Cuối mỗi giai đoạn, nộp một document ngắn gọn gọn mô tả cấu trúc DB, danh sách API endpoints đã chốt và các lỗi AI thường gặp trong quá trình sinh code để rút kinh nghiệm. 

### **TIÊU CHÍ ĐẠT ĐƯỢC SAU 2-3 THÁNG** 

Nếu hoàn thành lộ trình này, cháu sẽ: 

1. **Chuyển đổi thành công sang Full Stack:** Tự tin nắm giữ cả Frontend (React/Next) và Backend (Node/Postgres), hiểu sâu về Auth và Security. 

2. **Sở hữu một Product thực tế (MVP):** Làm ra một sản phẩm giải quyết bài toán thật cho doanh nghiệp quản lý tòa nhà, số hóa hoàn toàn nghiệp vụ cho quy mô 50 căn hộ. 

3. **Làm chủ AI-assisted Engineering (Vibe Coding):** Biết cách dùng AI để viết Unit Test, tạo boilerplate, và đóng gói Docker nhanh gấp 3 lần bình thường, chỉ tập trung vào Architecture. 

Cháu hãy đọc kỹ lại PRD, thiết lập môi trường Git/IDE và bắt đầu Tuần 1 ngay ngày mai nhé! 

