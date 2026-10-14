# **PRD – Hệ thống quản lý căn hộ & nhà cho thuê** 

2026-09-18 · @Someone 

## **1. Thông tin tài liệu** 

PRD v0.2 cho hệ thống quản lý căn hộ & nhà cho thuê, đã cập nhật theo phản hồi của chủ đầu tư cho 20 câu hỏi chốt. Giai đoạn đầu 1 tòa ~50 căn; kiến trúc hướng tới 5–7 tòa thuê lại, có thể khác chủ sở hữu. 

|**Mục**|**Nội dung**|
|---|---|
|Tên sản phẩm|[THÔNG TIN CẦN BỔ SUNG] – tạm gọi**ResiHub**(tên làm việc, cần chủ<br>đầu tư chốt)|
|Phiên bản PRD|v0.2 – Cập nhật theo phản hồi chủ đầu tư|
|Ngày lập|18/09/2026|
|Trạng thái|Draft 2 – đã chốt vòng 1; còn các điểm mở tại mục 23|
|Product Owner|[THÔNG TIN CẦN BỔ SUNG]|
|Chủ đầu tư /<br>Sponsor|[THÔNG TIN CẦN BỔ SUNG]|
|Người soạn|PM/Solution Architect|
|Bên liên quan|Chủ đầu tư, Quản lý tòa nhà, Kế toán, Nhân viên kỹ thuật, Cư dân, Đội<br>Product/UX/Eng/QA|
|Phạm vi phiên<br>bản|MVP 1 tòa ~50 căn + nền tảng đa tòa|
|Tài liệu liên<br>quan|[THÔNG TIN CẦN BỔ SUNG] – mẫu hợp đồng thuê, biểu phí hiện hành,<br>quy chế quản lý tòa nhà|



#### **Lịch sử thay đổi** 

|**Phiên**<br>**bản**|**Ngày**|**Người**|**Thay đổi**|
|---|---|---|---|
|v0.1|18/09/2026|PM|Bản khởi tạo từ yêu cầu thô của chủ đầu tư|
|v0.2|18/09/2026|PM|Cập nhật theo phản hồi 20 câu hỏi: hạ tầng tại VN, đặt cọc giữ<br>chỗ vào MVP, giá dịch vụ theo hợp đồng, phí phạt chậm, đa<br>tòa/đa chủ sở hữu|



**Lưu ý về mức độ chắc chắn:** Tài liệu này được suy luận từ mô tả yêu cầu do bạn cung cấp. Mọi con số benchmark, ước lượng effort và tham chiếu pháp lý trong tài liệu là **ước tính/suy luận** , không phải dữ liệu đã kiểm chứng của dự án. Các mục pháp lý (Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân, Luật Nhà ở, quy định hóa đơn điện tử) được nêu ở mức cảnh báo tuân thủ, **không phải tư vấn pháp lý** — cần luật sư/kế toán trưởng rà soát và cần kiểm tra lại hiệu lực văn bản tại thời điểm triển khai vì quy định có thể đã thay đổi. 

## **2. Tóm tắt điều hành** 

Sản phẩm là một web application quản lý tập trung vận hành cho thuê căn hộ, gồm **cổng cư dân self-service** và **hệ thống quản trị** cho chủ đầu tư, quản lý tòa nhà, kỹ thuật và kế toán, có AI hỗ trợ nhập liệu, phân loại yêu cầu và soạn thảo. 

Vấn đề cốt lõi hiện nay (theo mô tả yêu cầu): vận hành ~50 căn hộ đang dựa vào sổ sách/Excel/Zalo rời rạc, dẫn đến sai sót công nợ, khó tra cứu hợp đồng và cọc, xử lý báo hỏng thủ công, và không có số liệu tổng hợp cho chủ đầu tư. _(Đây là suy luận từ bối cảnh bạn cung cấp — cần xác nhận hiện trạng thực tế.)_ 

MVP tập trung vào chuỗi nghiệp vụ xương sống: **căn hộ → khách đặt cọc giữ chỗ → cư dân → hợp đồng → cọc → dịch vụ & chỉ số điện nước → hóa đơn → thanh toán → công nợ** , cộng với **báo hỏng/bảo trì** và **thông báo** . Bốn điểm đã được chủ đầu tư chốt và có ảnh hưởng lớn tới thiết kế: đơn giá dịch vụ **thay đổi theo từng hợp đồng** , ngày thanh toán **không cố định theo tòa mà theo từng khách** , phí phạt chậm **100.000 ₫/ngày sau 5 ngày quá hạn** , và tiền cọc **không được cấn trừ vào tiền thuê** , hoàn trong 3–5 ngày sau khi chấm dứt hợp đồng. AI ở MVP vẫn chỉ làm 3 việc rủi ro thấp: trích xuất dữ liệu, phân loại–định tuyến yêu cầu, soạn nháp thông báo. **Mọi hành động có tác động tài chính, pháp lý hoặc thay đổi dữ liệu quan trọng đều bắt buộc có người phê duyệt.** 

Công nghệ: React + Tailwind + Lucide + Chart.js; PostgreSQL; Docker trên Ubuntu. **Chủ đầu tư yêu cầu máy chủ đặt tại Việt Nam** , nên kiến trúc triển khai đổi từ Supabase Cloud/Vercel sang **self-host tại nhà cung cấp hạ tầng trong nước** (xem mục 14). Supabase vẫn dùng được ở dạng self-host cho Auth/Storage/RLS, hoặc thay bằng stack tương đương; Vercel chỉ còn vai trò 

tùy chọn cho môi trường dev/preview không chứa dữ liệu thật. Gemini Pro (hoặc model tương đương) gọi qua backend, không gọi trực tiếp từ trình duyệt. 

Ước lượng sơ bộ: MVP khoảng **14–18 tuần** với đội 4–6 người — tăng so với v0.1 vì bổ sung luồng đặt cọc giữ chỗ, bảng giá dịch vụ theo hợp đồng, phí phạt chậm và công việc tự vận hành hạ tầng trong nước. _Đây là ước tính dựa trên kinh nghiệm chung với phạm vi tương đương, không phải cam kết — cần đội kỹ thuật ước lượng lại theo năng lực thực tế và theo nhà cung cấp hạ tầng được chọn._ 

## **3. Bối cảnh, vấn đề và cơ hội** 

Chủ đầu tư vận hành 1 tòa chung cư mini ~50 căn cho thuê và dự kiến mở rộng nhiều tòa, nhiều loại căn hộ; quy mô này vượt ngưỡng quản lý bằng Excel nhưng chưa đủ lớn để mua ERP bất động sản. 

**Các vấn đề nghiệp vụ cần giải quyết** (mức độ chắc chắn: suy luận từ phạm vi yêu cầu, cần phỏng vấn vận hành để xác nhận) 

|**#**|**Vấn đề**|**Tác động**|**Ai chịu ảnh hưởng**|
|---|---|---|---|
|P1|Dữ liệu căn hộ/cư dân/hợp đồng<br>nằm rời rạc ở nhiều file|Tra cứu chậm, sai lệch, mất<br>lịch sử|Quản lý, Kế toán|
|P2|Tính phí điện, nước, dịch vụ thủ<br>công theo tháng|Sai số hóa đơn, tranh chấp với<br>cư dân|Kế toán, Cư dân|
|P3|Theo dõi cọc và hoàn cọc không<br>có sổ cái rõ ràng|Rủi ro tranh chấp khi trả phòng|Chủ đầu tư, Cư dân|
|P4|Báo hỏng qua Zalo/điện thoại,<br>không có SLA|Sót yêu cầu, không đo được<br>chất lượng|Cư dân, Kỹ thuật|
|P5|Công nợ theo dõi thủ công, nhắc<br>nợ không đều|Dòng tiền chậm, khó đối soát|Kế toán, Chủ đầu tư|
|P6|Chủ đầu tư không có số liệu tổng<br>hợp theo thời gian thực|Quyết định giá/mở rộng thiếu<br>căn cứ|Chủ đầu tư|
|P7|Hợp đồng hết hạn không được<br>nhắc trước|Trống phòng ngoài kế hoạch|Quản lý|



**Cơ hội.** Một hệ thống duy nhất khóa chặt liên kết căn hộ–cư dân–hợp đồng–dịch vụ–hóa đơn–thanh toán sẽ vừa giảm thao tác thủ công vừa tạo dữ liệu chuẩn để mở rộng đa tòa mà 

không phải làm lại. AI làm giảm chi phí nhập liệu (điểm nghẽn lớn nhất của mô hình vận hành nhỏ) mà không cần thay đổi quy trình phê duyệt. 

**Vì sao là bây giờ.** Trước khi mở rộng tòa thứ hai, mô hình dữ liệu và quy trình cần được chuẩn hóa; làm sau sẽ tốn chi phí migrate dữ liệu lịch sử. 

**Giới hạn của phân tích này.** Tôi không có dữ liệu vận hành thực tế (tỷ lệ lấp đầy, doanh thu/căn, số yêu cầu bảo trì/tháng, tỷ lệ chậm thanh toán). Các mục tiêu định lượng ở phần 4 vì vậy là **đề xuất khung đo** , cần thay bằng baseline thật trước khi chốt PRD. 

## **4. Mục tiêu và chỉ số thành công** 

Mục tiêu được chia theo 4 nhóm; mọi giá trị mục tiêu dưới đây là **đề xuất khung đo** , cần thay bằng baseline thật của tòa nhà. 

|**ID**|**Mục tiêu**|**Chỉ số (KPI)**|**Baseline**|**Mục tiêu đề**<br>**xuất sau 3**<br>**tháng go-live**|**Nguồn**<br>**đo**|
|---|---|---|---|---|---|
|G1|Số hóa tập<br>trung vận hành|% căn hộ/hợp đồng/cư<br>dân đang hiệu lực có trên<br>hệ thống|[CẦN BỔ<br>SUNG]|100%|DB|
|G2|Giảm thời gian<br>lập hóa đơn kỳ|Số giờ kế toán/kỳ để phát<br>hành toàn bộ hóa đơn|[CẦN BỔ<br>SUNG]|Giảm ≥ 60%|Log thao<br>tác +<br>phỏng<br>vấn|
|G3|Minh bạch công<br>nợ|DSO (số ngày thu tiền<br>bình quân); % hóa đơn<br>quá hạn > 15 ngày|[CẦN BỔ<br>SUNG]|DSO giảm ≥<br>20%|DB hóa<br>đơn/thanh<br>toán|
|G4|Self-service cư<br>dân|% cư dân đang thuê đăng<br>nhập ≥ 1 lần/tháng|0|≥ 70%|Auth log|
|G5|Chất lượng xử<br>lý sự cố|% yêu cầu báo hỏng đóng<br>đúng SLA; thời gian phản<br>hồi đầu tiên|[CẦN BỔ<br>SUNG]|≥ 85% đúng<br>SLA; phản hồi<br>< 4h giờ hành<br>chính|Module<br>request|
|G6|Giảm nhập liệu<br>thủ công nhờ<br>AI|% trường dữ liệu do AI<br>trích xuất được người<br>dùng chấp nhận không<br>sửa|–|≥ 70%|AI review<br>log|



|G7|Giữ chân cư<br>dân|Tỷ lệ gia hạn hợp đồng; tỷ<br>lệ lấp đầy|[CẦN BỔ<br>SUNG]|Không giảm so<br>với baseline|DB hợp<br>đồng|
|---|---|---|---|---|---|
|G8|Sẵn sàng mở<br>rộng|Thời gian khởi tạo 1 tòa<br>mới (cấu hình đến sẵn<br>sàng vận hành)|–|< 1 ngày công|Đo khi<br>thêm tòa<br>2|



**Non-goals của MVP** (không đo, không ưu tiên): tối ưu giá thuê động, marketing/lead management, kế toán tài chính đầy đủ theo chuẩn mực, app native. 

**Nguyên tắc ưu tiên khi có xung đột:** chính xác tài chính > minh bạch dữ liệu > tốc độ thao tác > tự động hóa AI. Nghĩa là không đánh đổi tính đúng của hóa đơn/cọc để lấy tự động hóa. 

## **5. Phạm vi sản phẩm** 

Tiêu chí ưu tiên MVP: (1) chặn được rủi ro tiền bạc/pháp lý, (2) là tiền đề dữ liệu cho mọi module sau, (3) dùng hằng ngày bởi ≥ 2 vai trò, (4) chi phí xây dựng thấp so với giá trị. Mục nào chỉ tăng tiện nghi hoặc phụ thuộc bên thứ ba chưa chốt → đẩy sang phase sau. 

### **5.1 Trong phạm vi / ngoài phạm vi** 

|**Trong phạm vi sản phẩm**|**Ngoài phạm vi (out of scope)**|
|---|---|
|Quản lý tòa/khu/tầng/căn hộ, cư dân, hợp<br>đồng, cọc|Kế toán doanh nghiệp đầy đủ (sổ cái, thuế,<br>BCTC)|
|Dịch vụ, chỉ số điện/nước, biểu phí, hóa đơn,<br>thanh toán, công nợ|Định giá thuê tự động, sàn giao<br>dịch/marketplace|
|Báo hỏng, bảo trì, thiết bị, lịch công việc|Điều khiển thiết bị IoT/khóa thông minh<br>(Phase 3, cần khảo sát)|
|Thông báo, sự kiện, danh bạ, chatbot hỗ trợ|Ứng dụng native iOS/Android|
|Dashboard & báo cáo theo vai trò|Quản lý bán căn hộ, sổ đỏ, chuyển nhượng<br>sở hữu|
|RBAC, audit log, cấu hình hệ thống|Tích hợp phần mềm kế toán bên thứ ba<br>(đánh giá Phase 2)|



### **5.2 Phân kỳ** 

|**Phase**|**Nội dung chính**|**Lý do ưu**<br>**tiên**|
|---|---|---|
|**MVP (Phase**<br>**1)**|Auth OTP theo SĐT + RBAC; cấu trúc tòa/tầng/căn hộ; hồ<br>sơ cư dân; hợp đồng (tạo/gia hạn/chấm dứt); cọc<br>(thu/hoàn/khấu trừ); biểu phí; ghi chỉ số điện–nước; sinh hóa<br>đơn kỳ; ghi nhận thanh toán thủ công + công nợ; báo hỏng &<br>work order cơ bản; thông báo & sự kiện; cổng cư dân xem<br>thông tin/hóa đơn/gửi yêu cầu; dashboard 4 vai trò; audit log;<br>AI: trích xuất dữ liệu (CCCD/chỉ số/hợp đồng), phân<br>loại–định tuyến yêu cầu, soạn nháp thông báo|Chuỗi tiền và<br>chuỗi sự cố là<br>rủi ro cao<br>nhất, đồng<br>thời là nền dữ<br>liệu|
|**Phase 2**|Thanh toán online/VietQR + đối soát tự động; đăng ký & phê<br>duyệt dịch vụ trực tuyến (internet, gửi xe); quản lý thiết bị &<br>lịch bảo trì định kỳ đầy đủ; AI Chatbot cư dân (RAG trong<br>phạm vi quyền); nhắc việc tự động đa kênh (Zalo<br>ZNS/email); báo cáo nâng cao & xuất Excel; quy trình đặt<br>cọc online cho khách tiềm năng|Phụ thuộc<br>nhà cung<br>cấp/đối tác và<br>cần dữ liệu<br>MVP làm nền|
|**Phase 3**<br>**(candidate)**|Multi-tenant nhiều chủ đầu tư; ký hợp đồng điện tử; hóa đơn<br>điện tử tích hợp nhà cung cấp; app mobile; IoT đồng hồ<br>nước/điện; dự báo công nợ & churn|Giá trị cao<br>nhưng chi phí<br>và rủi ro tuân<br>thủ lớn|



### **5.3 Điều chỉnh phạm vi theo phản hồi chủ đầu tư (18/09/2026)** 

|**Nội dung**|**v0.1**|**v0.2 sau xác nhận**|**Ảnh hưởng**|
|---|---|---|---|
|Đặt cọc giữ<br>chỗ cho khách<br>chưa thuê|Phase 2|**Đưa vào MVP**(thực tế phát sinh cả 2<br>trường hợp: cọc giữ chỗ và cọc khi ký<br>ngay)|Thêm vai trò khách<br>tiềm năng, luồng công<br>khai, chuyển cọc giữ<br>chỗ → cọc hợp đồng|
|Đơn giá dịch<br>vụ|Theo<br>biểu phí<br>chung<br>của tòa|**Biểu phí chung + ghi đè theo từng**<br>**hợp đồng**|Thêm bảng giá cấp<br>hợp đồng; hóa đơn lấy<br>giá theo thứ tự ưu tiên<br>hợp đồng → tòa|
|Ngày thanh<br>toán|Cùng<br>ngày<br>chốt kỳ|**Theo từng hợp đồng/khách**|Job sinh hóa đơn chạy<br>hằng ngày theo<br>billing_daycủa<br>từng hợp đồng|



||cho toàn<br>tòa|||
|---|---|---|---|
|Phí phạt chậm|Chưa<br>xác định|**100.000 ₫/ngày, bắt đầu sau 5 ngày kể**<br>**từ hạn cuối**|Thêm FR-064, dòng<br>phí phạt trên hóa đơn<br>kỳ sau|
|Cấn trừ cọc<br>vào tiền thuê|Cho<br>phép<br>khấu trừ<br>công nợ|**Không cấn trừ cọc vào tiền thuê**;<br>hoàn cọc trong 3–5 ngày sau chấm dứt|Sửa logic tất toán ở<br>FR-024; khấu trừ chỉ<br>áp cho hư hỏng/chi phí<br>khác|
|Thanh toán<br>online|Phase 2|Giữ ở Phase 2 — hiện chuyển khoản<br>vào**tài khoản cá nhân**, nhân sự xác<br>nhận thủ công; sẽ chuyển sang**tài**<br>**khoản hộ kinh doanh**sau|Thiết kế sẵn trường tài<br>khoản nhận tiền theo tổ<br>chức để đổi không phải<br>sửa code|
|Kênh thông<br>báo|Trong<br>ứng<br>dụng +<br>email|Trong ứng dụng +**nội dung sẵn sàng**<br>**dán sang nhóm Zalo**(nhóm tòa và<br>nhóm từng phòng đang là kênh chính);<br>Zalo OA/ZNS đánh giá ở Phase 2|Thêm nút sao<br>chép/chia sẻ nội dung<br>thông báo; chưa tích<br>hợp API Zalo ở MVP|
|Hóa đơn điện<br>tử|Phase 3|Vẫn ngoài MVP nhưng**đã xác định sẽ**<br>**phải làm**, có nhân sự chuyên trách|Mô hình hóa đơn phải<br>giữ đủ trường để xuất<br>sang hệ thống hóa đơn<br>điện tử sau|
|Hợp đồng điện<br>tử|Phase 3|Giữ Phase sau, ký giấy + lưu bản chụp<br>ở MVP|Không đổi MVP|
|Đa tòa/đa chủ<br>sở hữu|"Có thể<br>mở rộng"|**Chắc chắn: dự kiến 5–7 tòa thuê lại**|org/ownervà phân<br>quyền theo tòa là bắt<br>buộc ngay từ MVP,<br>không để lại sau|
|Hạ tầng|Supabas<br>e Cloud<br>+ Vercel|**Máy chủ đặt tại Việt Nam (self-host)**|Đổi kế hoạch triển khai,<br>thêm việc vận hành hạ<br>tầng (mục 14, 19)|
|Thanh toán<br>cho nhà cung<br>cấp theo hợp<br>đồng/đơn<br>hàng|Không<br>nhắc tới|**Mới phát sinh**— đề nghị xếp Phase 2<br>và xác nhận lại phạm vi|Có thể cần module<br>công nợ phải trả, khác<br>hẳn công nợ phải thu|



## **6. Personas, vai trò và phân quyền tổng quan** 

Sáu vai trò bắt buộc, cộng hai vai trò **đề xuất** (đánh dấu rõ là đề xuất, không bắt buộc cho MVP). 

### **6.1 Personas** 

|**Vai trò**|**Mục tiêu chính**|**Nỗi đau**|**Tần suất**<br>**dùng**|**Thiết bị**<br>**chính**|
|---|---|---|---|---|
|Chủ đầu tư (OWNER)|Biết doanh thu, lấp đầy,<br>công nợ, sự cố mà không<br>cần hỏi từng người|Số liệu đến chậm,<br>không tin cậy|Tuần/thán<br>g|Mobile<br>+<br>desktop|
|Quản lý tòa nhà<br>(MANAGER)|Vận hành trơn tru, không<br>sót việc|Ôm quá nhiều đầu<br>việc thủ công|Hằng<br>ngày|Desktop|
|Nhân viên vận hành/kỹ<br>thuật (STAFF)|Biết hôm nay làm gì, ở<br>đâu, xong thì báo|Nhận việc qua tin<br>nhắn, dễ sót|Hằng<br>ngày, tại<br>hiện<br>trường|Mobile|
|Kế toán<br>(ACCOUNTANT)|Phát hành hóa đơn đúng,<br>thu đủ, đối soát được|Tính điện nước &<br>công nợ thủ công|Cao điểm<br>đầu/cuối<br>kỳ|Desktop|
|Cư dân (RESIDENT)|Xem tiền phải trả, báo<br>hỏng, nhận thông báo|Không biết phí<br>gồm gì, báo hỏng<br>không rõ tiến độ|Vài<br>lần/tháng|Mobile|
|Quản trị hệ thống<br>(SYS_ADMIN)|Cấu hình, phân quyền,<br>truy vết|–|Thấp|Desktop|
|_(Đề xuất)_Kế toán<br>trưởng/Phê duyệt tài<br>chính<br>(FIN_APPROVER)|Duyệt hoàn cọc, điều<br>chỉnh/hủy hóa đơn, xóa<br>nợ|–|Thấp|Desktop|
|_(Đề xuất)_Khách tiềm<br>năng (PROSPECT)|Xem căn trống, đặt cọc<br>giữ chỗ|–|Một lần|Mobile|



**Cập nhật sau phản hồi.** Cơ cấu vận hành thực tế: **6 người** , trong đó **2 người có quyền phê duyệt** , **1 người phụ trách báo cáo** , số còn lại lo quảng cáo/cho thuê, trực, ghi công tơ, sửa chữa và bảo trì. Quyết định cuối cùng khi các bên bất đồng thuộc về **Giám đốc và Phó Giám đốc** . 

Vì vậy hai vai trò trước đây đánh dấu "đề xuất" nay trở thành chính thức: 

- **APPROVER** (2 người): duyệt hoàn cọc, điều chỉnh/hủy hóa đơn, hợp đồng lệch khung giá, chi phí sửa chữa vượt ngưỡng. Vì có đủ 2 người duyệt tách khỏi người lập, quy tắc **người lập ≠ người duyệt được bật mặc định** , không cần nới lỏng. 

- **PROSPECT** (khách tiềm năng): cần thiết vì đặt cọc giữ chỗ đã vào MVP. 

Vai trò **REPORT_VIEWER** (1 người phụ trách báo cáo) không tạo mới mà dùng OWNER giới hạn phạm vi báo cáo — cần bạn xác nhận người này có được xem dữ liệu cá nhân cư dân hay chỉ số liệu tổng hợp. 

### **6.2 Ma trận phân quyền (RBAC) — mức module** 

C = Create, R = Read, U = Update, D = Delete/Hủy, A = Approve, – = không có quyền. Phạm vi dữ liệu: OWNER/SYS_ADMIN xem toàn bộ tổ chức; MANAGER/STAFF/ACCOUNTANT giới hạn theo **tòa nhà được gán** ; RESIDENT giới hạn theo **căn hộ và hợp đồng của chính mình** . 

|**Module**|**OWNER**|**MANAGER**|**STAFF**|**ACCOUNTANT**|**RESIDENT**|**SYS_ADMIN**|
|---|---|---|---|---|---|---|
|Tòa/khu/tầng<br>/căn hộ|R|CRU|R|R|R (căn của<br>mình)|CRUD|
|Cư dân & hồ<br>sơ|R|CRU|R (hạn<br>chế<br>PII)|R|RU (của<br>mình)|CRUD|
|Hợp đồng|R|CRU +<br>A(gia hạn)|–|R|R + đề nghị|R|
|Cọc|R +<br>A(hoàn<br>cọc)|CRU|–|CRU|R|R|
|Dịch vụ &<br>đăng ký|R|CRU + A|R|R|C (đăng<br>ký), R|R|
|Chỉ số<br>điện/nước|R|CRU|CU<br>(ghi<br>chỉ số)|CRU|R|R|
|Biểu phí|R|R|–|CRU|–|R|
|Hóa đơn|R|R|–|CRU + phát<br>hành|R|R|
|Thanh toán<br>& công nợ|R|R|–|CRU|R (của<br>mình)|R|



|Yêu cầu/báo<br>hỏng|R|CRU +<br>phân công|RU<br>(việc<br>của<br>mình)|–|C, R (của<br>mình)|R|
|---|---|---|---|---|---|---|
|Bảo trì &<br>thiết bị|R|CRU|RU|–|R (lịch<br>chung)|R|
|Thông báo &<br>sự kiện|R|CRU|R|R|R|R|
|Báo cáo &<br>dashboard|R (toàn<br>bộ)|R (tòa)|R<br>(việc)|R (tài chính)|–|R|
|Người dùng<br>& phân<br>quyền|–|–|–|–|–|CRUD|
|Cấu hình hệ<br>thống & tích<br>hợp|R|R|–|–|–|CRUD|
|Audit log|R|R (tòa)|–|R (tài chính)|–|R|



#### **Quy tắc bổ sung** 

- Hành động **A (Approve)** không được thực hiện bởi chính người tạo bản ghi (four-eyes). Ở cấu hình tòa nhỏ, có thể tắt quy tắc này bằng cấu hình nhưng phải ghi nhận vào audit log. 

- RESIDENT chỉ thấy PII của chính mình và thành viên hộ mà mình khai báo; không thấy cư dân căn khác. 

- STAFF thấy tên + số điện thoại liên hệ của cư dân **chỉ trong phạm vi work order được giao** , không thấy CCCD, hợp đồng, công nợ. 

- Mọi quyền được kiểm tra hai lớp: UI ẩn/hiện và **Row Level Security ở PostgreSQL** (không tin client). 

## **7. User journey và quy trình nghiệp vụ chính** 

Bốn hành trình cốt lõi. Các trạng thái chi tiết nằm ở mục 7.5 và state machine đầy đủ ở mục 12–13. 

### **7.1 Từ khách thuê đến cư dân (onboarding)** 

flowchart LR 

A[Khách quan tâm] --> B[Xem căn trống] B --> C[Đặt cọc giữ chỗ] 

C --> D[Soạn hợp đồng] D --> E[Ký + thu cọc] E --> F[Bàn giao căn hộ] F --> G[Kích hoạt tài khoản<br/>cư dân] G --> H[Đăng ký dịch vụ] 

Cả hai tình huống đều phát sinh thực tế và đều thuộc MVP: (1) khách xem phòng, đặt cọc giữ chỗ khi **chưa** làm hợp đồng — cọc này sau đó chuyển thành cọc hợp đồng khi ký; (2) khách chốt nhận phòng ngay, làm hợp đồng và đặt cọc cùng lúc — bỏ qua bước C. Nếu khách hủy sau khi giữ chỗ, áp dụng chính sách mất cọc theo cấu hình — **chính sách cụ thể cần chủ đầu tư chốt** (xem mục 23). 

### **7.2 Chu kỳ thu phí hằng tháng** 

flowchart LR 

A[Chốt kỳ] --> B[Ghi chỉ số<br/>điện nước] B --> C[Sinh hóa đơn nháp] C --> D{Kế toán rà soát} D -->|Đạt| E[Phát hành + gửi] D -->|Sai| B E --> F[Cư dân thanh toán] F --> G[Ghi nhận + đối soát] G --> H[Công nợ / nhắc nợ] 

Hóa đơn chỉ rời trạng thái nháp khi có thao tác phát hành của kế toán; AI không được tự phát hành. 

### **7.3 Báo hỏng đến hoàn tất sửa chữa** 

flowchart LR 

A[Cư dân gửi<br/>báo hỏng] --> B[AI phân loại<br/>+ đề xuất ưu tiên] B --> C[Quản lý duyệt<br/>và phân công] C --> D[Kỹ thuật xử lý] D --> E{Phát sinh chi phí?} E -->|Có| F[Duyệt chi phí<br/>và ghi phí] E -->|Không| G[Đóng yêu cầu] F --> G G --> H[Cư dân đánh giá] 

### **7.4 Kết thúc hợp đồng và hoàn cọc** 

flowchart LR 

A[Đề nghị chấm dứt] --> B[Duyệt và chốt ngày] 

B --> C[Kiểm tra căn hộ] C --> D[Chốt chỉ số cuối] D --> E[Hóa đơn cuối kỳ] E --> F[Tính khấu trừ cọc] F --> G{Đủ bù trừ?} G -->|Dư| H[Hoàn phần còn lại] G -->|Thiếu| I[Ghi công nợ còn lại] 

### **7.5 Ngoại lệ bắt buộc phải xử lý** 

|**Ngoại lệ**|**Cách xử lý quy định trong PRD**|
|---|---|
|Trùng cư dân (cùng<br>SĐT/CCCD)|Chặn tạo mới, hiển thị bản ghi trùng, cho phép hợp nhất có audit<br>(FR-021)|
|Cư dân chuyển<br>phòng|Chấm dứt hợp đồng cũ + tạo hợp đồng mới; cọc có thể chuyển<br>(transfer) thay vì hoàn, ghi rõ bút toán|
|Hợp đồng hết hạn<br>không gia hạn|Tự chuyểnEXPIREDsau ngày kết thúc + cảnh báo trước 60/30/15<br>ngày; căn hộ vềAVAILABLEchỉ sau khi bàn giao|
|Hoàn cọc một phần|Bắt buộc bảng khấu trừ từng khoản, có chứng từ/ảnh, cần phê duyệt<br>FIN_APPROVER/OWNER|
|Thanh toán thiếu|Ghi nhận partial, hóa đơn ởPARTIALLY_PAID, tiếp tục tính công nợ<br>phần còn lại|
|Thanh toán thừa|Sinh số dư tạm giữ (credit) gán cho hợp đồng, tự bù kỳ sau hoặc<br>hoàn khi kết thúc|
|Hủy dịch vụ giữa kỳ|Tính phí theo tỷ lệ ngày (pro-rata) theo cấu hình; nêu rõ quy tắc làm<br>tròn|
|Yêu cầu trùng lặp|AI/hệ thống cảnh báo trùng theo căn hộ + loại + 24h; cho phép gộp<br>vào yêu cầu gốc|
|Mất kết nối khi ghi<br>chỉ số|Cho nhập offline-tolerant: lưu nháp cục bộ, đồng bộ lại, chống ghi đè<br>bằng kiểm tra phiên bản|
|Phân quyền không<br>đủ|Trả 403 với thông điệp rõ ràng + ghi audit; không lộ sự tồn tại dữ liệu<br>ngoài phạm vi|
|AI không chắc chắn|Trả kèm độ tin cậy; dưới ngưỡng thì chuyển người xử lý, không tự<br>điền, không đoán|



## **8. Kiến trúc thông tin và sitemap** 

Hai không gian tách biệt trên cùng một ứng dụng: / (cổng cư dân + trang giới thiệu công khai) và /admin (hệ thống quản trị). Điều hướng admin theo **tòa nhà đang chọn** (building switcher trên thanh trên cùng) để sẵn sàng đa tòa. 

### **8.1 Sitemap cổng cư dân** 

flowchart TD 

H[Trang chủ công khai] --> H1[Giới thiệu tòa nhà & tiện ích] 

H --> H2[Danh sách căn trống<br/>+ bộ lọc] H --> H3[Đặt cọc giữ chỗ<br/>Phase 2] H --> L[Đăng nhập OTP] L --> P[Cổng cư dân] P --> P1[Tổng quan căn hộ] P --> P2[Hợp đồng & cọc] P --> P3[Hóa đơn & thanh toán] P --> P4[Dịch vụ của tôi] P --> P5[Yêu cầu & báo hỏng] P --> P6[Thông báo & sự kiện] P --> P7[Danh bạ & hỗ trợ AI] P --> P8[Hồ sơ cá nhân] 

|**Trang**|**Nội dung chính**|**Hành động chính**|
|---|---|---|
|Tổng quan căn<br>hộ|Mã căn, diện tích, tầng, trạng thái, hợp đồng<br>hiệu lực, số dư phải trả|Xem chi tiết, tải hợp đồng|
|Hợp đồng &<br>cọc|Lịch sử thuê, các lần gia hạn/thay đổi, sổ cọc|Đề nghị gia hạn / chấm<br>dứt|
|Hóa đơn &<br>thanh toán|Danh sách kỳ, chi tiết dòng phí, chỉ số điện<br>nước, trạng thái|Tải hóa đơn, báo đã<br>chuyển khoản|
|Dịch vụ của tôi|Điện, nước, internet, gửi xe, dịch vụ chung|Đăng ký / thay đổi / hủy|
|Yêu cầu & báo<br>hỏng|Danh sách yêu cầu, tiến độ, lịch sử bảo trì thiết<br>bị trong căn|Tạo yêu cầu, đính kèm<br>ảnh, đánh giá|
|Thông báo &<br>sự kiện|Thông báo BQL, lịch bảo trì/thu phí, sự kiện|Đánh dấu đã đọc, xác<br>nhận tham dự|
|Danh bạ & hỗ<br>trợ|Liên hệ BQL/kỹ thuật/khẩn cấp, chatbot|Gọi, nhắn, hỏi chatbot|



### **8.2 Sitemap hệ thống quản trị** 

flowchart TD 

A[/admin] --> D[Dashboard theo vai trò] A --> B[Bất động sản] A --> C[Cư dân & hợp đồng] A --> S[Dịch vụ & tiện ích] A --> F[Tài chính] A --> M[Kỹ thuật & bảo trì] A --> N[Truyền thông] A --> R[Báo cáo] A --> X[Quản trị hệ thống] 

|**Nhóm**|**Màn hình con**|
|---|---|
|Bất động sản|Tòa nhà · Khu/Block · Tầng · Căn hộ · Sơ đồ trạng thái căn hộ|
|Cư dân & hợp<br>đồng|Cư dân · Hộ khẩu thuê · Hợp đồng · Cọc · Yêu cầu gia hạn/chấm dứt|
|Dịch vụ & tiện ích|Danh mục dịch vụ · Đăng ký dịch vụ · Chỉ số điện–nước · Gửi xe|
|Tài chính|Biểu phí · Hóa đơn · Thanh toán · Công nợ · Hoàn tiền · Đối soát|
|Kỹ thuật & bảo trì|Yêu cầu/báo hỏng · Work order · Thiết bị · Lịch bảo trì · Lịch nhân sự|
|Truyền thông|Thông báo · Sự kiện · Danh bạ · Nhóm cư dân/BQT|
|Báo cáo|Doanh thu · Công nợ · Lấp đầy · Sự cố & SLA · Tiêu thụ điện nước|
|Quản trị hệ thống|Người dùng · Vai trò & quyền · Cấu hình · Tích hợp & API key · Audit<br>log · Cấu hình AI|



**Quy ước điều hướng.** Mọi danh sách admin dùng chung khung: bộ lọc trái/trên, bảng giữa, panel chi tiết trượt phải; hành động hàng loạt nằm ở thanh nổi khi chọn nhiều dòng. Mọi bản ghi nghiệp vụ quan trọng (căn hộ, hợp đồng, hóa đơn, yêu cầu) có tab **Lịch sử/Audit** ngay trong trang chi tiết. 

## **9. Danh mục module/chức năng** 

14 module. Cột ưu tiên: **P0** = bắt buộc MVP, **P1** = Phase 2, **P2** = sau. 

|**Mã**<br>**Module**<br>**Mục đích**<br>**Phụ thuộc**<br>**Ưu tiên**|
|---|



|M01|Quản trị & cấu<br>hình hệ thống|Tổ chức, người dùng, vai trò, cấu hình,<br>audit|–|P0|
|---|---|---|---|---|
|M02|Xác thực & tài<br>khoản|Đăng nhập OTP theo SĐT, phiên, khôi<br>phục|M01|P0|
|M03|Bất động sản|Tòa, khu, tầng, căn hộ, trạng thái, sơ đồ|M01|P0|
|M04|Cư dân & hộ<br>thuê|Hồ sơ, thành viên, giấy tờ, chuyển phòng|M03|P0|
|M05|Hợp đồng|Tạo, gia hạn, thay đổi, chấm dứt, lịch sử|M03, M04|P0|
|M06|Cọc|Thu, giữ, khấu trừ, hoàn, chuyển cọc|M05|P0|
|M07|Dịch vụ & tiện<br>ích|Danh mục, đăng ký, phê duyệt, hủy, gửi<br>xe|M05|P0 (đăng ký<br>online: P1)|
|M08|Chỉ số & tiêu thụ|Ghi chỉ số điện/nước, kiểm tra bất<br>thường|M03, M07|P0|
|M09|Biểu phí & hóa<br>đơn|Bảng giá, sinh hóa đơn kỳ, phát hành,<br>điều chỉnh|M05, M07,<br>M08|P0|
|M10|Thanh toán &<br>công nợ|Ghi nhận, đối soát, nhắc nợ, hoàn tiền,<br>số dư|M09|P0 (online:<br>P1)|
|M11|Yêu cầu & báo<br>hỏng|Tiếp nhận, phân loại, phân công, SLA,<br>đánh giá|M03, M04|P0|
|M12|Thiết bị & bảo trì|Tài sản, lịch bảo trì định kỳ, work order|M03, M11|P0 cơ bản /<br>P1 đầy đủ|
|M13|Truyền thông|Thông báo, sự kiện, danh bạ, nhóm|M04|P0|
|M14|Báo cáo &<br>dashboard|KPI, biểu đồ, xuất dữ liệu|Tất cả|P0 (nâng<br>cao: P1)|
|M15|AI & tự động hóa|Trích xuất, phân loại, soạn nháp,<br>chatbot, nhắc việc|M01–M14|P0 một<br>phần|



**Chức năng dùng chung (cross-cutting), áp dụng cho mọi module danh sách:** tìm kiếm, bộ lọc, sắp xếp, phân trang server-side, chọn nhiều dòng, xuất CSV/Excel, lịch sử thao tác, ghi chú nội bộ, đính kèm tệp. 

## **10. Đặc tả chức năng chi tiết** 

Trình bày hai lớp: **10.1** bảng danh mục toàn bộ FR (quét nhanh, dùng cho ước lượng và traceability) và **10.2** đặc tả sâu đầy đủ 13 trường cho các chức năng rủi ro cao. Bảng 13 cột cho toàn bộ FR sẽ không đọc được trên màn hình nên tôi tách như vậy; nếu bạn cần đúng một bảng duy nhất, tôi có thể đổi sang tab bảng riêng. 

### **10.1 Danh mục yêu cầu chức năng** 

|**ID**|**Module**|**Chức năng**|**Actor**<br>**chính**|**Mô tả ngắn**|**Trạng thái**<br>**liên quan**|**Ưu**<br>**tiên**|
|---|---|---|---|---|---|---|
|FR-001|M02|Đăng nhập OTP<br>qua SĐT|Tất cả|Nhập SĐT →<br>nhận OTP → tạo<br>phiên|–|P0|
|FR-002|M02|Giới hạn tần<br>suất & chống<br>brute-force OTP|Hệ thống|Khóa tạm sau N<br>lần sai, giới hạn<br>gửi lại|–|P0|
|FR-003|M02|Đăng nhập<br>email/mật khẩu<br>cho nhân sự nội<br>bộ|Admin/Nhâ<br>n viên|Kênh dự phòng +<br>2FA tùy chọn|–|P0|
|FR-004|M01|Quản lý người<br>dùng & gán vai<br>trò theo tòa|SYS_ADMI<br>N|CRUD user, gán<br>role scope<br>building|ACTIVE/SU<br>SPENDED|P0|
|FR-005|M01|Cấu hình hệ<br>thống & tham<br>số nghiệp vụ|SYS_ADMI<br>N|Ngày chốt kỳ, hạn<br>thanh toán, SLA,<br>làm tròn|–|P0|
|FR-006|M01|Audit log không<br>sửa được|Tất cả (ghi)|Ai, làm gì, khi nào,<br>giá trị trước/sau|–|P0|



|FR-007|M03|Khởi tạo tòa<br>nhà, khu, tầng|MANAGER|Cây cấu trúc, mã<br>định danh duy<br>nhất|ACTIVE/INA<br>CTIVE|P0|
|---|---|---|---|---|---|---|
|FR-008|M03|Quản lý căn hộ<br>& thuộc tính|MANAGER|Diện tích, loại,<br>phòng ngủ, giá<br>niêm yết, tiện ích|Xem 10.2|P0|
|FR-009|M03|Tạo căn hộ<br>hàng loạt theo<br>mẫu tầng|MANAGER|Sinh 1..n căn theo<br>quy tắc đặt mã|–|P1|
|FR-010|M03|Sơ đồ trạng thái<br>căn hộ theo<br>tầng|MANAGER,<br>OWNER|Lưới màu theo<br>trạng thái, click<br>mở chi tiết|–|P0|
|FR-011|M04|Hồ sơ cư dân &<br>thành viên hộ|MANAGER|Thông tin cá<br>nhân, giấy tờ,<br>quan hệ|Xem 10.2|P0|
|FR-012|M04|Đăng ký cư dân<br>từ cổng|RESIDENT|Cư dân tự khai,<br>BQL duyệt|PENDING/A<br>PPROVED/<br>REJECTED|P0|
|FR-013|M04|Chuyển phòng|MANAGER|Kết thúc HĐ cũ,<br>tạo HĐ mới,<br>chuyển cọc|–|P1|
|FR-014|M05|Tạo hợp đồng<br>thuê|MANAGER|Bên thuê, căn hộ,<br>kỳ hạn, giá, dịch<br>vụ kèm|Xem 10.2|P0|
|FR-015|M05|Gia hạn hợp<br>đồng|MANAGER<br>+ duyệt|Tạo bản gia hạn<br>nối tiếp, giữ lịch<br>sử|RENEWAL_<br>PENDING|P0|
|FR-016|M05|Thay đổi điều<br>khoản (phụ lục)|MANAGER<br>+ duyệt|Ghi nhận<br>amendment,|AMENDED|P0|



|||||không sửa bản<br>gốc|||
|---|---|---|---|---|---|---|
|FR-017|M05|Chấm dứt/hủy<br>hợp đồng|MANAGER<br>+ duyệt|Theo yêu cầu 2<br>bên hoặc vi phạm|Xem 10.2|P0|
|FR-018|M05|Cảnh báo hợp<br>đồng sắp hết<br>hạn|Hệ thống|Nhắc 60/30/15<br>ngày cho<br>MANAGER + cư<br>dân|–|P0|
|FR-019|M05|Đề nghị gia<br>hạn/chấm dứt<br>từ cư dân|RESIDENT|Gửi đề nghị, theo<br>dõi trạng thái<br>duyệt|SUBMITTE<br>D/APPROV<br>ED/REJECT<br>ED|P0|
|FR-020|M05|Tải & lưu trữ<br>bản hợp đồng<br>(PDF/ảnh)|MANAGER|Đính kèm bản ký,<br>phiên bản hóa|–|P0|
|FR-021|M04|Phát hiện & hợp<br>nhất bản ghi<br>trùng|MANAGER|Trùng SĐT/CCCD<br>→ cảnh báo,<br>merge có audit|–|P0|
|FR-022|M06|Thu cọc và sổ<br>cọc theo hợp<br>đồng|ACCOUNT<br>ANT|Ghi nhận số tiền,<br>ngày, phương<br>thức, chứng từ|HELD|P0|
|FR-023|M06|Khấu trừ cọc|MANAGER<br>+ duyệt|Bảng khấu trừ<br>từng khoản kèm<br>bằng chứng|PARTIALLY<br>_DEDUCTE<br>D|P0|
|FR-024|M06|Hoàn cọc (toàn<br>phần/một phần)|ACCOUNT<br>ANT + A|Tính số hoàn,<br>duyệt, ghi nhận<br>chi|Xem 10.2|P0|



|FR-025|M06|Chuyển cọc<br>sang hợp đồng<br>mới|MANAGER<br>+ A|Dùng khi chuyển<br>phòng/gia hạn|TRANSFER<br>RED|P1|
|---|---|---|---|---|---|---|
|FR-026|M07|Danh mục dịch<br>vụ & đơn giá|ACCOUNT<br>ANT|Dịch vụ chung,<br>điện, nước,<br>internet, gửi xe|ACTIVE/AR<br>CHIVED|P0|
|FR-027|M07|Đăng ký dịch vụ|RESIDENT/<br>MANAGER|Chọn dịch vụ, số<br>lượng (vd. số xe),<br>ngày hiệu lực|REQUESTE<br>D→ACTIVE|P0|
|FR-028|M07|Phê duyệt/từ<br>chối đăng ký<br>dịch vụ|MANAGER|Kiểm tra sức chứa<br>(vd. chỗ để xe)|APPROVED<br>/REJECTED|P0|
|FR-029|M07|Thay đổi/hủy<br>dịch vụ & tính<br>pro-rata|MANAGER|Áp dụng quy tắc<br>tính theo ngày|TERMINAT<br>ED|P0|
|FR-030|M08|Ghi chỉ số<br>điện/nước theo<br>kỳ|STAFF|Nhập tay hoặc<br>chụp ảnh đồng hồ<br>(AI đọc)|DRAFT/CO<br>NFIRMED|P0|
|FR-031|M08|Kiểm tra bất<br>thường chỉ số|Hệ thống/AI|Cảnh báo lệch ><br>X% so với trung<br>bình 3 kỳ|FLAGGED|P0|
|FR-032|M09|Quản lý biểu<br>phí & bậc thang|ACCOUNT<br>ANT|Giá cố định, theo<br>đơn vị, bậc thang<br>điện|–|P0|
|FR-033|M09|Sinh hóa đơn<br>kỳ hàng loạt|ACCOUNT<br>ANT|Gom tiền thuê +<br>dịch vụ + điện<br>nước + phí khác|DRAFT|P0|



|FR-034|M09|Rà soát & phát<br>hành hóa đơn|ACCOUNT<br>ANT|Kiểm tra, phát<br>hành, gửi cư dân|ISSUED|P0|
|---|---|---|---|---|---|---|
|FR-035|M09|Điều chỉnh/hủy<br>hóa đơn|ACCOUNT<br>ANT + A|Ghi lý do, tạo bản<br>điều chỉnh, không<br>xóa cứng|ADJUSTED/<br>VOID|P0|
|FR-036|M10|Ghi nhận thanh<br>toán thủ công|ACCOUNT<br>ANT|Tiền mặt/chuyển<br>khoản + chứng từ|PAID/PARTI<br>ALLY_PAID|P0|
|FR-037|M10|Cư dân báo đã<br>thanh toán|RESIDENT|Tải ảnh chứng từ,<br>chờ xác nhận|PENDING_<br>CONFIRM|P0|
|FR-038|M10|Theo dõi công<br>nợ & tuổi nợ|ACCOUNT<br>ANT,<br>OWNER|Bảng aging<br>0–15/16–30/31–6<br>0/>60 ngày|–|P0|
|FR-039|M10|Nhắc nợ tự<br>động nhiều mốc|Hệ thống|Trước hạn 3 ngày,<br>đúng hạn, sau<br>hạn 3/7/15|–|P0|
|FR-040|M10|Xử lý thanh<br>toán thừa/số dư|ACCOUNT<br>ANT|Ghi credit, bù trừ<br>kỳ sau hoặc hoàn|–|P0|
|FR-041|M10|Thanh toán<br>online + đối<br>soát tự động|RESIDENT|VietQR/cổng<br>thanh toán,<br>webhook đối soát|–|P1|
|FR-042|M11|Tạo yêu cầu<br>báo hỏng/khiếu<br>nại|RESIDENT|Mô tả, ảnh, vị trí,<br>mức khẩn|NEW|P0|



|FR-043|M11|Phân loại &<br>định tuyến (AI<br>hỗ trợ)|Hệ thống +<br>MANAGER|Gợi ý nhóm, ưu<br>tiên, người xử lý|TRIAGED|P0|
|---|---|---|---|---|---|---|
|FR-044|M11|Phân công &<br>theo dõi SLA|MANAGER|Gán STAFF, hạn<br>xử lý, cảnh báo<br>trễ|ASSIGNED/<br>IN_PROGR<br>ESS|P0|
|FR-045|M11|Cập nhật tiến<br>độ & hoàn tất<br>tại hiện trường|STAFF|Ghi công việc, vật<br>tư, ảnh trước/sau|RESOLVED|P0|
|FR-046|M11|Phát sinh chi<br>phí & quy trách<br>nhiệm chi phí|MANAGER<br>+ A|Xác định bên chịu<br>(cư dân/chủ nhà),<br>đẩy vào hóa đơn|–|P0|
|FR-047|M11|Đánh giá &<br>đóng yêu cầu|RESIDENT|Chấm sao + nhận<br>xét, hoặc mở lại|CLOSED/R<br>EOPENED|P0|
|FR-048|M11|Gộp yêu cầu<br>trùng lặp|MANAGER|Liên kết vào yêu<br>cầu gốc|MERGED|P1|
|FR-049|M12|Danh mục thiết<br>bị & tài sản|MANAGER|Thiết bị chung và<br>thiết bị trong căn<br>hộ|IN_USE/BR<br>OKEN/RETI<br>RED|P0|
|FR-050|M12|Lịch bảo trì định<br>kỳ & sinh việc<br>tự động|Hệ thống|Theo chu kỳ, sinh<br>work order trước<br>N ngày|SCHEDULE<br>D|P0|
|FR-051|M12|Lịch sử bảo trì<br>theo thiết bị/căn<br>hộ|Tất cả|Tra cứu theo thiết<br>bị hoặc căn hộ|–|P0|



|FR-052|M12|Lịch công việc<br>nhân viên|MANAGER,<br>STAFF|Xem theo<br>ngày/tuần, tránh<br>trùng lịch|–|P1|
|---|---|---|---|---|---|---|
|FR-053|M13|Soạn & gửi<br>thông báo theo<br>nhóm đối tượng|MANAGER|Toàn<br>tòa/tầng/căn/nhó<br>m; lên lịch gửi|DRAFT/SC<br>HEDULED/<br>SENT|P0|
|FR-054|M13|Quản lý sự kiện<br>& lịch chung|MANAGER|Lịch bảo trì, thu<br>phí, sự kiện cư<br>dân|–|P0|
|FR-055|M13|Danh bạ &<br>nhóm liên hệ|MANAGER|BQL, kỹ thuật,<br>khẩn cấp, nhóm<br>cư dân|–|P0|
|FR-056|M13|Xác nhận đã<br>đọc thông báo<br>quan trọng|RESIDENT|Thống kê tỷ lệ đã<br>đọc|–|P1|
|FR-057|M14|Dashboard theo<br>vai trò|Tất cả|KPI + biểu đồ<br>Chart.js theo<br>quyền|–|P0|
|FR-058|M14|Báo cáo & xuất<br>dữ liệu|OWNER,<br>ACCOUNT<br>ANT|Lọc theo kỳ/tòa,<br>xuất CSV/Excel|–|P0|
|FR-059|M15|Trích xuất dữ<br>liệu bằng AI|MANAGER,<br>STAFF|Ảnh/PDF →<br>trường dữ liệu,<br>người xác nhận|–|P0|
|FR-060|M15|Soạn nháp nội<br>dung bằng AI|MANAGER|Thông báo, phản<br>hồi, mô tả công<br>việc|–|P0|
|FR-061|M15|AI Chatbot hỗ<br>trợ cư dân|RESIDENT|Hỏi đáp trong<br>phạm vi quyền<br>của người hỏi|–|P1|



|FR-062|M15|Phát hiện dữ<br>liệu thiếu/mâu<br>thuẫn|Hệ thống|Bảng cảnh báo<br>chất lượng dữ liệu|–|P1|
|---|---|---|---|---|---|---|
|FR-063|M15|Tổng hợp báo<br>cáo vận hành<br>bằng AI|OWNER,<br>MANAGER|Bản tóm tắt có<br>trích dẫn số liệu<br>nguồn|–|P1|



### **10.2 Đặc tả sâu các chức năng rủi ro cao** 

#### **FR-008 — Quản lý căn hộ** 

|**Trường**|**Nội dung**|
|---|---|
|Mục tiêu|Duy trì nguồn sự thật duy nhất về từng căn hộ và trạng thái khai thác|
|Actor|MANAGER (chính), OWNER/ACCOUNTANT/STAFF (đọc)|
|Điều kiện<br>trước|Tòa nhà và tầng đã được khởi tạo; người dùng có quyền trên tòa đó|
|Luồng<br>chính|1) Chọn tòa → tầng. 2) Tạo căn hộ với mã, diện tích, loại, số phòng, giá niêm<br>yết, tiện ích, thiết bị đi kèm. 3) Lưu → trạng tháiAVAILABLE. 4) Khi hợp đồng<br>có hiệu lực, hệ thống tự chuyểnOCCUPIED.|
|Luồng<br>ngoại lệ|Mã căn trùng trong cùng tòa → chặn, gợi ý mã kế tiếp. Xóa căn đang có hợp<br>đồng hiệu lực → chặn, chỉ choINACTIVE. Sửa diện tích khi đang có hợp<br>đồng → cảnh báo ảnh hưởng cách tính phí, ghi audit|
|Dữ liệu<br>vào|building_id, floor_id, code, area_m2, type, bedrooms, base_rent, amenities[],<br>note|
|Dữ liệu ra|Bản ghi căn hộ, sự kiện audit, cập nhật sơ đồ tầng|
|Trạng thái|AVAILABLE·RESERVED·OCCUPIED·MAINTENANCE·INACTIVE|
|Phân<br>quyền|MANAGER: CRU trong tòa được gán; SYS_ADMIN: CRUD; khác: R|
|Thông báo|Không gửi cư dân; ghi audit + hiển thị toast xác nhận|



|Tiêu chí<br>nghiệm|AC-008.1 đến AC-008.3 (mục 11)|
|---|---|
|thu||
|Chỉ số đo|Tỷ lệ căn hộ có đủ trường bắt buộc = 100%|
|Ưu tiên|P0|



#### **FR-014 — Tạo hợp đồng thuê** 

|**Trường**|**Nội dung**|
|---|---|
|Mục tiêu|Ràng buộc chính xác cư dân–căn hộ–giá–kỳ hạn–dịch vụ, làm gốc cho mọi tính<br>phí|
|Actor|MANAGER tạo; OWNER hoặc FIN_APPROVER duyệt nếu giá lệch khung|
|Điều kiện<br>trước|Căn hộ ởAVAILABLE/RESERVED; cư dân đại diện đã có hồ sơAPPROVED|
|Luồng chính|1) Chọn căn hộ → kiểm tra không trùng kỳ hạn. 2) Chọn/khai bên thuê + thành<br>viên. 3) Nhập ngày bắt đầu/kết thúc, tiền thuê, chu kỳ thanh toán, ngày chốt kỳ,<br>tiền cọc. 4) Chọn dịch vụ đi kèm và đơn giá áp dụng. 5) Xem bản xem trước →<br>lưuDRAFT. 6) Tải bản ký →ACTIVE, căn hộ →OCCUPIED, sinh lịch hóa đơn|
|Luồng ngoại<br>lệ|Chồng lấn kỳ hạn với hợp đồng khác trên cùng căn → chặn kèm chỉ rõ hợp đồng<br>xung đột. Ngày kết thúc ≤ ngày bắt đầu → chặn. Giá thấp hơn X% so với giá<br>niêm yết → yêu cầu phê duyệt. Thiếu giấy tờ tùy thân → cho lưuDRAFTnhưng<br>chặnACTIVE|
|Dữ liệu vào|apartment_id, primary_tenant_id, occupants[], start_date, end_date, rent_amount,<br>billing_cycle, deposit_amount, services[], attachments[]|
|Dữ liệu ra|contract + contract_version, lịch hóa đơn dự kiến, bản ghi cọcPENDING, thông<br>báo cho cư dân|
|Trạng thái|DRAFT·PENDING_APPROVAL·ACTIVE·RENEWAL_PENDING·EXPIRED·<br>TERMINATED·CANCELLED|
|Phân quyền|MANAGER C/R/U khiDRAFT; sauACTIVEchỉ sửa qua phụ lục; ACCOUNTANT<br>R|
|Thông báo|Cư dân: hợp đồng đã kích hoạt + hướng dẫn đăng nhập. Kế toán: có lịch thu mới|



|Tiêu chí<br>nghiệm thu|AC-014.1 đến AC-014.4|
|---|---|
|Chỉ số đo|Thời gian trung bình tạo 1 hợp đồng < 5 phút|
|Ưu tiên|P0|



#### **FR-024 — Hoàn cọc (toàn phần hoặc một phần)** 

|**Trường**|**Nội dung**|
|---|---|
|Mục tiêu|Kết thúc quan hệ thuê minh bạch, có chứng từ, không tranh chấp|
|Actor|ACCOUNTANT lập; OWNER/FIN_APPROVER duyệt|
|Điều kiện<br>trước|Hợp đồng ởTERMINATED/EXPIRED; đã chốt chỉ số cuối và phát hành hóa đơn<br>cuối kỳ; đã có biên bản kiểm tra căn hộ|
|Luồng chính|1) Mở hồ sơ tất toán. 2) Hệ thống hiển thị: tổng cọc đang giữ, công nợ còn lại,<br>các khoản khấu trừ đề xuất. 3) Kế toán thêm/sửa từng khoản khấu trừ kèm bằng<br>chứng. 4) Hệ thống tính số hoàn = cọc − công nợ − khấu trừ. 5) Gửi duyệt. 6)<br>Người duyệt chấp thuận → ghi nhận chi, cập nhật cọc<br>REFUNDED/PARTIALLY_REFUNDED, gửi cư dân bảng kê|
|Luồng ngoại<br>lệ|Khấu trừ > cọc → số hoàn = 0 và phần thiếu thành công nợ<br>RECEIVABLE_AFTER_MOVE_OUT. Cư dân không đồng ý → trạng tháiDISPUTED,<br>mở thread khiếu nại, khóa thao tác chi cho đến khi giải quyết. Người duyệt từ<br>chối → trả về kèm lý do bắt buộc. Sai tài khoản nhận tiền → cho phépRETURNED<br>và lập lại lệnh chi|
|Dữ liệu vào|contract_id, deduction_items[{loại, số tiền, mô tả, chứng từ}], refund_method,<br>bank_info|
|Dữ liệu ra|deposit_transaction, bảng kê tất toán PDF, bút toán chi, thông báo|
|Trạng thái|HELD→SETTLEMENT_DRAFT→PENDING_APPROVAL→<br>REFUNDED/PARTIALLY_REFUNDED/DISPUTED|
|Phân quyền|Người lập ≠ người duyệt (bắt buộc, có thể tắt bằng cấu hình có audit)|



|Thông báo|Cư dân nhận bảng kê ngay khi duyệt; OWNER nhận báo cáo tổng hợp hoàn cọc<br>theo tháng|
|---|---|
|Tiêu chí<br>nghiệm thu|AC-024.1 đến AC-024.5|
|Chỉ số đo|Thời gian trung bình từ trả phòng đến hoàn cọc; số vụDISPUTED/tổng|
|Ưu tiên|P0|



#### **FR-033 & FR-034 — Sinh và phát hành hóa đơn kỳ** 

|**Trường**|**Nội dung**|
|---|---|
|Mục tiêu|Tạo hóa đơn đúng cho toàn bộ căn đang thuê trong một thao tác, có bước rà<br>soát người thật|
|Actor|ACCOUNTANT; hệ thống chạy job chuẩn bị|
|Điều kiện<br>trước|Đã cấu hình kỳ tính phí; chỉ số điện/nước của kỳ ở trạng tháiCONFIRMED;<br>biểu phí hiệu lực|
|Luồng<br>chính|1) Chọn kỳ + tòa. 2) Hệ thống liệt kê hợp đồngACTIVE, tính: tiền thuê<br>(pro-rata nếu vào/ra giữa kỳ) + dịch vụ cố định + điện nước theo bậc + phí<br>phát sinh + trừ credit. 3) Sinh hóa đơnDRAFTkèm bảng đối chiếu số lượng.<br>4) Kế toán rà soát, sửa dòng phí nếu cần. 5) Phát hành →ISSUED, khóa<br>chỉnh sửa trực tiếp, gửi cư dân|
|Luồng<br>ngoại lệ|Thiếu chỉ số của một số căn → loại khỏi đợt sinh và liệt kê rõ. Chỉ số kỳ này <<br>kỳ trước → chặn, yêu cầu xác nhận (thay đồng hồ/đảo số). Đã tồn tại hóa<br>đơn cùng kỳ cùng hợp đồng → chặn trùng. Hợp đồng chấm dứt giữa kỳ →<br>tính đến ngày trả phòng. Phát hành khi đang có job chạy → khóa idempotent<br>theo (contract_id, period)|
|Dữ liệu vào|period, building_id, danh sách hợp đồng, chỉ số, biểu phí, phí phát sinh|
|Dữ liệu ra|invoice + invoice_line[], PDF, thông báo, cập nhật công nợ|
|Trạng thái|DRAFT·ISSUED·PARTIALLY_PAID·PAID·OVERDUE·ADJUSTED·VOID|



|Phân<br>quyền|ACCOUNTANT C/U trênDRAFT, phát hành; điều chỉnh sau phát hành cần A;<br>OWNER/MANAGER R|
|---|---|
|Thông báo|Cư dân: hóa đơn kỳ + hạn thanh toán; nhắc theo FR-039|
|Tiêu chí<br>nghiệm thu|AC-033.1 đến AC-034.4|
|Chỉ số đo|% hóa đơn phải điều chỉnh sau phát hành < 2%|
|Ưu tiên|P0|



#### **FR-042 → FR-047 — Vòng đời yêu cầu báo hỏng** 

|**Trường**|**Nội dung**|
|---|---|
|Mục tiêu|Không sót yêu cầu, có SLA đo được, có bằng chứng xử lý|
|Actor|RESIDENT tạo; MANAGER điều phối; STAFF xử lý|
|Điều kiện<br>trước|Cư dân có hợp đồngACTIVE(hoặc trong thời gian bảo hành sau trả phòng theo<br>cấu hình)|
|Luồng<br>chính|1) Cư dân chọn hạng mục, mô tả, ảnh, khung giờ thuận tiện. 2) AI gợi ý nhóm sự<br>cố + mức ưu tiên + đội phụ trách (kèm độ tin cậy). 3) MANAGER xác nhận/ghi đè,<br>phân công, đặt hạn theo SLA. 4) STAFF nhận trên mobile, cập nhật tiến độ, ghi vật<br>tư, ảnh trước/sau. 5) Nếu phát sinh chi phí → lập đề xuất, MANAGER duyệt, xác<br>định bên chịu chi phí. 6) Đóng yêu cầu → cư dân đánh giá|
|Luồng<br>ngoại lệ|Trùng lặp (cùng căn, cùng hạng mục, < 24h) → gợi ý gộp. Cư dân không có mặt →<br>ON_HOLDkèm lý do, hẹn lại. Vượt SLA → cảnh báo leo thang cho MANAGER và<br>OWNER. Cư dân mở lại trong N ngày →REOPENED, không tính là yêu cầu mới<br>trong KPI. Sự cố khẩn cấp (rò điện, cháy, ngập) → bỏ qua hàng đợi, thông báo<br>ngay đa kênh|
|Dữ liệu<br>vào|apartment_id, category, description, images[], preferred_slot, severity_hint|
|Dữ liệu ra|request, work_order, cost_item (nếu có), đánh giá, sự kiện SLA|



|Trạng thái|NEW·TRIAGED·ASSIGNED·IN_PROGRESS·ON_HOLD·RESOLVED·CLOSED·<br>REOPENED·CANCELLED·MERGED|
|---|---|
|Phân<br>quyền|RESIDENT chỉ yêu cầu của mình; STAFF chỉ work order được giao; MANAGER<br>toàn tòa|
|Thông báo|Mỗi lần đổi trạng thái → cư dân; phân công → STAFF; quá hạn → MANAGER|
|Tiêu chí<br>nghiệm thu|AC-042.1 đến AC-047.3|
|Chỉ số đo|Thời gian phản hồi đầu tiên; % đúng SLA; điểm đánh giá trung bình; tỷ lệ<br>REOPENED|
|Ưu tiên|P0|



### **10.3 Yêu cầu bổ sung theo phản hồi chủ đầu tư** 

|**ID**|**Module**|**Chức**<br>**năng**|**Actor**|**Mô tả & quy tắc đã chốt**|**Ưu tiên**|
|---|---|---|---|---|---|
|FR-<br>064|M10|Phí<br>phạt<br>chậm<br>thanh<br>toán|Hệ thống +<br>ACCOUNTANT|Sau**5 ngày**kể từ hạn thanh toán<br>cuối, phạt**100.000 ₫/ngày chậm**. Hệ<br>thống tính và đưa vào hóa đơn kỳ kế<br>tiếp dưới dạng dòng phí riêng; kế<br>toán có quyền miễn/giảm kèm lý do<br>và cần APPROVER duyệt|P0|
|FR-<br>065|M07,<br>M09|Bảng<br>giá dịch<br>vụ theo<br>từng<br>hợp<br>đồng|ACCOUNTANT,<br>MANAGER|Mỗi hợp đồng có thể ghi đè đơn giá<br>internet, gửi xe xăng, gửi xe điện,<br>rác, dịch vụ chung. Thứ tự ưu tiên khi<br>tính hóa đơn:**giá hợp đồng → giá**<br>**tòa → giá mặc định**; giá đã áp cho<br>kỳ đã phát hành không bị ảnh hưởng<br>khi sửa giá sau|P0|
|FR-<br>066|M09|Ngày<br>chốt kỳ<br>theo<br>từng<br>hợp<br>đồng|Hệ thống|billing_daynằm ở hợp đồng,<br>không ở tòa. Job sinh hóa đơn chạy<br>**hằng ngày**, chọn hợp đồng đến kỳ<br>hôm đó; kế toán vẫn có thể sinh thủ<br>công theo lô|P0|



|FR-<br>067|M06|Đặt cọc<br>giữ chỗ<br>cho<br>khách<br>chưa<br>thuê|PROSPECT,<br>MANAGER|Khách để lại tên, SĐT, căn quan tâm,<br>số tiền giữ chỗ và hạn giữ chỗ. Căn<br>hộ chuyểnRESERVED. Khi ký hợp<br>đồng → cọc giữ chỗ**chuyển thành**<br>**cọc hợp đồng**; khách hủy hoặc quá<br>hạn → áp chính sách mất cọc/hoàn<br>cọc theo cấu hình, có phê duyệt|P0|
|---|---|---|---|---|---|
|FR-<br>068|M06|Hoàn<br>cọc<br>trong<br>3–5<br>ngày<br>sau<br>chấm<br>dứt|ACCOUNTANT +<br>APPROVER|Hệ thống đặt hạn hoàn cọc = ngày<br>chấm dứt + 3 ngày (cảnh báo), + 5<br>ngày (quá hạn, báo lên Giám đốc).<br>**Cọc không được cấn trừ vào tiền**<br>**thuê**; chỉ khấu trừ chi phí hư hỏng/vệ<br>sinh/chi phí khác có chứng từ|P0|
|FR-<br>069|M13|Xuất<br>nội<br>dung<br>thông<br>báo<br>sang<br>nhóm<br>Zalo|MANAGER|Mỗi thông báo có nút sao chép nội<br>dung đã định dạng cho nhóm tòa<br>hoặc nhóm phòng, kèm danh sách<br>nhóm để dán đúng chỗ; hệ thống ghi<br>nhận đã gửi thủ công|P0|
|FR-<br>070|M01|Quản lý<br>nhiều<br>tòa của<br>nhiều<br>chủ sở<br>hữu|SYS_ADMIN,<br>OWNER|Một tổ chức vận hành nhiều tòa thuê<br>lại; mỗi tòa gắn chủ sở hữu và điều<br>khoản thuê lại riêng; báo cáo tách<br>theo tòa và gộp toàn hệ thống|P0 (nền<br>tảng) / P1<br>(báo cáo<br>theo chủ<br>sở hữu)|
|FR-<br>071|M03|Quản lý<br>tin<br>đăng<br>cho<br>thuê<br>căn<br>trống|MANAGER/nhân<br>sự quảng cáo|Đánh dấu căn sẵn sàng cho thuê, nội<br>dung + ảnh đăng quảng cáo, nguồn<br>khách, gắn khách tiềm năng với căn|P1 (đề<br>xuất — do<br>có nhân<br>sự phụ<br>trách<br>quảng<br>cáo)|



|FR-<br>072|M10|Công<br>nợ phải<br>trả nhà<br>cung<br>cấp|ACCOUNTANT|Theo dõi hợp đồng/đơn hàng với nhà<br>cung cấp và lịch thanh toán tương<br>ứng|**P1 —**<br>**phạm vi**<br>**mới, cần**<br>**xác**<br>**nhận**trướ<br>c khi đặc<br>tả|
|---|---|---|---|---|---|
|FR-<br>073|M09|Sẵn<br>sàng<br>cho<br>hóa<br>đơn<br>điện tử|ACCOUNTANT|Giữ đủ trường bắt buộc (thông tin<br>người mua, mã số thuế nếu có, dòng<br>hàng, thuế suất) và API xuất dữ liệu,<br>chưa tích hợp nhà cung cấp|P1|



#### **Quy tắc tính tiền đã chốt, áp dụng xuyên suốt:** 

|**Quy**<br>**tắc**|**Giá trị chốt**|**Ghi chú cần lưu ý**|
|---|---|---|
|Điện,<br>nước|Đơn giá**cố định**, nhân theo chỉ số đồng hồ<br>riêng từng phòng (không bậc thang)|Đơn giá lưu theo hiệu lực thời gian<br>để tái tính đúng kỳ cũ|
|Dịch vụ<br>chung|Tính**theo người hoặc theo phòng**|Cần chốt rõ áp dụng cách nào cho<br>từng tòa (mục 23)|
|Pro-rat<br>a|Chia theo**số ngày lưu trú thực tế**|Mẫu số là số ngày thực tế của tháng<br>hay 30 ngày cố định — cần chốt|
|Làm<br>tròn|Làm tròn đến**hàng nghìn**(ROUND(x,<br>-3))|Cần chốt chiều làm tròn: gần nhất,<br>lên hay xuống|
|Tiền<br>cọc|**1 tháng tiền thuê**, không cấn trừ vào tiền<br>thuê|–|
|Phạt<br>chậm|100.000 ₫/ngày, sau 5 ngày quá hạn|Cần chốt trần tối đa và cách xử lý khi<br>khách trả một phần|



## **11. User stories và acceptance criteria** 

20 story đại diện cho các luồng quan trọng nhất; các FR còn lại dùng mẫu tương tự khi vào sprint backlog. 

|**ID**|**User story**|**FR liên**<br>**quan**|**Ưu**<br>**tiên**|
|---|---|---|---|
|US-<br>001|Là**cư dân**, tôi muốn đăng nhập bằng số điện thoại và mã OTP, để<br>không phải nhớ mật khẩu|FR-001,<br>FR-002|P0|
|US-<br>002|Là**cư dân**, tôi muốn xem hiện trạng căn hộ và hợp đồng của mình,<br>để biết mình đang thuê theo điều kiện nào|FR-008,<br>FR-014|P0|
|US-<br>003|Là**cư dân**, tôi muốn xem hóa đơn từng kỳ kèm chi tiết điện nước, để<br>hiểu mình trả tiền cho những gì|FR-033,<br>FR-034|P0|
|US-<br>004|Là**cư dân**, tôi muốn báo hỏng kèm ảnh và theo dõi tiến độ, để không<br>phải gọi điện nhiều lần|FR-042,<br>FR-045|P0|
|US-<br>005|Là**cư dân**, tôi muốn đăng ký dịch vụ gửi xe/internet trực tuyến, để<br>không phải xuống văn phòng|FR-027,<br>FR-028|P0|
|US-<br>006|Là**cư dân**, tôi muốn gửi đề nghị gia hạn hoặc chấm dứt hợp đồng, để<br>có bằng chứng đã thông báo đúng hạn|FR-019|P0|
|US-<br>007|Là**cư dân**, tôi muốn nhận thông báo của BQL trong ứng dụng, để<br>không bỏ lỡ lịch cắt nước hay thu phí|FR-053|P0|
|US-<br>008|Là**quản lý tòa nhà**, tôi muốn khởi tạo cấu trúc tòa/tầng/căn hộ<br>nhanh, để bắt đầu vận hành trong ngày|FR-007,<br>FR-009|P0|
|US-<br>009|Là**quản lý tòa nhà**, tôi muốn tạo hợp đồng và hệ thống tự chặn trùng<br>kỳ hạn, để tránh cho thuê chồng|FR-014|P0|
|US-<br>010|Là**quản lý tòa nhà**, tôi muốn được nhắc hợp đồng sắp hết hạn, để<br>chủ động gia hạn hoặc tìm khách mới|FR-018|P0|
|US-<br>011|Là**quản lý tòa nhà**, tôi muốn xem yêu cầu báo hỏng đã được AI<br>phân loại sẵn, để phân công nhanh hơn|FR-043,<br>FR-044|P0|
|US-<br>012|Là**quản lý tòa nhà**, tôi muốn soạn thông báo từ bản nháp AI và gửi<br>theo nhóm, để tiết kiệm thời gian|FR-053,<br>FR-060|P0|
|US-<br>013|Là**nhân viên kỹ thuật**, tôi muốn xem việc được giao trên điện thoại<br>và cập nhật kết quả tại chỗ, để không phải ghi giấy|FR-045,<br>FR-052|P0|
|US-<br>014|Là**nhân viên kỹ thuật**, tôi muốn chụp ảnh đồng hồ để hệ thống đọc<br>chỉ số, để nhập liệu nhanh và ít sai|FR-030,<br>FR-059|P0|
|US-|Là**kế toán**, tôi muốn sinh hóa đơn cả tòa cho một kỳ trong một thao|FR-033|P0|
|015|tác, để không nhập tay 50 lần|||



|US-<br>016|Là**kế toán**, tôi muốn thấy danh sách công nợ theo tuổi nợ, để biết<br>nhắc ai trước|FR-038|P0|
|---|---|---|---|
|US-<br>017|Là**kế toán**, tôi muốn lập bảng tất toán cọc có khấu trừ và gửi duyệt,<br>để hoàn cọc minh bạch|FR-023,<br>FR-024|P0|
|US-<br>018|Là**chủ đầu tư**, tôi muốn xem doanh thu, lấp đầy và công nợ theo<br>tháng, để ra quyết định mà không phải hỏi ai|FR-057,<br>FR-058|P0|
|US-<br>019|Là**quản trị hệ thống**, tôi muốn phân quyền theo vai trò và theo tòa,<br>để nhân sự chỉ thấy phần việc của họ|FR-004|P0|
|US-<br>020|Là**chủ đầu tư**, tôi muốn mọi thao tác tiền bạc đều có nhật ký ai làm<br>gì, để truy vết khi có sai lệch|FR-006|P0|



### **Acceptance criteria (Given / When / Then)** 

|**ID**|**Story**|**Given**|**When**|**Then**|
|---|---|---|---|---|
|AC-0<br>01.1|US-0<br>01|SĐT đã gắn với một<br>cư dân đang thuê|Nhập SĐT và<br>bấm gửi mã|Hệ thống gửi OTP 6 số, hiệu lực 5<br>phút, hiển thị đồng hồ đếm ngược|
|AC-0<br>01.2|US-0<br>01|Đã nhận OTP|Nhập sai 5 lần<br>liên tiếp|Khóa đăng nhập SĐT đó 15 phút và<br>ghi audit; thông báo trung lập không<br>tiết lộ SĐT có tồn tại hay không|
|AC-0<br>01.3|US-0<br>01|SĐT không tồn tại<br>trong hệ thống|Bấm gửi mã|Hiển thị cùng thông điệp như trường<br>hợp hợp lệ (chống dò số), không gửi<br>OTP|
|AC-0<br>02.1|US-0<br>02|Cư dân có 1 hợp đồng<br>ACTIVE|Mở cổng cư<br>dân|Thấy mã căn, diện tích, kỳ hạn, tiền<br>thuê, số tiền phải trả hiện tại|
|AC-0<br>02.2|US-0<br>02|Cư dân từng thuê căn<br>khác trước đây|Mở mục lịch<br>sử thuê|Thấy đủ các hợp đồng cũ với trạng<br>thái và ngày, không sửa được|
|AC-0<br>03.1|US-0<br>03|Hóa đơn kỳ đã<br>ISSUED|Mở chi tiết<br>hóa đơn|Thấy từng dòng phí, chỉ số đầu/cuối<br>điện nước, đơn giá từng bậc, tổng tiền<br>và hạn thanh toán|
|AC-0<br>03.2|US-0<br>03|Hóa đơn ởDRAFT|Cư dân truy<br>cập|Không nhìn thấy hóa đơn đó ở cổng<br>cư dân|
|AC-0<br>04.1|US-0<br>04|Cư dân đang ở trang<br>báo hỏng|Gửi yêu cầu<br>kèm 3 ảnh|Yêu cầu tạo ởNEW, có mã tra cứu, cư<br>dân nhận xác nhận trong 1 phút|



|AC-0<br>04.2|US-0<br>04|Đã có yêu cầu cùng<br>căn, cùng hạng mục<br>trong 24h|Gửi yêu cầu<br>mới|Hệ thống cảnh báo có thể trùng và đề<br>nghị mở yêu cầu cũ trước khi xác<br>nhận tạo mới|
|---|---|---|---|---|
|AC-0<br>06.1|US-0<br>06|Hợp đồng còn hiệu lực<br>> 30 ngày|Gửi đề nghị<br>chấm dứt|Hệ thống ghi nhận, hiển thị thời hạn<br>báo trước theo hợp đồng và chuyển<br>BQL duyệt|
|AC-0<br>09.1|US-0<br>09|Căn hộ đã có hợp<br>đồngACTIVEđến<br>31/12|Tạo hợp đồng<br>mới bắt đầu<br>01/12|Hệ thống chặn lưu và chỉ rõ hợp đồng<br>xung đột|
|AC-0<br>09.2|US-0<br>09|Hợp đồng ởDRAFT,<br>chưa đính kèm bản ký|Bấm kích hoạt|Hệ thống chặn và nêu điều kiện còn<br>thiếu|
|AC-0<br>10.1|US-0<br>10|Hợp đồng kết thúc sau<br>30 ngày|Job nhắc chạy<br>hằng ngày|MANAGER nhận thông báo trong hệ<br>thống và email; cư dân nhận nhắc gia<br>hạn|
|AC-0<br>11.1|US-0<br>11|Có yêu cầu mới với<br>mô tả "vòi nước rỉ"|AI phân loại<br>chạy|Gợi ý nhóm "Cấp thoát nước", ưu tiên<br>trung bình, kèm độ tin cậy; MANAGER<br>có thể ghi đè trong 1 thao tác|
|AC-0<br>11.2|US-0<br>11|Độ tin cậy AI dưới<br>ngưỡng cấu hình|Yêu cầu vào<br>hàng đợi|Không gán nhóm tự động, đánh dấu<br>"cần phân loại thủ công"|
|AC-0<br>14.1|US-0<br>14|Ảnh đồng hồ mờ<br>không đọc được|Tải ảnh lên|AI trả "không chắc chắn", để trống ô<br>chỉ số, nhắc nhân viên nhập tay,<br>không tự điền số phỏng đoán|
|AC-0<br>14.2|US-0<br>14|AI đọc được chỉ số<br>1234|Nhân viên<br>xem kết quả|Ô chỉ số hiển thị 1234 ở trạng thái**chờ**<br>**xác nhận**, chỉ lưu khi người dùng bấm<br>xác nhận|
|AC-0<br>15.1|US-0<br>15|48/50 hợp đồng đã có<br>chỉ sốCONFIRMED|Chạy sinh hóa<br>đơn kỳ|Sinh 48 hóa đơnDRAFTvà liệt kê 2<br>hợp đồng bị loại kèm lý do|
|AC-0<br>15.2|US-0<br>15|Đã sinh hóa đơn kỳ<br>09/2026 cho hợp đồng<br>X|Chạy lại lệnh<br>sinh cùng kỳ|Không tạo bản trùng; báo đã tồn tại và<br>cho phép xem|
|AC-0<br>15.3|US-0<br>15|Cư dân trả phòng<br>ngày 10 của kỳ|Sinh hóa đơn|Tiền thuê tính pro-rata đến ngày 10<br>theo quy tắc làm tròn đã cấu hình,<br>hiển thị công thức trong chi tiết dòng|



|AC-0<br>16.1|US-0<br>16|Có hóa đơn quá hạn<br>20 ngày|Mở bảng công<br>nợ|Hóa đơn nằm ở nhóm tuổi nợ 16–30<br>ngày, tổng khớp với tổng dư nợ toàn<br>tòa|
|---|---|---|---|---|
|AC-0<br>17.1|US-0<br>17|Cọc 10.000.000, công<br>nợ 1.200.000, khấu<br>trừ hỏng hóc 800.000|Lập bảng tất<br>toán|Số hoàn hiển thị 8.000.000; không cho<br>chi khi chưa có phê duyệt|
|AC-0<br>17.2|US-0<br>17|Khấu trừ + công nợ<br>vượt số cọc|Lập bảng tất<br>toán|Số hoàn = 0 và phần chênh lệch được<br>ghi thành công nợ sau trả phòng|
|AC-0<br>17.3|US-0<br>17|Người lập cũng là<br>người có quyền duyệt|Bấm duyệt<br>chính hồ sơ<br>mình lập|Hệ thống chặn (trừ khi cấu hình cho<br>phép, khi đó ghi audit cảnh báo)|
|AC-0<br>19.1|US-0<br>19|Nhân viên chỉ được<br>gán tòa A|Truy cập dữ<br>liệu tòa B qua<br>URL trực tiếp|Nhận 403 và sự kiện audit; không lộ<br>dữ liệu tòa B|
|AC-0<br>20.1|US-0<br>20|Kế toán sửa một dòng<br>hóa đơnDRAFT|Lưu thay đổi|Audit log ghi người, thời điểm, giá trị<br>trước/sau; bản ghi audit không<br>sửa/xóa được bởi bất kỳ vai trò nào|



## **12. Đặc tả AI và tự động hóa** 

### **12.1 Nguyên tắc chung (bắt buộc với mọi tính năng AI)** 

1. **AI đề xuất, người quyết định.** Không tính năng AI nào được tự phát hành hóa đơn, ghi nhận thanh toán, duyệt hoàn cọc, kích hoạt/chấm dứt hợp đồng, thay đổi biểu phí hoặc gửi thông báo ra ngoài mà không có thao tác xác nhận của người có quyền. 

2. **Mọi đầu ra AI đều có trạng thái nháp.** Lưu ở bảng riêng ( ai_suggestion ) với confidence , model , prompt_version , input_ref ; chỉ khi người dùng chấp nhận mới ghi vào bảng nghiệp vụ. 

3. **Không chắc chắn thì nói không chắc chắn.** Dưới ngưỡng tin cậy cấu hình → trả về "cần người xử lý", không đoán giá trị. 

4. **Tối thiểu hóa dữ liệu.** Chỉ gửi trường cần thiết cho tác vụ; ẩn danh/khử nhận dạng khi có thể (che số CCCD, chỉ gửi 4 số cuối SĐT nếu tác vụ không cần đủ). 

5. **Không huấn luyện trên dữ liệu cư dân** trừ khi có thỏa thuận riêng với nhà cung cấp và có sự đồng ý hợp lệ; cần bật tùy chọn không lưu dữ liệu ở phía nhà cung cấp nếu có. _(Cần kiểm tra điều khoản hiện hành của nhà cung cấp mô hình tại thời điểm ký — tôi không thể xác nhận chính sách hiện tại của Google/Gemini.)_ 

6. **Gọi model từ backend** , không bao giờ từ trình duyệt; API key giữ ở server/secret manager. 

7. **Ghi log đầy đủ** mọi lần gọi: ai gọi, tác vụ, thời điểm, token, kết quả được chấp nhận hay bị sửa — phục vụ đo chất lượng và kiểm soát chi phí. 

### **12.2 Bảng tính năng AI** 

|**ID**|**Tính**<br>**năng**|**Mục tiêu**|**Người dùng**|**Đầu vào**|**Đầu ra**|**Phê duyệt**<br>**bắt buộc**|**Phas**<br>**e**|
|---|---|---|---|---|---|---|---|
|AI-<br>01|Trích xuất<br>dữ liệu từ<br>ảnh/PDF|Giảm nhập<br>liệu CCCD,<br>hợp đồng<br>giấy, hóa<br>đơn NCC|MANAGER,<br>STAFF|Ảnh/PDF<br>do người<br>dùng tải|JSON<br>trường dữ<br>liệu +<br>confidence<br>từng<br>trường|Người<br>dùng xác<br>nhận từng<br>trường|MVP|
|AI-<br>02|Đọc chỉ số<br>đồng hồ<br>điện/nước<br>từ ảnh|Ghi chỉ số<br>nhanh, ít sai|STAFF|Ảnh đồng<br>hồ + mã<br>căn hộ|Số chỉ số<br>+<br>confidence|Nhân viên<br>xác nhận;<br>so sánh kỳ<br>trước|MVP|
|AI-<br>03|Phân loại<br>& định<br>tuyến yêu<br>cầu|Rút ngắn<br>thời gian<br>phân công|Hệ thống →<br>MANAGER|Mô tả +<br>ảnh + lịch<br>sử căn<br>hộ|Nhóm sự<br>cố, mức<br>ưu tiên,<br>đội đề<br>xuất, tóm<br>tắt 1 dòng|MANAGER<br>xác nhận<br>trước khi<br>gán|MVP|
|AI-<br>04|Soạn<br>nháp<br>thông<br>báo/biên<br>bản/phản<br>hồi|Tiết kiệm<br>thời gian<br>soạn thảo|MANAGER|Chủ đề,<br>đối<br>tượng,<br>dữ kiện<br>chọn từ<br>hệ thống|Bản nháp<br>văn bản<br>tiếng Việt|Người<br>soạn duyệt<br>và bấm gửi|MVP|
|AI-<br>05|Nhập liệu<br>bằng<br>ngôn ngữ<br>tự nhiên|Tạo nhanh<br>bản ghi từ<br>câu mô tả|MANAGER|Câu tiếng<br>Việt tự do|Form<br>được điền<br>sẵn (chưa<br>lưu)|Người<br>dùng kiểm<br>tra và lưu|MVP<br>(giới<br>hạn<br>2–3<br>loại<br>bản<br>ghi)|



|AI-<br>06|Chatbot<br>hỗ trợ cư<br>dân|Giảm câu<br>hỏi lặp cho<br>BQL|RESIDENT|Câu hỏi +<br>ngữ cảnh<br>dữ liệu<br>**của**<br>**chính**<br>**người**<br>**hỏi**|Câu trả lời<br>+ trích dẫn<br>nguồn<br>trong hệ<br>thống|Không tự<br>thực hiện<br>hành động;<br>chỉ tạo yêu<br>cầu nháp|Phas<br>e 2|
|---|---|---|---|---|---|---|---|
|AI-<br>07|Phát hiện<br>dữ liệu<br>thiếu/mâu<br>thuẫn/bất<br>thường|Nâng chất<br>lượng dữ<br>liệu, chặn<br>sai sót tiền|Hệ thống →<br>MANAGER,<br>ACCOUNTANT|Bản ghi<br>nghiệp vụ<br>theo lô|Danh sách<br>cảnh báo<br>có xếp<br>hạng|Người<br>dùng xử lý<br>từng cảnh<br>báo|Phas<br>e 2<br>(quy<br>tắc<br>cứng<br>làm ở<br>MVP)|
|AI-<br>08|Tổng hợp<br>báo cáo<br>vận hành|Rút ngắn<br>thời gian<br>làm báo cáo<br>tháng|OWNER,<br>MANAGER|Số liệu<br>tổng hợp<br>đã tính<br>sẵn từ<br>DB|Bản tóm<br>tắt có dẫn<br>số|Người xem<br>đối chiếu<br>số gốc|Phas<br>e 2|



### **12.3 Đặc tả chi tiết ba tính năng MVP** 

#### **AI-02 — Đọc chỉ số đồng hồ** 

- **Luồng xử lý:** STAFF chụp ảnh → client nén, gắn apartment_id và meter_id → backend gọi model với prompt yêu cầu **chỉ trả JSON** {"reading": number|null, "confidence": 0..1, "reason": string} → backend kiểm tra hậu nghiệm: số đọc phải ≥ chỉ số kỳ trước và mức tăng ≤ ngưỡng bất thường → hiển thị cho STAFF xác nhận. 

- **Quyền truy cập:** ảnh lưu ở Storage với RLS theo tòa; model chỉ nhận ảnh và mã đồng hồ, không nhận thông tin cư dân. 

- **Tiêu chí đánh giá:** ≥ 90% ảnh rõ nét đọc đúng (đo bằng đối chiếu thủ công trên mẫu 200 ảnh trong 1 tháng đầu). _Con số 90% là mục tiêu đề xuất, chưa được kiểm chứng trên dữ liệu thực tế của dự án._ 

- **Xử lý lỗi:** model lỗi/timeout → chuyển sang nhập tay, không chặn công việc; ảnh mờ → trả null kèm lý do. 

- **Giới hạn:** không đọc được đồng hồ cơ bị mờ kính, đọng nước, chụp nghiêng; không thay thế kiểm tra định kỳ đồng hồ. 

**AI-03 — Phân loại và định tuyến yêu cầu** 

- **Luồng xử lý:** yêu cầu mới → hàng đợi bất đồng bộ → model nhận mô tả, ảnh, hạng mục, lịch sử sự cố của căn → trả nhóm sự cố (từ danh mục đóng do hệ thống cung cấp), mức ưu tiên, đội đề xuất, tóm tắt. 

- **Ràng buộc quan trọng:** model **chỉ được chọn trong danh mục đóng** , không tự đặt nhãn mới; nhãn ngoài danh mục → coi như không phân loại được. 

- **Tiêu chí đánh giá:** ≥ 80% gợi ý được MANAGER giữ nguyên (đo hằng tháng); mức ưu tiên "khẩn cấp" phải có recall cao — thà báo nhầm khẩn cấp còn hơn bỏ sót. 

- **Xử lý lỗi/độ trễ:** nếu AI chưa trả sau 30 giây, yêu cầu vẫn hiển thị ở hàng đợi chưa phân loại; AI cập nhật sau nếu chưa ai xử lý. 

- **Giới hạn:** không suy đoán trách nhiệm chi phí (cư dân hay chủ nhà) — đây là quyết định của con người. 

#### **AI-04 — Soạn nháp thông báo** 

- **Luồng xử lý:** MANAGER chọn loại thông báo + đối tượng + dữ kiện (ngày, giờ, phạm vi ảnh hưởng) → backend dựng prompt có khung mẫu → model trả 1–2 phương án → MANAGER sửa, xem trước, gửi. 

- **Ràng buộc:** không được bịa số liệu; mọi ngày giờ, số tiền, tên căn hộ trong bản nháp phải lấy từ dữ kiện được truyền vào, hệ thống kiểm tra lại các con số trước khi cho gửi. 

- **Tiêu chí đánh giá:** ≥ 60% bản nháp được gửi với ≤ 20% chỉnh sửa nội dung. 

- **Giới hạn:** không dùng cho văn bản có giá trị pháp lý (thông báo chấm dứt hợp đồng, biên bản vi phạm) trừ khi có mẫu do bộ phận pháp lý duyệt sẵn. 

### **12.4 Tự động hóa không cần AI (ưu tiên làm bằng quy tắc cứng)** 

Những việc dưới đây **không nên** giao cho mô hình ngôn ngữ vì cần chính xác tuyệt đối và có thể biểu diễn bằng quy tắc: 

|**Tác vụ**|**Cơ chế**|**Lịch chạy**|
|---|---|---|
|Sinh hóa đơn kỳ|Job + quy tắc biểu<br>phí|Theo ngày chốt kỳ cấu hình|
|Nhắc hạn thanh toán & quá hạn|Job|Trước hạn 3 ngày; sau hạn 3/7/15<br>ngày|
|Cảnh báo hợp đồng sắp hết hạn|Job|Hằng ngày, mốc 60/30/15 ngày|
|Sinh work order bảo trì định kỳ|Job theo chu kỳ thiết<br>bị|Hằng ngày|
|Chuyển trạng thái hợp đồng hết<br>hạn|Job|Hằng ngày lúc chốt ngày|
|Cảnh báo lệch chỉ số điện nước|Quy tắc ngưỡng %|Khi ghi chỉ số|



### **12.5 Bảo vệ dữ liệu khi dùng AI** 

- Không gửi CCCD/CMND đầy đủ, ảnh giấy tờ, thông tin tài khoản ngân hàng cho model trừ tác vụ AI-01 (và khi đó phải có thông báo + cơ sở pháp lý hợp lệ cho việc xử lý). 

- Có công tắc tắt toàn bộ tính năng AI ở mức hệ thống và mức từng tính năng (kill switch). 

- Cư dân phải được thông báo khi đang trao đổi với chatbot AI chứ không phải người thật. 

- Lưu bản ghi "AI đã đề xuất gì, ai chấp nhận" tối thiểu bằng thời hạn lưu dữ liệu nghiệp vụ liên quan. 

- Hạn mức chi phí theo tháng + cảnh báo khi vượt 80% ngưỡng; hàng đợi giới hạn để tránh gọi lặp. 

## **13. Mô hình dữ liệu logic** 

Mức logical, PostgreSQL. Mọi bảng nghiệp vụ có id uuid , org_id , created_at , updated_at , created_by , updated_by , deleted_at (xóa mềm). org_id đặt sẵn từ MVP để mở đường đa chủ đầu tư mà không phải migrate sau. 

### **13.1 Sơ đồ quan hệ chính** 

flowchart LR ORG[organization] --> BLD[building] BLD --> FLR[floor] FLR --> APT[apartment] APT --> CTR[contract] TEN[tenant] --> CTR CTR --> DEP[deposit] CTR --> SUB[service_subscription] CTR --> INV[invoice] INV --> PAY[payment] APT --> MTR[meter] MTR --> RDG[meter_reading] APT --> REQ[service_request] REQ --> WO[work_order] ASSET[asset] --> WO 

### **13.2 Danh mục entity** 

|**Entity**|**Trường**|**Quan**|**Trạng thái**|**Ghi**|
|---|---|---|---|---|
||**chính**|**hệ**||**chú**|
|||||**nhạy**<br>**cảm**|



|organiz<br>ation|name,<br>tax_code,<br>settings jsonb|1-n<br>building|–|–|
|---|---|---|---|---|
|buildin<br>g|org_id, name,<br>code,<br>address,<br>timezone|n-1 org;<br>1-n<br>floor|ACTIVE/INACTIVE|–|
|floor|building_id,<br>level, name|1-n<br>apartm<br>ent|–|–|
|apartme<br>nt|floor_id, code<br>(unique theo<br>building),<br>area_m2,<br>type,<br>bedrooms,<br>base_rent,<br>amenities<br>jsonb|1-n<br>contract<br>, meter,<br>request|AVAILABLE/RESERVED/OCCUPIED/MAINTEN<br>ANCE/INACTIVE|–|
|person|full_name,<br>phone<br>(unique theo<br>org), email,<br>dob,<br>id_number,<br>id_images[]|base<br>cho<br>tenant/u<br>ser|–|**PII**<br>**cao**:<br>id_nu<br>mber,<br>ảnh<br>giấy<br>tờ →<br>mã<br>hóa<br>cột,<br>hạn<br>chế<br>đọc|
|tenant|person_id,<br>type<br>(primary/occu<br>pant),<br>relationship|n-n<br>contract<br>qua<br>contra<br>ct_occ<br>upant|PENDING/APPROVED/REJECTED/MOVED_O<br>UT|PII|



|app_use<br>r|person_id,<br>auth_uid,<br>status,<br>last_login_at|n-n role<br>qua<br>user_r<br>ole|ACTIVE/SUSPENDED|–|
|---|---|---|---|---|
|role,<br>permiss<br>ion,<br>user_ro<br>le|role_code,<br>scope<br>(org/building),<br>building_id|RBAC|–|–|
|contrac<br>t|apartment_id,<br>primary_tena<br>nt_id,<br>start_date,<br>end_date,<br>rent_amount,<br>billing_cycle,<br>billing_day,<br>deposit_amo<br>unt, status,<br>parent_contra<br>ct_id|1-n<br>invoice,<br>deposit,<br>subscri<br>ption,<br>version|DRAFT/PENDING_APPROVAL/ACTIVE/RENE<br>WAL_PENDING/EXPIRED/TERMINATED/CANC<br>ELLED|Bản<br>scan<br>hợp<br>đồng<br>= tài<br>liệu<br>nhạy<br>cảm|
|contrac<br>t_versi<br>on|contract_id,<br>version_no,<br>diff jsonb,<br>effective_fro<br>m, reason,<br>approved_by|lịch sử<br>phụ lục|–|Bất<br>biến|
|deposit|contract_id,<br>amount_held,<br>currency,<br>status|1-n<br>deposit<br>_transa<br>ction|HELD/SETTLEMENT_DRAFT/PENDING_APPR<br>OVAL/PARTIALLY_REFUNDED/REFUNDED/TR<br>ANSFERRED/DISPUTED|Tài<br>chính|
|deposit<br>_transa<br>ction|deposit_id,<br>type<br>(collect/deduc<br>t/refund/transf<br>er), amount,<br>evidence[],|–|–|Bất<br>biến<br>sau<br>duyệt|



||approved_by,<br>approved_at||||
|---|---|---|---|---|
|service<br>_catalo<br>g|building_id,<br>code, name,<br>unit,<br>pricing_type<br>(flat/per_unit/t<br>iered),<br>active_from|1-n<br>subscri<br>ption,<br>tariff|ACTIVE/ARCHIVED|–|
|tariff|service_id,<br>effective_fro<br>m,<br>effective_to,<br>unit_price,<br>tiers jsonb|–|–|Lịch<br>sử giá<br>phải<br>giữ<br>để tái<br>tính|
|service<br>_subscr<br>iption|contract_id,<br>service_id,<br>quantity,<br>start_date,<br>end_date,<br>status, meta<br>jsonb (vd.<br>biển số xe)|–|REQUESTED/APPROVED/ACTIVE/SUSPENDE<br>D/TERMINATED/REJECTED|Biển<br>số xe<br>= dữ<br>liệu<br>cá<br>nhân|
|meter|apartment_id,<br>type<br>(electric/wate<br>r), serial_no,<br>multiplier,<br>installed_at|1-n<br>reading|ACTIVE/REPLACED|–|
|meter_r<br>eading|meter_id,<br>period,<br>previous_valu<br>e,<br>current_value<br>,<br>consumption,<br>source<br>(manual/ai/iot<br>), image_url,|–|DRAFT/CONFIRMED/FLAGGED|–|



||status,<br>confirmed_by||||
|---|---|---|---|---|
|invoice|contract_id,<br>period,<br>issue_date,<br>due_date,<br>subtotal,<br>discount,<br>total,<br>paid_amount,<br>status|1-n<br>invoice<br>_line,<br>paymen<br>t|DRAFT/ISSUED/PARTIALLY_PAID/PAID/OVER<br>DUE/ADJUSTED/VOID|Tài<br>chính,<br>bất<br>biến<br>sau<br>ISSU<br>ED|
|invoice<br>_line|invoice_id,<br>type<br>(rent/service/<br>utility/penalty/<br>adjustment),<br>description,<br>quantity,<br>unit_price,<br>amount,<br>ref_id|–|–|Lưu<br>công<br>thức/t<br>ham<br>chiếu<br>để<br>giải<br>thích|
|payment|invoice_id<br>hoặc<br>contract_id,<br>amount,<br>method,<br>paid_at,<br>reference,<br>evidence_url,<br>status,<br>recorded_by|–|PENDING_CONFIRM/CONFIRMED/REJECTED<br>/REFUNDED|Tài<br>chính|
|credit_<br>balance|contract_id,<br>amount,<br>source_paym<br>ent_id|–|–|Phát<br>sinh<br>khi trả<br>thừa|
|service<br>_reques<br>t|apartment_id,<br>created_by,<br>category,<br>description,|1-n<br>work_or<br>der|NEW/TRIAGED/ASSIGNED/IN_PROGRESS/O<br>N_HOLD/RESOLVED/CLOSED/REOPENED/CA<br>NCELLED/MERGED|–|



||images[],<br>priority,<br>sla_due_at,<br>status,<br>merged_into_<br>id|||
|---|---|---|---|
|work_or<br>der|request_id<br>hoặc<br>maintenance<br>_plan_id,<br>assignee_id,<br>scheduled_at<br>, started_at,<br>completed_at<br>, materials<br>jsonb,<br>cost_amount,<br>cost_bearer|–|OPEN/IN_PROGRESS/DONE/CANCELLED<br>–|
|asset|building_id<br>hoặc<br>apartment_id,<br>name,<br>category,<br>serial_no,<br>warranty_unti<br>l,<br>maintenance<br>_cycle_days|1-n<br>work_or<br>der|IN_USE/BROKEN/UNDER_MAINTENANCE/RE<br>TIRED<br>–|
|mainten<br>ance_pl<br>an|asset_id,<br>cycle_days,<br>next_due_dat<br>e, checklist<br>jsonb|1-n<br>work_or<br>der|ACTIVE/PAUSED<br>–|
|announc<br>ement|building_id,<br>title, body,<br>audience<br>jsonb,<br>channel[],<br>scheduled_at|1-n<br>read_re<br>ceipt|DRAFT/SCHEDULED/SENT/CANCELLED<br>–|



||, sent_at,<br>created_by||||
|---|---|---|---|---|
|event|building_id,<br>title, start_at,<br>end_at, type<br>(maintenance<br>/billing/comm<br>unity)|–|–|–|
|notific<br>ation|user_id, type,<br>payload<br>jsonb,<br>read_at,<br>channel,<br>delivery_statu<br>s|–|–|–|
|ai_sugg<br>estion|task_type,<br>input_ref,<br>output jsonb,<br>confidence,<br>model,<br>prompt_versi<br>on, status,<br>reviewed_by|–|PENDING/ACCEPTED/REJECTED/EXPIRED|Khôn<br>g<br>chứa<br>PII<br>thô<br>nếu<br>tránh<br>được|
|audit_l<br>og|actor_id,<br>action, entity,<br>entity_id,<br>before jsonb,<br>after jsonb,<br>ip,<br>user_agent,<br>at|–|–|**Chỉ**<br>**ghi**<br>**thêm**,<br>không<br>UPDA<br>TE/D<br>ELET<br>E|
|attachm<br>ent|owner_entity,<br>owner_id,<br>storage_path,<br>mime, size,<br>uploaded_by|–|–|Ảnh<br>giấy<br>tờ:<br>bucke<br>t<br>riêng,<br>quyền<br>chặt|



### **13.3 Ràng buộc và chỉ mục quan trọng** 

|**Loại**|**Nội dung**|**Lý do**|
|---|---|---|
|Unique|apartment(building_id, code)|Chống trùng mã căn|
|Unique|person(org_id, phone);person(org_id,<br>id_number)khi không null|Chống trùng cư dân<br>(FR-021)|
|Unique|invoice(contract_id, period)|Chống sinh hóa đơn trùng<br>kỳ|
|Exclusion<br>constraint|contracttheoapartment_id+ khoảng<br>[start_date, end_date)với status ACTIVE|Chặn chồng lấn kỳ thuê ở<br>tầng DB, không chỉ ở ứng<br>dụng|
|Check|end_date > start_date;amount >= 0;<br>paid_amount <= total|Toàn vẹn tài chính|
|Index|invoice(status, due_date),<br>service_request(status, sla_due_at),<br>meter_reading(meter_id, period)|Hiệu năng dashboard & job|
|Partial<br>index|Bản ghi chưa xóa mềm (deleted_at IS NULL)|Truy vấn danh sách|



### **13.4 Quy ước về tiền và thời gian** 

- Tiền lưu bằng **số nguyên đơn vị VND** ( bigint ), không dùng float; nếu về sau có ngoại tệ thì thêm currency + tỷ giá tại thời điểm ghi nhận. 

- Thời gian lưu timestamptz theo UTC, hiển thị theo Asia/Ho_Chi_Minh ; các mốc nghiệp vụ theo **ngày** (ngày chốt kỳ, hạn thanh toán) lưu date để tránh lệch múi giờ. 

- Kỳ tính phí ( period ) dùng chuỗi YYYY-MM cho chu kỳ tháng; thiết kế cho phép chu kỳ khác (quý) nhưng MVP chỉ hỗ trợ tháng. 

### **13.5 Dữ liệu nhạy cảm và vòng đời** 

|**Nhóm**|**Ví dụ**|**Biện pháp**|**Thời hạn lưu đề xuất**|
|---|---|---|---|
|**dữ**||||
|**liệu**||||



|Định<br>danh<br>cá<br>nhân|CCCD, ảnh<br>giấy tờ,<br>ngày sinh|Mã hóa ở mức cột hoặc bucket riêng;<br>chỉ MANAGER/SYS_ADMIN đọc; che<br>một phần trên UI|Trong thời gian hợp đồng +<br>[CẦN XÁC NHẬN theo quy<br>định kế toán/pháp lý]|
|---|---|---|---|
|Liên<br>hệ|SĐT, email|Hạn chế theo vai trò; STAFF chỉ thấy<br>trong phạm vi công việc|Như trên|
|Tài<br>chính|Hóa đơn,<br>thanh toán,<br>cọc|Bất biến sau phát hành/duyệt; chỉ điều<br>chỉnh bằng bút toán mới|Theo yêu cầu lưu trữ chứng từ<br>kế toán|
|Hình<br>ảnh sự<br>cố|Ảnh trong<br>căn hộ|Có thể chứa hình ảnh riêng tư → hạn<br>chế người xem, cân nhắc xóa sau khi<br>đóng yêu cầu N tháng|[CẦN XÁC NHẬN]|
|Nhật<br>ký|Audit, đăng<br>nhập|Chỉ ghi thêm, sao lưu tách biệt|≥ 12 tháng (đề xuất)|



_Các thời hạn lưu trên là đề xuất, cần đối chiếu với quy định lưu trữ chứng từ kế toán và quy định bảo vệ dữ liệu cá nhân hiện hành của Việt Nam — tôi không khẳng định con số cụ thể do quy định có thể đã thay đổi._ 

### **13.6 Cập nhật mô hình dữ liệu theo phản hồi** 

|**Tha**<br>**y**<br>**đổi**|**Entity/trường**|**Lý do**|
|---|---|---|
|Thê<br>m|owner(chủ sở hữu tòa) +<br>building.owner_id,<br>building.lease_terms|Vận hành 5–7 tòa thuê lại của nhiều chủ sở<br>hữu|
|Thê<br>m|contract.billing_day(1–31),<br>contract.payment_due_days|Ngày thanh toán theo từng khách, không theo<br>tòa|
|Thê<br>m|contract_service_price<br>(contract_id, service_id, unit_price,<br>effective_from)|Đơn giá dịch vụ ghi đè theo hợp đồng|
|Thê<br>m|late_fee_rule(grace_days = 5,<br>amount_per_day = 100000, cap) +<br>invoice_line.type = 'late_fee'|Phí phạt chậm thanh toán|



|Thê<br>m|reservation(prospect_name, phone,<br>apartment_id, hold_amount, hold_until,<br>status) và<br>deposit.source_reservation_id|Cọc giữ chỗ cho khách chưa thuê; trạng thái<br>HELD/CONVERTED/FORFEITED/REFUNDED/<br>EXPIRED|
|---|---|---|
|Thê<br>m|apartment.status = RESERVED<br>được dùng thật (trước đây chỉ khai báo)|Giữ chỗ khóa căn hộ|
|Thê<br>m|deposit.refund_due_date|Cam kết hoàn cọc 3–5 ngày|
|Thê<br>m|organization.payment_account<br>(chủ tài khoản, ngân hàng, số tài khoản,<br>loại: cá nhân/hộ kinh doanh)|Hiện thu vào tài khoản cá nhân, sau chuyển<br>sang tài khoản HKD|
|Thê<br>m|zalo_group(building_id hoặc<br>apartment_id, tên nhóm, link) +<br>announcement.manual_sent_at|Kênh thông báo chính hiện là nhóm Zalo|
|Bỏ|tariff.tiers(bậc thang điện) khỏi<br>MVP|Điện nước dùng đơn giá cố định; giữ cột<br>nhưng không dùng, tránh migrate nếu sau<br>này cần|
|Điều<br>chỉn<br>h|Ràng buộc "một hợp đồng hiệu lực/căn<br>hộ" giữ nguyên ở MVP, nhưng thiết kế<br>cho phép nới thành nhiều hợp đồng/căn|Chủ đầu tư dự kiến có thể phát sinh hợp<br>đồng chung|
|Cân<br>nhắ<br>c<br>(chư<br>a<br>làm)|vendor,purchase_order,payable|Thanh toán cho nhà cung cấp — phạm vi<br>mới, chờ xác nhận|



## **14. API, tích hợp và kiến trúc kỹ thuật đề xuất** 

### **14.1 Kiến trúc tổng thể** 

flowchart TD 

U[Trình duyệt<br/>React + Tailwind] --> LB[Reverse proxy<br/>Nginx + TLS] LB --> APP[Web app + API<br/>Docker container] APP --> DB[(PostgreSQL<br/>máy chủ tại VN)] APP --> ST[Object storage<br/>ảnh, tài liệu] APP --> AI[AI Gateway<br/>server-side] 

AI --> G[Gemini Pro API] WK[Worker job định kỳ<br/>Docker] --> DB WK --> N[Kênh thông báo<br/>SMS OTP · email · Zalo] APP --> N 

Ranh giới dịch vụ đề xuất: 

|**Thành**<br>**phần**|**Trách nhiệm**|**Ghi chú sau khi chốt hạ tầng tại VN**|
|---|---|---|
|Web app +<br>API|UI React/Tailwind + API cho thao<br>tác người dùng|Chạy trong Docker trên Ubuntu tại nhà<br>cung cấp trong nước; không dùng Vercel<br>cho production|
|PostgreSQ<br>L|Dữ liệu nghiệp vụ + RLS|Tự vận hành: cần sao lưu, giám sát,<br>nâng cấp — bổ sung vào chi phí và nhân<br>sự|
|Auth &<br>Storage|Đăng nhập OTP, lưu ảnh/tài liệu|Supabase**self-host**(giữ được<br>Auth/Storage/RLS) hoặc tự triển khai;<br>quyết định thuộc đội kỹ thuật|
|AI Gateway|Dựng prompt, kiểm tra đầu ra, ghi<br>log, giới hạn chi phí|Chạy trong nước; chỉ dữ liệu cần thiết<br>mới rời máy chủ khi gọi model|
|Worker|Job định kỳ: sinh hóa đơn theo<br>billing_dayhằng ngày, tính phí<br>phạt, nhắc nợ, bảo trì|Docker trên cùng hạ tầng, có khóa<br>chống chạy trùng|
|Kênh thông<br>báo|SMS OTP, email, sau này Zalo OA|Zalo hiện dùng thủ công qua nhóm chat|
|Vercel (tùy<br>chọn)|Môi trường dev/preview|Chỉ dùng với dữ liệu giả lập, không chứa<br>dữ liệu cư dân thật|



**Quyết định đã chốt:** máy chủ đặt tại Việt Nam. Điều này loại Supabase Cloud và Vercel khỏi production, kéo theo ba hệ quả cần chủ đầu tư biết trước: (1) đội phải tự vận hành hạ tầng — sao lưu, giám sát, vá bảo mật, chứng chỉ TLS — thay vì dùng dịch vụ quản lý; (2) chi phí chuyển từ trả theo mức dùng sang thuê máy chủ cố định hằng tháng cộng công vận hành; (3) cần chốt nhà cung cấp hạ tầng trong nước trước giai đoạn S1 (mục 19). **Lưu ý:** gọi API mô hình AI đặt ở nước ngoài vẫn là chuyển dữ liệu ra ngoài lãnh thổ — nếu yêu cầu "dữ liệu ở Việt Nam" bao gồm cả trường hợp này thì phải giới hạn dữ liệu gửi cho AI hoặc dùng mô hình triển khai trong nước. Đây là điểm cần chủ đầu tư và bên pháp lý xác nhận, tôi không tự kết luận. 

### **14.2 Xác thực và phân quyền** 

|**Nội dung**|**Thiết kế**|
|---|---|
|Đăng nhập<br>cư dân|OTP 6 số qua SMS (hoặc Zalo ZNS), hiệu lực 5 phút, tối đa 5 lần thử, giới hạn<br>3 lần gửi/giờ/SĐT + giới hạn theo IP|
|Đăng nhập<br>nội bộ|Email + mật khẩu, khuyến nghị bật 2FA cho SYS_ADMIN, ACCOUNTANT,<br>OWNER|
|Phiên|JWT ngắn hạn + refresh; hết hạn nhàn rỗi 30 phút với vai trò tài chính, 7 ngày<br>với cư dân (cấu hình được)|
|Phân<br>quyền|RBAC lưu ở DB +**RLS PostgreSQL**theo<br>org_id/building_id/contract_id; policy viết cho từng bảng, có test tự<br>động|
|Chống lạm<br>dụng|Rate limit theo IP và theo user; captcha khi bất thường|
|Đổi SĐT|Yêu cầu xác thực OTP cả số cũ và số mới; nếu không truy cập được số cũ →<br>quy trình xác minh thủ công qua BQL, có audit|



### **14.3 Nhóm API chính (REST, JSON)** 

|**Nh**<br>**óm**|**Endpoint tiêu biểu**|**Method**|**Quyền**|**Ghi chú**|
|---|---|---|---|---|
|Aut<br>h|/auth/otp/request,/auth/otp/verify|POST|Public (có<br>rate limit)|Trả token;<br>thông điệp lỗi<br>trung lập|
|Bất<br>độ<br>ng<br>sản|/buildings,<br>/buildings/{id}/apartments|GET/POST/<br>PATCH|MANAGE<br>R+|Hỗ trợ<br>?page,?q,<br>?status|
|Cư<br>dâ<br>n|/tenants,/tenants/{id}/merge|GET/POST/<br>PATCH|MANAGE<br>R|merge cần lý<br>do + audit|
|Hợ<br>p<br>đồ<br>ng|/contracts,<br>/contracts/{id}/activate,/renew,<br>/terminate|POST|MANAGE<br>R + duyệt|Idempotency<br>-Key bắt<br>buộc|



|Cọ<br>c|/deposits/{id}/settlement,<br>/settlement/{id}/approve|POST|ACCOUN<br>TANT /<br>approver|Tách lập và<br>duyệt|
|---|---|---|---|---|
|Chỉ<br>số|/meter-readings/batch,<br>/meter-readings/{id}/confirm|POST|STAFF,<br>ACCOUN<br>TANT|Chấp nhận<br>gửi theo lô,<br>chịu lỗi mạng|
|Hó<br>a<br>đơ<br>n|/invoices/generate,<br>/invoices/{id}/issue,<br>/invoices/{id}/adjust|POST|ACCOUN<br>TANT|generate<br>idempotent<br>theo (period,<br>building)|
|Th<br>an<br>h<br>toá<br>n|/payments,/payments/{id}/confirm,<br>/webhooks/payment|POST|ACCOUN<br>TANT / hệ<br>thống|Webhook<br>xác thực chữ<br>ký, chống<br>replay|
|Yê<br>u<br>cầu|/requests,/requests/{id}/assign,<br>/status|POST/PATC<br>H|Theo vai<br>trò|Cư dân chỉ<br>tạo và xem<br>của mình|
|Th<br>ôn<br>g<br>bá<br>o|/announcements,<br>/announcements/{id}/send|POST|MANAGE<br>R|sendcần<br>xác nhận hai<br>bước|
|AI|/ai/extract,/ai/classify,/ai/draft|POST|Theo vai<br>trò|Trả<br>suggestion<br>_id+<br>confidence,<br>không ghi dữ<br>liệu nghiệp<br>vụ|
|Bá<br>o<br>cáo|/reports/revenue,<br>/reports/receivables,/export|GET/POST|OWNER,<br>ACCOUN<br>TANT|Export chạy<br>nền, trả link<br>tải có hạn|



**Quy ước chung:** phiên bản hóa /{version} ở đường dẫn; phân trang cursor cho danh sách lớn; lỗi theo cấu trúc {code, message, details} ; mọi POST thay đổi tiền bắt buộc Idempotency-Key ; mọi phản hồi lỗi không tiết lộ sự tồn tại của dữ liệu ngoài phạm vi quyền. 

Mẫu phản hồi AI (rút gọn): 

{ "suggestion_id": "a1b2c3", "task": "meter_reading_ocr", "output": { "reading": 12345, "unit": "kWh" }, "confidence": 0.93, "needs_human_review": true, "model": "gemini-pro", "warnings": [] } 

### **14.4 Tích hợp bên thứ ba** 

|**Tích hợp**|**Mục đích**|**Bắt buộc**<br>**ở phase**|**Rủi ro/phụ thuộc**|
|---|---|---|---|
|Nhà cung cấp<br>SMS/Zalo ZNS|OTP và thông<br>báo|MVP<br>(OTP)|Chi phí/tin, phê duyệt mẫu ZNS mất thời gian<br>— [CẦN XÁC NHẬN nhà cung cấp]|
|Email<br>(SMTP/dịch vụ<br>gửi)|Thông báo,<br>báo cáo|MVP|Tỷ lệ vào hộp thư rác|
|Cổng thanh toán<br>/ VietQR|Thu tiền, đối<br>soát tự động|Phase 2|Cần tài khoản doanh nghiệp, hợp đồng, đối<br>soát sai lệch|
|Hóa đơn điện tử|Xuất hóa đơn<br>hợp lệ|Phase 3|Ràng buộc pháp lý; cần kế toán trưởng xác<br>nhận nghĩa vụ xuất hóa đơn|
|Gemini Pro API|Các tính năng<br>AI|MVP|Giới hạn tần suất, chi phí, thay đổi model|



### **14.5 Môi trường và CI/CD** 

- Ba môi trường: dev → staging (dữ liệu giả lập) → production ; migration DB có phiên bản, chạy tự động khi deploy, luôn có script rollback. 

- Preview deployment theo pull request để Product/QA duyệt trước khi merge. 

- Bí mật (API key, chuỗi kết nối) lưu trong secret manager của nền tảng, không nằm trong mã nguồn. 

- Worker đóng gói Docker, chạy trên Ubuntu; lịch job khai báo tập trung, có khóa chống chạy trùng (distributed lock) và nhật ký từng lần chạy. 

## **15. Dashboard, báo cáo và KPI** 

Mỗi vai trò có một dashboard riêng; dữ liệu luôn bị giới hạn bởi RLS nên cùng một biểu đồ hiển thị phạm vi khác nhau tùy người xem. Biểu đồ dùng Chart.js. 

### **15.1 Dashboard theo vai trò** 

|**Vai**<br>**trò**|**Thẻ số liệu (KPI card)**|**Biểu đồ Chart.js**|**Bộ lọc**|
|---|---|---|---|
|Chủ<br>đầu<br>tư|Doanh thu kỳ, tỷ lệ lấp<br>đầy, tổng công nợ, số sự<br>cố mở, tỷ lệ gia hạn|Đường: doanh thu 12 tháng · Cột chồng: doanh<br>thu theo nguồn (thuê/dịch vụ/điện nước) · Cột:<br>công nợ theo nhóm tuổi nợ · Đường: tỷ lệ lấp<br>đầy theo tháng|Tòa<br>nhà,<br>khoảng<br>thời<br>gian|
|Quản<br>lý tòa<br>nhà|Căn trống, hợp đồng hết<br>hạn trong 30/60 ngày, yêu<br>cầu quá SLA, công việc<br>hôm nay|Cột: căn hộ theo trạng thái · Đường: số yêu cầu<br>theo tuần · Tròn: yêu cầu theo nhóm sự cố|Tòa,<br>tầng,<br>trạng<br>thái|
|Kế<br>toán|Đã phát hành/đã thu kỳ<br>này, dư nợ, hóa đơn quá<br>hạn, hoàn cọc chờ duyệt|Cột: đã thu vs phải thu theo kỳ · Cột: tuổi nợ ·<br>Đường: tiêu thụ điện nước toàn tòa|Kỳ, tòa,<br>trạng<br>thái hóa<br>đơn|
|Nhân<br>viên<br>kỹ<br>thuật|Việc được giao hôm nay,<br>việc quá hạn, việc chờ vật<br>tư|Cột: việc hoàn thành theo tuần|Ngày,<br>trạng<br>thái|
|Cư<br>dân|Số tiền phải trả, hạn thanh<br>toán, yêu cầu đang xử lý,<br>thông báo chưa đọc|Đường: chi phí điện nước 6 kỳ gần nhất của<br>căn hộ|Kỳ|



### **15.2 Danh mục báo cáo** 

|**ID**|**Báo cáo**|**Nội dung**|**Người dùng**|**Xuất**|
|---|---|---|---|---|
|RP-|Doanh thu|Tách theo tiền thuê, dịch vụ, điện|OWNER,|Excel/CSV|
|01|theo kỳ|nước, phí khác|ACCOUNTANT||
|RP-|Công nợ chi|Theo căn hộ, hợp đồng, tuổi nợ, lịch|ACCOUNTANT,|Excel/CSV|
|02|tiết|sử nhắc|OWNER||



|RP-<br>03|Tình trạng lấp<br>đầy|Số căn theo trạng thái theo thời gian;<br>thời gian trống trung bình|OWNER,<br>MANAGER|Excel|
|---|---|---|---|---|
|RP-<br>04|Hợp đồng đến<br>hạn|Danh sách kèm ngày, tiền thuê, tình<br>trạng đề nghị gia hạn|MANAGER|Excel|
|RP-<br>05|Sự cố & SLA|Số lượng, thời gian phản hồi/hoàn<br>tất, tỷ lệ đúng hạn, đánh giá|MANAGER,<br>OWNER|Excel|
|RP-<br>06|Tiêu thụ điện<br>nước|Theo căn hộ và toàn tòa, phát hiện<br>bất thường|ACCOUNTANT,<br>MANAGER|Excel|
|RP-<br>07|Sổ cọc|Đang giữ, đã hoàn, đã khấu trừ, đang<br>tranh chấp|ACCOUNTANT,<br>OWNER|Excel|
|RP-<br>08|Nhật ký thao<br>tác tài chính|Ai thay đổi gì trên hóa đơn/thanh<br>toán/cọc|OWNER,<br>SYS_ADMIN|CSV|



### **15.3 Định nghĩa KPI (để tránh mỗi người hiểu một kiểu)** 

|**KPI**|**Công thức**|**Lưu ý**|
|---|---|---|
|Tỷ lệ lấp<br>đầy|Số cănOCCUPIED÷ tổng số căn<br>khai thác được, tính tại ngày cuối<br>kỳ|Căn đangMAINTENANCEcó tính vào mẫu<br>số hay không cần thống nhất — [CẦN XÁC<br>NHẬN]|
|Doanh thu<br>ghi nhận<br>kỳ|Tổng hóa đơnISSUEDtrong kỳ<br>(không trừ chưa thu)|Khác với**tiền thực thu**; dashboard phải<br>hiển thị cả hai|
|Tiền thực<br>thu|Tổngpaymentđã xác nhận trong<br>kỳ|–|
|DSO|(Dư nợ cuối kỳ ÷ doanh thu kỳ) ×<br>số ngày trong kỳ|Chỉ có ý nghĩa khi đủ ≥ 3 kỳ dữ liệu|
|Tuổi nợ|Số ngày từdue_dateđến hiện<br>tại với hóa đơn chưa thanh toán<br>đủ|Nhóm 0–15/16–30/31–60/>60|
|Đúng SLA|Số yêu cầuRESOLVEDtrước<br>sla_due_at÷ tổng yêu cầu đóng<br>trong kỳ|REOPENEDtính lại theo yêu cầu gốc|



|Tỷ lệ gia|Hợp đồng gia hạn ÷ hợp đồng đến|Loại trừ chấm dứt do vi phạm|
|---|---|---|
|hạn|hạn trong kỳ||



**Nguyên tắc trình bày số liệu:** mỗi con số trên dashboard phải bấm được để mở danh sách bản ghi tạo ra nó (drill-down); mọi biểu đồ ghi rõ kỳ dữ liệu và thời điểm cập nhật; không hiển thị biểu đồ khi dữ liệu dưới ngưỡng tối thiểu mà hiển thị empty state giải thích lý do. 

## **16. UX/UI và yêu cầu responsive/accessibility** 

### **16.1 Nguyên tắc thiết kế** 

- **Cư dân dùng điện thoại, quản trị dùng máy tính.** Cổng cư dân thiết kế mobile-first, tối đa 2 thao tác để tới hóa đơn hoặc báo hỏng. Màn hình admin tối ưu cho bảng dữ liệu rộng, nhưng vẫn dùng được trên tablet. 

- **Nhân viên kỹ thuật làm việc ngoài hiện trường:** màn hình work order phải dùng được bằng một tay, nút lớn, chụp ảnh trực tiếp, chịu được mạng chập chờn. 

- **Số tiền luôn rõ ràng:** định dạng VND có phân tách hàng nghìn, không viết tắt (hiển thị 1.250.000 ₫ , không 1,25tr ) trên hóa đơn và bảng tất toán. 

- **Hành động nguy hiểm luôn có bước xác nhận có ngữ cảnh** , nêu rõ hệ quả ("Phát hành 48 hóa đơn kỳ 09/2026, tổng 312.400.000 ₫. Sau khi phát hành không sửa trực tiếp được."). 

### **16.2 Trạng thái giao diện bắt buộc** 

|**Trạng thái**|**Yêu cầu**|**Ví dụ**|
|---|---|---|
|Empty|Giải thích vì sao trống + hành động kế<br>tiếp, không chỉ một dòng "Không có dữ<br>liệu"|"Chưa có hóa đơn nào cho kỳ này.<br>Ghi chỉ số điện nước trước khi<br>sinh hóa đơn." + nút|
|Loading|Skeleton cho bảng/thẻ; không dùng<br>spinner toàn trang cho tải cục bộ; thao<br>tác > 3 giây có tiến trình|Bảng hóa đơn hiện skeleton 10<br>dòng|
|Error|Nêu chuyện gì xảy ra + việc người dùng<br>có thể làm + mã lỗi để báo hỗ trợ; không<br>đổ lỗi cho người dùng|"Không lưu được do mất kết nối.<br>Dữ liệu đã được giữ lại, thử lại khi<br>có mạng."|
|Partial/AI<br>uncertain|Hiển thị rõ giá trị do AI đề xuất (nền khác<br>+ nhãn "AI đề xuất"), bắt buộc xác nhận|Ô chỉ số điện có viền nét đứt kèm<br>mức độ tin cậy|
|Confirmation|Hai bước cho hành động không hoàn tác;<br>nhập lại số lượng/số tiền khi rủi ro cao|Gõ số hóa đơn cần hủy để xác<br>nhận|



|Success|Xác nhận ngắn + lối tắt đến kết quả|"Đã phát hành 48 hóa đơn. Xem<br>danh sách"|
|---|---|---|
|Offline|Báo mất kết nối, giữ nháp cục bộ, đồng<br>bộ lại khi có mạng|Màn hình ghi chỉ số|
|Permission|Thông báo trung lập, không tiết lộ dữ liệu|"Bạn không có quyền xem mục|
|denied|ngoài quyền|này."|



### **16.3 Responsive** 

|**Breakpoint**|**Bố cục**|
|---|---|
|< 640px|Một cột; bảng chuyển thành thẻ; điều hướng dạng bottom bar (cổng cư<br>dân)|
|640–1024px|Hai cột; bảng cuộn ngang có cột khóa (mã căn, tên)|
|> 1024px|Bố cục admin đầy đủ: sidebar + bảng + panel chi tiết|



### **16.4 Accessibility (mục tiêu WCAG 2.1 mức AA)** 

- Tương phản văn bản ≥ 4.5:1; không dùng riêng màu để truyền đạt trạng thái (kèm nhãn/biểu tượng Lucide). 

- Điều hướng đầy đủ bằng bàn phím, thứ tự focus hợp lý, focus visible rõ ràng. 

- Nhãn form rõ ràng, thông báo lỗi gắn với trường bằng aria-describedby ; vùng cập nhật động dùng aria-live . 

- Vùng bấm tối thiểu 44×44px trên thiết bị cảm ứng. 

- Ngôn ngữ: tiếng Việt là mặc định; thiết kế chuỗi văn bản tách khỏi mã nguồn để thêm tiếng Anh sau (Phase 2). 

- _Mức AA là mục tiêu đề xuất; cần xác nhận đây là cam kết hay chỉ là hướng phấn đấu, vì nó ảnh hưởng chi phí kiểm thử._ 

### **16.5 Hệ thống thành phần** 

Dùng Tailwind + bộ component nội bộ: DataTable (lọc/sắp xếp/phân trang/chọn nhiều), FormField, StatusBadge (bảng màu thống nhất theo nhóm trạng thái), Money, DateRangePicker, FileUploader (nén ảnh phía client), ConfirmDialog, EmptyState, AISuggestionField, Timeline (lịch sử bản ghi). Icon dùng Lucide, thống nhất một kích thước theo ngữ cảnh. 

## **17. Yêu cầu phi chức năng, bảo mật và bảo vệ dữ liệu** 

**ID Nhóm Yêu cầu Cách đo** 

|NFR-<br>001|Hiệu<br>năng|Trang danh sách ≤ 200 bản ghi tải xong<br>trong < 2s ở kết nối 4G thông thường|Đo p95 bằng công cụ giám<br>sát|
|---|---|---|---|
|NFR-<br>002|Hiệu<br>năng|Sinh hóa đơn cho 200 hợp đồng hoàn tất <<br>60s, chạy nền có tiến trình|Kiểm thử tải|
|NFR-<br>003|Hiệu<br>năng|API đọc p95 < 500ms với dữ liệu 5 tòa ×<br>200 căn × 24 kỳ|Kiểm thử tải với dữ liệu giả<br>lập|
|NFR-<br>004|Khả<br>dụng|Mục tiêu 99.5%/tháng trong giờ hành chính;<br>bảo trì có kế hoạch báo trước 48h|Giám sát uptime|
|NFR-<br>005|Sao lưu|Sao lưu tự động hằng ngày, giữ tối thiểu 30<br>ngày, có point-in-time recovery|Kiểm tra định kỳ|
|NFR-<br>006|Khôi<br>phục|RPO ≤ 24 giờ, RTO ≤ 4 giờ|**Diễn tập khôi phục ít nhất 1**<br>**lần trước go-live và mỗi 6**<br>**tháng**|
|NFR-<br>007|Bảo mật|TLS mọi kết nối; mật khẩu băm; khóa API<br>trong secret manager; không log dữ liệu<br>nhạy cảm|Rà soát mã + kiểm thử|
|NFR-<br>008|Bảo mật|RLS bật trên mọi bảng chứa dữ liệu theo<br>tòa/hợp đồng; có test tự động cho từng<br>policy|Test suite bắt buộc pass|
|NFR-<br>009|Bảo mật|Rà soát lỗ hổng phụ thuộc tự động; xử lý lỗ<br>hổng nghiêm trọng trong 7 ngày|Báo cáo quét|
|NFR-<br>010|Audit|Mọi thay đổi dữ liệu tài chính và phân quyền<br>ghi audit chỉ-ghi-thêm, giữ ≥ 12 tháng|Kiểm tra mẫu|
|NFR-<br>011|Logging<br>& giám<br>sát|Log tập trung có correlation id; cảnh báo khi<br>tỷ lệ lỗi > 1% trong 5 phút hoặc job thất bại|Bảng cảnh báo|
|NFR-<br>012|Mở rộng|Kiến trúc và mô hình dữ liệu chịu được 20<br>tòa × 200 căn mà không đổi schema lớn|Kiểm thử dữ liệu giả lập|
|NFR-<br>013|Chi phí<br>vận<br>hành|Chi phí hạ tầng + AI theo tháng có trần và<br>cảnh báo 80%; log chi phí AI theo tính năng|Dashboard chi phí|



|NFR-<br>014|Khả<br>năng<br>bảo trì|Tài liệu API tự sinh; test coverage tối thiểu<br>cho module tài chính [CẦN CHỐT ngưỡng]|CI|
|---|---|---|---|
|NFR-<br>015|Tương<br>thích|Hỗ trợ 2 phiên bản mới nhất của Chrome,<br>Safari, Edge, Firefox; Safari iOS và Chrome<br>Android|Ma trận kiểm thử|
|NFR-<br>016|Toàn vẹn<br>dữ liệu|Không xóa cứng bản ghi nghiệp vụ; mọi hủy<br>bỏ là chuyển trạng thái + lý do|Rà soát schema|
|NFR-<br>017|Chịu lỗi|Job định kỳ idempotent, có retry với backoff<br>và hàng đợi thất bại (dead letter)|Kiểm thử chủ động gây lỗi|



### **17.1 Bảo vệ dữ liệu cá nhân — các điểm cần tuân thủ** 

Hệ thống xử lý dữ liệu cá nhân của cư dân (họ tên, SĐT, email, số giấy tờ tùy thân, ảnh giấy tờ, biển số xe, hình ảnh trong căn hộ). Những nội dung dưới đây là **các điểm cần rà soát tuân thủ, không phải tư vấn pháp lý** — cần luật sư xác nhận và cần kiểm tra hiệu lực quy định tại thời điểm triển khai: 

|**#**|**Nội dung cần rà soát**|**Việc cần làm trong sản phẩm**|
|---|---|---|
|1|Cơ sở pháp lý và sự đồng ý khi thu thập dữ liệu cá nhân<br>(Việt Nam có Nghị định 13/2023/NĐ-CP về bảo vệ dữ<br>liệu cá nhân — cần kiểm tra hiệu lực và văn bản thay<br>thế/hướng dẫn hiện hành)|Màn hình thông báo quyền<br>riêng tư + ghi nhận sự đồng ý<br>có mốc thời gian và phiên bản<br>chính sách|
|2|Mục đích sử dụng và tối thiểu hóa dữ liệu|Không thu thập trường không<br>dùng đến; rà soát danh sách<br>trường bắt buộc|
|3|Quyền của chủ thể dữ liệu (truy cập, chỉnh sửa, rút lại<br>đồng ý, xóa)|Chức năng cư dân xem/sửa<br>hồ sơ; quy trình tiếp nhận yêu<br>cầu xóa và giới hạn do nghĩa<br>vụ lưu chứng từ|
|4|Chuyển dữ liệu ra nước ngoài (dịch vụ AI, hạ tầng đặt<br>ngoài Việt Nam)|Đánh giá và ghi nhận; cân<br>nhắc self-host nếu bắt buộc<br>lưu trữ trong nước|
|5|Bảo mật dữ liệu nhạy cảm|Mã hóa, phân quyền chặt, che<br>hiển thị, audit truy cập ảnh giấy<br>tờ|



|6|Nghĩa vụ về hóa đơn, chứng từ và thuế khi thu tiền thuê|Kế toán trưởng xác nhận cách<br>xuất hóa đơn; hệ thống hỗ trợ<br>xuất dữ liệu phù hợp|
|---|---|---|
|7|Hợp đồng thuê nhà và điều kiện chấm dứt, đặt cọc|Mẫu hợp đồng do bên pháp lý<br>cung cấp; hệ thống chỉ số hóa,<br>không tự sinh điều khoản|
|8|Quy định về phòng cháy chữa cháy, quản lý cư trú, khai<br>báo tạm trú|Hệ thống có thể hỗ trợ xuất<br>danh sách cư dân phục vụ<br>khai báo — cần xác nhận yêu<br>cầu cụ thể|
|9|Thông báo vi phạm dữ liệu|Quy trình phát hiện, ghi nhận,<br>báo cáo nội bộ và cho cơ quan<br>có thẩm quyền nếu bắt buộc|



**Lưu ý trung thực:** Tôi không thể xác nhận nội dung, hiệu lực hiện tại hoặc cách áp dụng cụ thể của các văn bản pháp luật nêu trên đối với mô hình chung cư mini cho thuê. Danh sách này nhằm chỉ ra **những chỗ cần hỏi chuyên gia** , không thay thế ý kiến pháp lý. 

#### **Cập nhật v0.2 — những điểm đã rõ hơn:** 

- Điểm 4 (chuyển dữ liệu ra nước ngoài): chủ đầu tư yêu cầu **máy chủ tại Việt Nam** , nên phần hạ tầng đã được giải quyết. Riêng việc gọi API mô hình AI ở nước ngoài vẫn cần đánh giá. 

- Điểm 6 (hóa đơn, chứng từ, thuế): hiện **chưa xuất hóa đơn** , chủ đầu tư xác định sẽ phải làm và sẽ có nhân sự chuyên trách. Cho đến khi đó, hệ thống phải giữ đủ dữ liệu để xuất hóa đơn hồi tố nếu cơ quan thuế yêu cầu — đây là rủi ro cần hỏi kế toán/luật sư sớm, không nên để đến Phase 3. 

- Điểm 7 (hợp đồng): đang dùng **một form chung** , giá dịch vụ thay đổi theo từng hợp đồng và theo số người/phòng. Cần bản form chính thức để ánh xạ đúng trường dữ liệu. 

- Thu tiền vào **tài khoản cá nhân** rồi xác nhận thủ công: đây là hiện trạng, không phải khuyến nghị. Khi chuyển sang tài khoản hộ kinh doanh, cần rà lại cách ghi nhận doanh thu và nghĩa vụ thuế — **cần kế toán xác nhận** , tôi không đưa ra kết luận về nghĩa vụ thuế. 

## **18. Kế hoạch kiểm thử và tiêu chí nghiệm thu tổng thể** 

### **18.1 Các lớp kiểm thử** 

|**Lớp**|**Phạm vi**|**Ai làm**|**Tiêu chí pass**|
|---|---|---|---|
|Unit|Logic tính tiền thuê pro-rata, bậc|Dev|100% nhánh của module tính tiền|
||thang điện, khấu trừ cọc, tuổi nợ|||



|Integration|API + RLS + job định kỳ|Dev/QA|Không rò rỉ dữ liệu chéo tòa/chéo<br>cư dân|
|---|---|---|---|
|E2E|8 luồng chính (mục 7) trên<br>Chrome desktop + Safari iOS|QA|Pass 100% kịch bản P0|
|Kiểm thử<br>phân<br>quyền|Ma trận vai trò × endpoint, gồm<br>truy cập trực tiếp bằng URL/API|QA +<br>Security|Không có truy cập ngoài quyền|
|Kiểm thử<br>dữ liệu tài<br>chính|Đối chiếu hóa đơn sinh tự động<br>với bảng tính tay trên mẫu 50<br>hợp đồng|Kế toán<br>+ QA|Sai lệch = 0 đồng|
|Kiểm thử<br>AI|Bộ mẫu chuẩn (ảnh đồng hồ, mô<br>tả sự cố) có đáp án|QA|Đạt ngưỡng ở mục 12.3;**không có**<br>**trường hợp AI tự ghi dữ liệu khi**<br>**chưa xác nhận**|
|Kiểm thử<br>tải|5 tòa × 200 căn, sinh hóa đơn<br>đồng thời|Dev|Đạt NFR-002, NFR-003|
|UAT|Quản lý, kế toán, kỹ thuật, 5 cư<br>dân thật chạy 1 kỳ song song với<br>cách làm cũ|Người<br>dùng<br>thật|Xem 18.2|



### **18.2 Tiêu chí nghiệm thu tổng thể (Definition of Done cho MVP)** 

1. Chạy song song **một kỳ thu phí đầy đủ** với quy trình hiện tại và số liệu khớp 100% về tổng tiền từng hóa đơn. 

2. 100% căn hộ, hợp đồng đang hiệu lực và cư dân đã nhập vào hệ thống, có đối chiếu với danh sách gốc. 

3. Toàn bộ kịch bản P0 trong mục 11 pass, gồm cả các luồng ngoại lệ ở mục 7.5. 

4. Không còn lỗi nghiêm trọng (chặn nghiệp vụ hoặc sai tiền) đang mở; lỗi trung bình < [CẦN CHỐT số lượng]. 

5. Kiểm thử phân quyền không phát hiện truy cập ngoài quyền. 

6. Đã diễn tập khôi phục từ bản sao lưu thành công ít nhất một lần. 

7. Tài liệu hướng dẫn cho từng vai trò + buổi đào tạo đã hoàn thành; ít nhất 2 người vận hành tự thao tác được không cần hỗ trợ. 

8. Cơ chế tắt AI hoạt động và đã được kiểm chứng. 

### **18.3 Dữ liệu kiểm thử** 

Dùng dữ liệu giả lập cho dev / staging ; **không sao chép dữ liệu cư dân thật sang môi trường không phải production** . Nếu bắt buộc phải dùng dữ liệu thật để tái hiện lỗi, phải khử nhận dạng và có phê duyệt, ghi audit. 

## **19. Lộ trình triển khai, phụ thuộc và tiêu chí Go/No-Go** 

### **19.1 Lộ trình đề xuất** 

Giả định đội 4–6 người (1 PM kiêm BA, 1 UX/UI, 2 fullstack, 1 QA bán thời gian). **Thời lượng dưới đây là ước tính, không phải cam kết** — cần đội thực hiện ước lượng lại. 

|**Giai đoạn**|**Thời lượng**<br>**ước tính**|**Kết quả bàn giao**|**Phụ thuộc**|
|---|---|---|---|
|S0 — Khám phá & chốt<br>PRD|1–2 tuần|Trả lời 20 câu hỏi mục 23; chốt biểu phí,<br>mẫu hợp đồng, quy tắc pro-rata|Chủ đầu tư,<br>kế toán|
|S1 — Nền tảng|2–3 tuần|Auth OTP, RBAC + RLS, cấu trúc<br>tòa/căn hộ, audit log, khung UI|Nhà cung<br>cấp SMS|
|S2 — Cư dân & hợp<br>đồng & cọc|2–3 tuần|M04, M05, M06 + cổng cư dân tối thiểu|S1, mẫu<br>hợp đồng|
|S3 — Dịch vụ, chỉ số,<br>hóa đơn, thanh toán|3–4 tuần|M07–M10, sinh hóa đơn kỳ, công nợ,<br>nhắc nợ|Biểu phí<br>chốt|
|S4 — Yêu cầu, bảo trì,<br>thông báo|2–3 tuần|M11, M12 cơ bản, M13|S1|
|S5 — AI MVP +<br>Dashboard|2 tuần|AI-01..AI-05, dashboard 4 vai trò|Khóa API<br>AI|
|S6 — Nhập liệu, UAT,<br>đào tạo, go-live|2 tuần|Dữ liệu thật, chạy song song 1 kỳ, đào<br>tạo|Dữ liệu từ<br>chủ đầu tư|



Tổng ước tính MVP: **14–18 tuần** kể từ khi chốt PRD, với điều kiện dữ liệu nền và hạ tầng được cung cấp đúng hạn. Chủ đầu tư đã xác nhận **có chạy thử song song** để tìm lỗi trước khi cắt hẳn — điều này đã nằm ở giai đoạn S6 và tiêu chí Go/No-Go số 1. Ngân sách và mốc go-live mong muốn **chưa được cung cấp** , nên lịch trên tính từ ngày khởi động chứ không gắn với ngày cụ thể. 

### **19.2 Phụ thuộc bên ngoài** 

|**Phụ thuộc**|**Cần từ ai**|**Hạn cần có**|**Trạng thái sau phản hồi**|
|---|---|---|---|
|Nhà cung cấp hạ tầng<br>trong nước + quy cách<br>máy chủ|Chủ đầu<br>tư|Trước S1|**Mới, đang chờ**— chặn toàn bộ việc<br>dựng môi trường|



|Danh sách căn hộ, hợp<br>đồng, cư dân (đang ở<br>Excel)|BQL|Trước S6, nên<br>bắt đầu từ S4|Đã rõ định dạng: Excel; cần chốt<br>người đối chiếu|
|---|---|---|---|
|Bảng giá dịch vụ hiện<br>hành theo từng hợp<br>đồng|Kế<br>toán/BQL|Trước S3|Cần bản kê thực tế của ~50 phòng, vì<br>giá khác nhau theo hợp đồng|
|Form hợp đồng chung<br>đang dùng|Chủ đầu<br>tư|Trước S2|Đã xác nhận có form chung, cần bản<br>mềm|
|Tài khoản nhà cung cấp<br>SMS cho OTP|Chủ đầu<br>tư|Trước S1|Chưa rõ — Zalo hiện là kênh chat,<br>**không thay được OTP**; cần chọn<br>nhà cung cấp SMS|
|Danh sách nhóm Zalo<br>(tòa + từng phòng)|BQL|Trước S4|Mới, phục vụ FR-069|
|Khóa API mô hình AI +<br>hạn mức chi phí|Chủ đầu<br>tư|Trước S5|**Chưa họp, sẽ gửi sau**— nếu chưa<br>có khi tới S5 thì cắt AI khỏi MVP|
|Danh sách tòa dự kiến<br>thuê lại và chủ sở hữu|Chủ đầu<br>tư|Trước S1 (ảnh<br>hưởng mô hình<br>dữ liệu)|Mới: dự kiến 5–7 tòa|
|Quyết định về module<br>công nợ phải trả nhà<br>cung cấp|Giám đốc|Trước S3|Mới phát sinh, chưa có phạm vi|



### **19.3 Tiêu chí Go/No-Go trước go-live** 

|**#**<br>**Tiêu chí**|**Ngưỡng**|**Go**<br>**nếu**|
|---|---|---|
|1<br>Đối chiếu hóa đơn kỳ chạy song|Sai lệch 0 đồng|Đạt|
|song|||
|2<br>Lỗi nghiêm trọng đang mở|0|Đạt|
|3<br>Kiểm thử phân quyền|Không có truy cập ngoài quyền|Đạt|
|4<br>Sao lưu & khôi phục|Đã diễn tập thành công|Đạt|
|5<br>Đào tạo người dùng|≥ 2 người vận hành thao tác độc lập được|Đạt|



|6|Dữ liệu nền|100% hợp đồng hiệu lực đã nhập và đối<br>chiếu|Đạt|
|---|---|---|---|
|7|Kênh OTP|Tỷ lệ gửi thành công ≥ 95% trong kiểm thử|Đạt|
|8|Kế hoạch rollback|Có kịch bản quay lại quy trình cũ trong 1 kỳ|Đạt|



Nếu bất kỳ tiêu chí 1–4 không đạt → **No-Go** , lùi go-live sang kỳ sau thay vì đi tiếp với rủi ro sai tiền. 

## **20. Rủi ro và phương án giảm thiểu** 

Mức độ = Khả năng × Tác động, thang Cao/Trung bình/Thấp (đánh giá chủ quan của người soạn, cần đội dự án hiệu chỉnh). 

|**ID**|**Rủi ro**|**Mức**|**Dấu hiệu sớm**|**Giảm thiểu**|**Chủ trì**|
|---|---|---|---|---|---|
|R-<br>01|Sai số tiền trên<br>hóa đơn làm mất<br>niềm tin cư dân<br>ngay kỳ đầu|**Cao**|Lệch khi đối<br>chiếu thử|Chạy song song 1<br>kỳ; unit test 100%<br>logic tính tiền; bắt<br>buộc bước rà soát<br>của kế toán|Kế toán +<br>Dev lead|
|R-<br>02|Quy tắc nghiệp vụ<br>(pro-rata, bậc<br>thang, phạt chậm)<br>chưa được chốt<br>rõ|**Cao**|Câu trả lời khác<br>nhau giữa các<br>bên|Chốt bằng văn bản<br>ở S0, đưa vào cấu<br>hình thay vì<br>hard-code|PM|
|R-<br>03|Dữ liệu hiện hữu<br>rời rạc, nhập liệu<br>ban đầu tốn công<br>hơn dự kiến|Cao|Nhiều hợp đồng<br>thiếu thông tin|Công cụ nhập hàng<br>loạt từ Excel + AI<br>trích xuất; bắt đầu<br>nhập từ S4 chứ<br>không đợi S6|BQL|
|R-<br>04|Cư dân không<br>dùng cổng, vẫn<br>gọi điện như cũ|Trung bình|Tỷ lệ đăng nhập<br>thấp sau 1 tháng|Đăng nhập OTP<br>không cần mật<br>khẩu; gửi hóa đơn<br>kèm link; hướng<br>dẫn tại chỗ khi ký<br>hợp đồng|BQL|



|R-<br>05|AI đọc sai chỉ<br>số/phân loại sai<br>gây sai tiền hoặc<br>chậm xử lý|Trung bình|Tỷ lệ chỉnh sửa<br>cao|Bắt buộc xác nhận<br>của người; kiểm tra<br>hậu nghiệm bằng<br>quy tắc; kill switch|Dev lead|
|---|---|---|---|---|---|
|R-<br>06|Chi phí AI vượt<br>dự toán|Trung bình|Chi phí/ngày<br>tăng|Hạn mức, cache,<br>chỉ gọi khi cần, log<br>chi phí theo tính<br>năng|PM|
|R-<br>07|Yêu cầu lưu trữ<br>dữ liệu trong<br>nước phát sinh<br>muộn|Trung bình|Ý kiến pháp lý<br>đến sau khi đã<br>build|Quyết định hạ tầng<br>ở S0; giữ kiến trúc<br>có thể self-host<br>bằng Docker|Chủ đầu tư|
|R-<br>08|Rò rỉ dữ liệu cá<br>nhân (ảnh giấy tờ,<br>SĐT)|Thấp về khả<br>năng,**Cao**<br>về tác động|Truy cập bất<br>thường trong<br>audit|RLS + mã hóa +<br>phân quyền chặt +<br>audit truy cập tệp<br>nhạy cảm|SYS_ADMIN|
|R-<br>09|Phạm vi phình to<br>trong lúc phát<br>triển|Cao|Yêu cầu mới mỗi<br>tuần|Đóng băng phạm vi<br>MVP sau S0; mọi<br>thay đổi vào<br>backlog Phase 2 có<br>đánh đổi rõ|PM|
|R-<br>10|Phụ thuộc nhà<br>cung cấp OTP<br>(chậm duyệt mẫu,<br>chi phí)|Trung bình|Chưa có tài<br>khoản khi đến<br>S1|Chuẩn bị từ S0;<br>thiết kế lớp trừu<br>tượng để đổi nhà<br>cung cấp; dự phòng<br>đăng nhập bằng<br>email|Dev lead|
|R-<br>11|Nhân sự vận<br>hành ít, không đủ<br>người dùng hệ<br>thống đúng cách|Trung bình|Thao tác sai<br>nhiều trong UAT|Thiết kế đơn giản<br>hóa cho vai trò kiêm<br>nhiệm; cho phép<br>gộp vai trò có kiểm<br>soát|PM|
|R-<br>12|Tranh chấp hoàn<br>cọc dù đã có hệ<br>thống|Trung bình|Số vụDISPUTED<br>tăng|Bắt buộc biên bản<br>kiểm tra có ảnh;<br>bảng kê khấu trừ<br>gửi cư dân trước<br>khi chi|BQL|



## **21. Giả định và câu hỏi cần xác nhận** 

### **21.1 Giả định đang dùng để viết PRD này** 

Nếu một giả định sai, phần đặc tả liên quan cần sửa. Tôi liệt kê kèm ảnh hưởng để dễ rà. 

|**ID**|**Giả định v0.1**|**Kết quả sau phản hồi**|**Hành động**|
|---|---|---|---|
|A-01|Chu kỳ tháng,<br>cùng ngày chốt kỳ<br>toàn tòa|**Sai một nửa**: theo<br>tháng, nhưng ngày<br>thanh toán theo từng<br>khách|Đã sửa: FR-066,<br>contract.billing_day|
|A-02|Điện/nước theo<br>chỉ số, có thể bậc<br>thang|**Đúng phần chỉ số, bỏ**<br>**bậc thang**: đơn giá cố<br>định theo đồng hồ riêng|Đã sửa: bỏtariff.tierskhỏi MVP|
|A-03|Thanh toán thủ<br>công ở MVP|**Đúng**— chuyển khoản<br>vào tài khoản cá nhân,<br>xác nhận thủ công|Giữ nguyên; thêm<br>organization.payment_account|
|A-04|Một hợp đồng hiệu<br>lực/căn hộ|**Đúng hiện tại**, có thể<br>phát sinh hợp đồng<br>chung|Giữ ràng buộc, thiết kế cho phép nới<br>sau|
|A-05|Ký giấy, lưu bản<br>scan|**Đúng**, hợp đồng điện tử<br>để sau theo quy định<br>sắp tới|Giữ nguyên|
|A-06|MVP chỉ quản lý<br>cọc của hợp đồng<br>đã ký|**Sai**: phát sinh cả cọc giữ<br>chỗ lẫn cọc khi ký ngay|Đã sửa: FR-067 vào MVP + vai trò<br>PROSPECT|
|A-07|Thông báo trong<br>ứng dụng + email,<br>SMS chỉ cho OTP|**Gần đúng**: kênh chính<br>thực tế là nhóm Zalo<br>(tòa + từng phòng)|Đã sửa: FR-069; Zalo OA/ZNS xem<br>xét Phase 2|
|A-08|Một chủ đầu tư,<br>một tổ chức|**Sai**: dự kiến 5–7 tòa, có<br>thể nhiều chủ sở hữu|Đã sửa: FR-070, thêmowner|
|A-09|Chưa cần hóa đơn<br>điện tử|**Đúng hiện tại**, nhưng<br>chắc chắn sẽ cần|Đã sửa: FR-073 giữ sẵn dữ liệu|
|A-10|Được dùng cloud<br>nước ngoài|**Sai**: máy chủ phải đặt tại<br>Việt Nam|Đã sửa: mục 14 đổi kiến trúc triển khai|



|A-11|Chỉ tiếng Việt ở<br>MVP|Chưa được hỏi lại|Giữ giả định|
|---|---|---|---|
|A-12|Nhân sự ít, phải<br>nới quy tắc người<br>lập ≠ người duyệt|**Sai**: có 2 người phê<br>duyệt riêng|Đã sửa: bật four-eyes mặc định|
|**A-13**<br>**(mới)**|–|Có nhân sự phụ trách<br>quảng cáo/cho thuê|Đề xuất FR-071 quản lý tin đăng, ưu<br>tiên P1|
|**A-14**<br>**(mới)**|–|Thanh toán cho nhà<br>cung cấp theo hợp<br>đồng/đơn hàng|FR-072, cần xác nhận phạm vi|
|**A-15**<br>**(mới)**|–|Dịch vụ chung tính theo<br>người hoặc theo phòng|Cần chốt cách tính cụ thể trước S3|



### **21.2 Những điều tôi không biết và không suy đoán** 

- Số liệu vận hành thực tế: giá thuê, tỷ lệ lấp đầy, doanh thu, số sự cố/tháng, tỷ lệ chậm trả. ● Quy chế nội bộ hiện hành của tòa nhà và các mẫu biểu đang dùng. 

- Ngân sách và thời hạn mong muốn của chủ đầu tư. 

- Năng lực và quy mô đội phát triển sẽ thực hiện. 

- Điều khoản hiện hành của nhà cung cấp mô hình AI về lưu trữ/huấn luyện dữ liệu. 

- Nghĩa vụ pháp lý cụ thể áp dụng cho mô hình chung cư mini cho thuê tại địa phương triển khai. 

Các mục trên được để trống hoặc đánh dấu [CẦN XÁC NHẬN] thay vì điền giá trị phỏng đoán. 

## **22. Ma trận traceability** 

Liên kết mục tiêu → module → yêu cầu chức năng → user story → tiêu chí nghiệm thu. Dùng để kiểm tra không có mục tiêu nào không được cài đặt, và không có chức năng nào không phục vụ mục tiêu. 

|**Mục tiêu**|**Module**|**FR**|**US**|**AC**|**KPI đo**|
|---|---|---|---|---|---|
|G1 Số hóa tập|M03,|FR-007..FR-014,|US-008,|AC-009.1,|% dữ liệu|
|trung|M04,<br>M05|FR-020, FR-021|US-009|AC-009.2|đã số hóa|
|G2 Giảm thời gian|M08,|FR-030..FR-035|US-014,|AC-015.1..A|Giờ/kỳ của|
|lập hóa đơn|M09||US-015|C-015.3|kế toán|



|G3 Minh bạch công<br>nợ|M09,<br>M10|FR-036..FR-040|US-003,<br>US-016|AC-003.1,<br>AC-016.1|DSO, %<br>quá hạn|
|---|---|---|---|---|---|
|G4 Self-service cư<br>dân|M02,<br>M07,<br>M11,<br>M13|FR-001, FR-012,<br>FR-019, FR-027,<br>FR-042, FR-053|US-001..<br>US-007|AC-001.1..A<br>C-006.1|% cư dân<br>đăng<br>nhập/tháng|
|G5 Chất lượng xử<br>lý sự cố|M11,<br>M12|FR-042..FR-052|US-004,<br>US-011,<br>US-013|AC-004.1,<br>AC-004.2,<br>AC-011.1|% đúng<br>SLA, điểm<br>đánh giá|
|G6 Giảm nhập liệu<br>nhờ AI|M15|FR-059, FR-060,<br>AI-01..AI-05|US-012,<br>US-014|AC-011.2,<br>AC-014.1,<br>AC-014.2|% trường<br>AI được<br>chấp nhận|
|G7 Giữ chân cư<br>dân|M05,<br>M13|FR-015, FR-018,<br>FR-019, FR-056|US-006,<br>US-010|AC-006.1,<br>AC-010.1|Tỷ lệ gia<br>hạn|
|G8 Sẵn sàng mở<br>rộng|M01,<br>M03|FR-004, FR-007,<br>FR-009|US-008,<br>US-019|AC-019.1|Thời gian<br>khởi tạo tòa<br>mới|
|Nền tảng kiểm soát<br>(áp dụng cho mọi<br>mục tiêu)|M01|FR-005, FR-006|US-019,<br>US-020|AC-019.1,<br>AC-020.1|Độ phủ<br>audit|



**Kiểm tra ngược:** các FR không xuất hiện trong bảng trên (FR-016, FR-017, FR-022..FR-026, FR-029, FR-041, FR-054, FR-055, FR-057, FR-058, FR-061..FR-063) phục vụ tính toàn vẹn nghiệp vụ hoặc thuộc Phase 2; nhóm cọc (FR-022..FR-026) gắn với G1 và G3 qua US-017/AC-017.x và cần được đưa vào bảng khi chốt PRD nếu chủ đầu tư coi "minh bạch cọc" là mục tiêu riêng. 

## **23. Câu hỏi còn mở sau vòng phản hồi thứ nhất** 

Chủ đầu tư đã trả lời 20 câu hỏi vòng 1 ngày 18/09/2026; kết quả đã được đưa vào các mục trên. Danh sách dưới đây là những điểm còn thiếu hoặc mới phát sinh. 

Vòng 1 đã trả lời xong 20 câu; dưới đây là các câu **còn mở sau khi cập nhật v0.2** , xếp theo mức độ chặn. 

#### **A. Chặn logic tính tiền — cần trước giai đoạn S3** 

1. Pro-rata chia theo số ngày thực tế của tháng (28–31) hay theo mẫu số cố định 30 ngày? Hai cách cho ra số tiền khác nhau và sẽ gây tranh cãi với khách nếu không thống nhất. 

2. "Làm tròn -3" là làm tròn **đến hàng nghìn gần nhất** , hay luôn làm tròn lên/xuống? Áp dụng cho từng dòng phí hay chỉ cho tổng hóa đơn? 

3. Phí phạt 100.000 ₫/ngày có **trần tối đa** không? Tính đến ngày trả đủ hay dừng ở một mốc? Nếu khách trả một phần thì có tiếp tục phạt trên phần còn lại không? 

4. Dịch vụ chung tính **theo người** hay **theo phòng** — và nếu theo người thì số người thay đổi giữa kỳ xử lý thế nào? 

5. Đơn giá điện, nước hiện hành cụ thể là bao nhiêu, và có thay đổi theo từng hợp đồng như các dịch vụ khác không? 

6. Khi khách **giữ chỗ rồi hủy** , chính sách là mất toàn bộ tiền giữ chỗ, mất một phần, hay hoàn lại? Hạn giữ chỗ tối đa bao nhiêu ngày? 

7. Ngoài chi phí hư hỏng, còn khoản nào được phép khấu trừ vào cọc khi trả phòng (vệ sinh, tiền điện nước kỳ cuối chưa thanh toán, phạt vi phạm hợp đồng)? 

#### **B. Chặn phạm vi — cần trước giai đoạn S2** 

8. Module **thanh toán cho nhà cung cấp** (theo hợp đồng/đơn hàng) có thuộc phạm vi hệ thống này không, hay do kế toán quản lý riêng? Nếu có thì đây là mảng nghiệp vụ mới cần đặc tả riêng. 

9. Người phụ trách báo cáo được xem những gì — chỉ số liệu tổng hợp, hay cả thông tin cá nhân cư dân và chi tiết hợp đồng? 

10. 5–7 tòa dự kiến thuê lại: mỗi tòa khoảng bao nhiêu phòng, và có cùng một pháp nhân vận hành không? (Phần số phòng trong phản hồi đang bị bỏ trống.) 

11. Có cần theo dõi **tiền thuê phải trả cho chủ sở hữu tòa nhà** và lợi nhuận từng tòa không? Đây là câu hỏi quan trọng với mô hình thuê lại. 

12. Nhân sự quảng cáo có cần hệ thống quản lý tin đăng và nguồn khách (FR-071) không, hay vẫn làm ngoài? 

#### **C. Chặn triển khai — cần trước giai đoạn S1** 

13. Nhà cung cấp hạ tầng trong nước dự kiến là ai, và ai chịu trách nhiệm vận hành máy chủ (đội phát triển, IT nội bộ, hay thuê dịch vụ quản trị)? 

14. Yêu cầu "dữ liệu tại Việt Nam" có bao gồm cả việc **gửi dữ liệu sang API AI ở nước ngoài** không? Nếu có, tính năng AI phải thiết kế lại hoặc dùng mô hình trong nước. 

15. Kênh gửi **OTP đăng nhập** dùng gì — nhóm Zalo không dùng được cho việc này nên cần SMS hoặc Zalo OA; chi phí ai chịu? 

16. Ngân sách tổng và mốc go-live mong muốn là gì? Có kỳ thu phí cụ thể nào muốn bắt đầu chạy song song không? 

17. Ai trong 6 người vận hành chịu trách nhiệm nhập và đối chiếu dữ liệu Excel hiện có, và dữ liệu đó có đủ lịch sử hợp đồng/cọc không? 

18. Việc chuyển sang tài khoản hộ kinh doanh dự kiến khi nào — trước hay sau go-live? Điều này ảnh hưởng cách ghi nhận thu tiền. 

19. Mốc thời gian dự kiến phải bắt đầu xuất hóa đơn là khi nào, để đội chuẩn bị dữ liệu trước thay vì làm lại sau? 

20. Mức chi phí AI hằng tháng chấp nhận được (sau khi họp) và thứ tự cắt tính năng nếu vượt? 

_Tài liệu v0.2 do AI soạn dựa trên mô tả yêu cầu và phản hồi ngày 18/09/2026 của chủ đầu tư. Các con số mục tiêu, ước lượng thời gian và tham chiếu pháp lý cần được người có chuyên môn kiểm chứng trước khi dùng làm cơ sở ký kết hoặc lập ngân sách. Những chỗ phản hồi chưa rõ được giữ nguyên dưới dạng câu hỏi thay vì suy đoán._ 

