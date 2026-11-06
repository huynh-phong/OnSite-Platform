**Giải thích System Context Diagram**

OnSite Local SE (Sweden MVP) - Round 2, Team PYRAMID

*Tài liệu nội bộ để cả nhóm hiểu sơ đồ, thuyết minh trong video và trả lời giám khảo. Cập nhật 05/11/2026, theo báo cáo thay đổi sau commit 8cfee5e.*

# 1. Sơ đồ này là gì và dùng để làm gì

System Context Diagram (SCD) trả lời bốn câu hỏi: hệ thống của mình nằm ở đâu, **ai và cái gì ở bên ngoài** nói chuyện với nó, nói qua đường nào, và trao đổi dữ liệu gì. SCD coi hệ thống là một hộp lớn, không đi sâu vào code bên trong. Vì vậy nó là bản đồ để giám khảo nhìn một lần là hiểu ranh giới của sản phẩm.

Yêu cầu của đề với file này: PDF tối đa 2 trang, ghi nhãn mọi thực thể và tương tác bên ngoài, và **đúng với MVP thật sự đã chạy**. Điểm cuối là điểm dễ bị trừ nhất: vẽ thứ chưa có hoặc quên thứ đã có.

## Cách đọc bản PDF

- **Trang 1** là sơ đồ. Hộp xanh lớn ở giữa là OnSite Local SE. Các hộp xung quanh là thực thể bên ngoài. Mũi tên có số là các tương tác.

- **Trang 2** là bảng giải thích cho từng số: giao thức, dữ liệu trao đổi, dữ liệu cố ý không chia sẻ, trạng thái. Dưới bảng là các quy tắc thiết kế và giả định cần nói thẳng.

## Ý nghĩa màu sắc

| **Màu**     | **Nghĩa**                                                          | **Thuộc về**                                                                   |
|-------------|--------------------------------------------------------------------|--------------------------------------------------------------------------------|
| Tím         | Người dùng thật                                                    | B2B Customer, Store/Hub Staff, SE Regional Admin, Legacy Operator, Ops Manager |
| Xanh lá     | Đã build và chạy trong MVP                                         | OnSite Local SE, OnSite Central (bản tối giản)                                 |
| Cam         | Mô phỏng: tích hợp chạy thật, nhưng dữ liệu và hệ thống là giả lập | Sweden Legacy Simulator                                                        |
| Xanh dương  | Dịch vụ bên ngoài                                                  | LLM provider                                                                   |
| Xám nét đứt | Chỉ thiết kế, chưa build                                           | OnSite Local DK / NO                                                           |

# 2. Hệ thống ở giữa: OnSite Local SE

Đây là phần mình xây. "Local" nghĩa là **phạm vi triển khai theo quốc gia**, không phải server đặt ở từng cửa hàng. Một Local SE phục vụ cả 10 cửa hàng và hub. Bên trong có 4 phần, chạy bằng Docker Compose trên localhost:

- **Web app (:3000):** một ứng dụng React, giao diện đổi theo vai trò (Customer, Staff, Admin). Chỉ gọi API, không chứa logic nghiệp vụ.

- **API (:4000):** xác thực JWT, phân quyền theo vai trò và store_id, nhận đơn chống trùng, định tuyến và tách đơn, giữ hàng, giao task cho từng điểm xuất, tính ETA và cảnh báo AT_RISK, nút "Accept the available", bộ đọc đơn bằng AI. Toàn bộ quyết định về tồn kho, giá, định tuyến, ETA là quy tắc tất định, AI không tham gia.

- **Workers nền:** đồng bộ tồn kho và sản phẩm mỗi 10 giây, chuẩn hóa dữ liệu bằng AI có hàng chờ duyệt, circuit breaker theo store, nhả giữ hàng hết hạn, theo dõi ETA, gửi sự kiện lên Central.

- **se-db (PostgreSQL):** dữ liệu chỉ của Sweden. Trường liên hệ và địa chỉ được mã hóa AES-256-GCM.

Hộp nét đứt "Out of scope" ở đáy ghi những gì **không** làm: thanh toán, hóa đơn thuế, ERP/WMS/TMS thật, GPS/SMS, routing xuyên biên giới. Phiếu xử lý và xác nhận đơn không phải hóa đơn thuế.

# 3. Các thực thể bên ngoài

| **Thực thể**              | **Là ai**                                                         | **Làm gì với hệ thống**                                                                                             | **Trạng thái**       |
|---------------------------|-------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|----------------------|
| B2B Customer              | Site manager của công ty xây dựng                                 | Xem catalog, đặt đơn, dán email cho AI đọc thành bản nháp, chấp nhận phần còn hàng, theo dõi đơn, nhận cảnh báo trễ | Chạy thật            |
| Store / Hub Staff         | Nhân viên cửa hàng A-J và Hub SE-01                               | Duyệt hoặc từ chối task của chính cửa hàng mình, xuất hàng, xác nhận giao, duyệt đề xuất chuẩn hóa của AI           | Chạy thật            |
| SE Regional Admin         | Quản lý vùng / người vận hành demo                                | Xem tồn theo node (có trạng thái "Offline: isolated"), health, metrics, tham số                                     | Chạy thật            |
| Sweden Legacy Simulator   | Giả lập ERP/WMS/POS/TMS của Company A                             | Nguồn sự thật về tồn kho vật lý, nhận lệnh giữ/chốt/hủy hàng, phát heartbeat từng store                             | Mô phỏng             |
| Legacy Operator           | Người dùng giao diện hệ thống cũ                                  | Bấm Drop / Restore link của một store để mô phỏng mất mạng; xem tồn và đơn theo kiểu cũ                             | Mô phỏng             |
| External LLM Provider     | Dịch vụ AI bên ngoài (mặc định mock; có code Gemini và Anthropic) | Đề xuất chuẩn hóa giá trị lạ và đọc tin nhắn đặt hàng thành bản nháp                                                | Dịch vụ ngoài        |
| OnSite Central            | Lớp tổng hợp đa quốc gia, bản tối giản                            | Nhận sự kiện đã lọc, tính KPI go/no-go, hiển thị độ trễ đồng bộ. Không giữ khóa của SE, không sửa được đơn SE       | Chạy thật (tối giản) |
| Multi-country Ops Manager | Quản lý vận hành nhiều nước                                       | Chỉ xem dashboard của Central                                                                                       | Chạy thật            |
| OnSite Local DK / NO      | Hai Local tương lai                                               | Dùng cùng hợp đồng sự kiện, DB và khóa riêng                                                                        | Chỉ thiết kế         |

# 4. Mười tương tác trên sơ đồ

| **\#** | **Luồng**                       | **Điểm cần nhớ**                                                                                                                                                                                                                                                                                                                                                                                              |
|--------|---------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1      | Customer \<-\> Local SE         | HTTPS REST có JWT. Đặt đơn bắt buộc có Idempotency-Key nên gửi lại không sinh đơn trùng. Có API đọc tin nhắn thành bản nháp (không lưu gì) và API chấp nhận phần còn hàng. Ngày giao trong quá khứ bị từ chối (DELIVERY_IN_PAST).                                                                                                                                                                             |
| 2      | Staff \<-\> Local SE            | REST cộng SSE. store_id được kiểm tra ở server, nhân viên cửa hàng B không thao tác được task của hub (403 và ghi audit). SSE chỉ là tín hiệu, dữ liệu chuẩn luôn đọc bằng REST.                                                                                                                                                                                                                              |
| 3      | Admin \<-\> Local SE            | Health, metrics, tham số, bật/tắt connector. Không ghi được dữ liệu nước khác.                                                                                                                                                                                                                                                                                                                                |
| 4      | Simulator -\> Local SE          | Local kéo dữ liệu mỗi 10 giây qua HTTP API: danh sách store kèm link_up và last_heartbeat_at, sản phẩm, tồn kho theo delta. Không đọc trực tiếp database của simulator. Dữ liệu cũ hơn 60 giây thì không dùng để cam kết.                                                                                                                                                                                     |
| 5      | Local SE -\> Simulator          | Lệnh giữ hàng (nguyên tử, hết hạn sau 30 phút), chốt xuất, hủy giữ. Không gửi thông tin khách. Giữ hàng nguyên tử chỉ được chứng minh trong môi trường mô phỏng.                                                                                                                                                                                                                                              |
| 6      | Local SE \<-\> LLM              | Hai việc: (A) chuẩn hóa giá trị nguồn lạ, (B) đọc tin nhắn đặt hàng. Email, số điện thoại, số định danh bị xóa bằng code trước khi gửi; không gửi giá hay tồn kho. Phản hồi phải qua kiểm tra: trích nguyên văn, số lượng là số nguyên 1 đến 1.000.000, độ tin cậy dưới 0.7 bị đánh dấu, lệch đơn vị (pallet với tấm) bị đánh dấu. Chỉ dòng không có cảnh báo mới được tick sẵn. AI không bao giờ tự tạo đơn. |
| 7      | Local SE \<-\> Central          | Bất đồng bộ qua outbox, giao ít nhất một lần, Central chống trùng theo event_id. Chỉ gửi dữ liệu đã lọc: không tên, liên hệ, địa chỉ. Central tắt thì Local vẫn nhận đơn, sự kiện chờ rồi gửi bù.                                                                                                                                                                                                             |
| 8      | Ops Manager \<-\> Central       | Dashboard chỉ đọc, gồm thẻ "Pilot go/no-go KPIs": OTIF, số đơn được cảnh báo trước khi khách phải hỏi, tỷ lệ adoption.                                                                                                                                                                                                                                                                                        |
| 9      | Local DK/NO -\> Central         | Nét đứt: thiết kế, chưa build.                                                                                                                                                                                                                                                                                                                                                                                |
| 10     | Legacy Operator \<-\> Simulator | Giao diện cũ cố ý giữ vẻ lỗi thời để so sánh trước và sau OnSite. Demo dùng timeout heartbeat 60 giây (mặc định Round 1 là 300 giây).                                                                                                                                                                                                                                                                         |

# 5. Bốn cải tiến mới nằm ở đâu trên sơ đồ

| **Cải tiến**                  | **Thấy ở đâu**                                                                               | **Nên nói gì**                                                                                                                                                                                                                         |
|-------------------------------|----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Circuit breaker theo store    | Chip "Node health" trong workers, luồng 4 (link_up, heartbeat), luồng 10, đoạn mô tả workers | Store im lặng quá 300 giây (demo 60 giây) bị cô lập; đơn đang chờ duyệt tự chuyển node khác; đơn đã duyệt giữ nguyên. Thời gian im lặng đo theo thời gian nguồn ghi nhận nên nguồn sập toàn bộ không làm mọi store bị đánh dấu offline |
| Nút "Accept the 90 available" | Chip "Accept the available (S2)" trong API, luồng 1, trạng thái NEEDS_REVIEW \> ALLOCATING   | Hệ thống phát hiện thiếu hàng ngay lúc đặt và đưa phương án cho khách; server kiểm tra lại tồn kho lúc bấm, giữ số gốc 100 trong requested_quantity                                                                                    |
| AI đọc tin nhắn đặt hàng      | Chip "AI order reader + guardrails", luồng 1 và 6                                            | AI chỉ chọn sản phẩm trong catalog và chép số lượng. Khách kiểm tra từng dòng. Mọi gợi ý đều chờ người xác nhận                                                                                                                        |
| KPI go/no-go trên Central     | Mô tả hộp Central, luồng 8                                                                   | Ba KPI của Round 1 (OTIF, cuộc gọi hỏi trạng thái, adoption) đều có trên dashboard. Đây là số đếm từ dữ liệu mô phỏng, không phải kết quả đo thật                                                                                      |

# 6. Ranh giới giữa thật, mô phỏng và thiết kế

Đây là phần giám khảo đọc kỹ nhất. Cả nhóm nên thuộc:

- **Thật:** Local SE (API, DB, worker, giao diện), Central tối giản, tích hợp qua HTTP API, outbox và chống trùng, kiểm tra quyền, luồng đơn đầy đủ.

- **Mô phỏng:** Sweden Legacy Simulator và mọi số liệu kinh doanh. Khoảng cách, tốc độ xe, thời gian chuẩn bị, khung giờ xe chạy và timeout heartbeat 60 giây của demo là tham số cấu hình, không phải số đo.

- **Chỉ thiết kế:** Local DK/NO, KMS theo quốc gia, ERP/WMS thật. Nếu ERP thật chỉ cho đọc thì OnSite không được tuyên bố đã giữ hàng.

- **Chưa chứng minh:** độ chính xác của AI (chưa đo, kể cả bộ đọc đơn), Gemini và Anthropic cho tính năng đọc đơn (mới chạy với mock), Docker trên Windows (mới kiểm trên Linux CI), các KPI Round 1 (là mục tiêu thí điểm, chưa phải kết quả).

