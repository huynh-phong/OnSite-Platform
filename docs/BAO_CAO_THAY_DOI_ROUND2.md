# Báo cáo thay đổi: cải thiện MVP cho Round 2

**Team:** PYRAMID. **Ngày:** 5/11/2026. **Dựa trên commit:** `921fd13`.

Tài liệu này giúp cả nhóm nắm nhanh những gì đã thay đổi trong code, vì sao thay đổi, và những việc còn phải làm trước hạn nộp (22:00 ngày 9/11). Chi tiết kỹ thuật bằng tiếng Anh nằm ở [ROUND2_IMPROVEMENTS.md](ROUND2_IMPROVEMENTS.md).

---

## 1. Tóm tắt trong một đoạn

MVP ở Phase 3 đã chạy ổn, nhưng còn **4 chỗ chưa làm hoặc mới làm một nửa** so với những gì slide Round 1 đã hứa. Giám khảo Round 2 chấm "technical reasoning aligned with Round 1", nên đây là những chỗ dễ bị hỏi nhất. Đợt này nhóm đã bổ sung đủ 4 chỗ đó, sửa thêm 3 lỗi nhỏ, và viết thêm 43 test. Toàn bộ 492 test unit/integration và 29/29 test E2E trình duyệt đều pass. Kiến trúc giữ nguyên: vẫn 4 service và 3 database, không thêm service nào.

## 2. Bốn cải tiến chính

| # | Round 1 đã hứa | Trước đây | Bây giờ |
|---|---|---|---|
| 1 | 3 KPI go/no-go: **OTIF +3 pp, status calls −30%, adoption >90%** (slide 2, 9) | Central chỉ có OTIF | Central có thẻ **"Pilot go/no-go KPIs (Round 1)"** hiển thị đủ 3 KPI |
| 2 | **Risk 3:** node mất heartbeat quá 5 phút thì bị cô lập và đơn được chuyển sang node khác (slide 10) | Chỉ xử lý khi *toàn bộ* hệ thống nguồn sập | **Circuit breaker cho từng store** |
| 3 | Phát hiện thiếu hàng ngay lúc đặt và đưa ra phương án cho khách | Đơn `NEEDS_REVIEW` dừng hẳn, khách phải đặt lại từ đầu (C6 còn PARTIAL) | Nút **"Accept the 90 available"** |
| 4 | AI đọc email hoặc báo giá của nhà thầu thành đơn nháp (slide 8) | AI chỉ chuẩn hoá dữ liệu nguồn | **AI đọc tin nhắn dán vào thành đơn nháp**, khách kiểm tra từng dòng |

### 2.1. KPI go/no-go trên Central

- **OTIF:** giữ nguyên cách tính, vẫn ghi rõ là dữ liệu mô phỏng.
- **Status calls −30%:** đo bằng *số đơn mà khách được cảnh báo trễ trước khi họ phải gọi hỏi*. Đây là số đếm, nhóm **không** tuyên bố đã giảm được bao nhiêu cuộc gọi.
- **Adoption >90%:** đo bằng *số task được node duyệt hoặc từ chối trong OnSite* chia cho *(số đó cộng số task quá hạn mà không ai xử lý)*. Dưới 90% thì thẻ chuyển sang màu cảnh báo.
- Tất cả được tính ở Central từ các sự kiện đã nhận. Sự kiện gửi lặp lại chỉ được đếm một lần, và Local SE không phải gửi thêm dữ liệu nào.
- Task đã được duyệt nhưng hết hạn vì node kia không duyệt kịp thì **không** bị tính là bỏ lỡ. Task do circuit breaker tự chuyển đi thì không tính vào phía nào.

### 2.2. Circuit breaker theo từng store

- Trong simulator, mỗi store có "server" riêng gửi heartbeat. Mục **Demo tools → Store server link** có nút **Drop link** và **Restore** để mô phỏng một store mất mạng.
- Cứ 10 giây, Local SE đọc heartbeat một lần. Store nào im lặng lâu hơn `NODE_HEARTBEAT_TIMEOUT_SECONDS` thì bị coi là offline. Mặc định là 300 giây, đúng 5 phút như Round 1. Riêng `.env` demo đặt **60 giây** để quay video kịp, nên **phải nói rõ điều này trong video**.
- Store offline sẽ không nhận đơn mới. Phần đơn **đang chờ duyệt** ở store đó được tự chuyển sang node khác, dùng đúng luồng như khi nhân viên bấm Reject. ETA được tính lại, và nếu trễ thì khách nhận cảnh báo.
- Phần đơn **đã được duyệt** thì giữ nguyên, vì người ở store đã cam kết số hàng đó.
- Trang **Operations → Inventory by node** hiển thị "Offline: isolated".
- **Quyết định thiết kế quan trọng:** thời gian im lặng được đo theo những gì hệ thống nguồn ghi nhận, chứ không theo đồng hồ của Local SE. Nhờ vậy, khi cả hệ thống nguồn sập, các store không bị đánh dấu offline hàng loạt.

### 2.3. Chấp nhận phần còn hàng (S2)

- Khách đặt 100 bao nhưng chỉ còn 90 thì màn hình hiện nút **Accept the 90 available**.
- Server **kiểm tra lại tồn kho tại thời điểm bấm** (không dùng con số cũ), giảm số lượng từng dòng, vẫn lưu số gốc 100 trong cột `requested_quantity` mới, rồi giữ hàng và chờ từng node duyệt như bình thường.
- In-full (của OTIF) được tính theo số lượng khách đã đồng ý.
- Server từ chối trong các trường hợp:
  - không còn hàng nào (`NOTHING_AVAILABLE`);
  - có một dòng hết sạch hàng (`LINE_UNAVAILABLE`), vì bỏ hẳn một dòng thì nên đặt đơn mới;
  - đơn đang review vì lỗi hệ thống nguồn chứ không phải vì thiếu hàng.
- State machine chỉ thêm đúng một chuyển trạng thái: `NEEDS_REVIEW → ALLOCATING`.

### 2.4. AI đọc tin nhắn đặt hàng

Ở trang **Catalog & order** có thêm ô **"Paste an order message"**. Khách dán email vào, bấm **Read with AI**, xem bản nháp rồi mới thêm vào giỏ.

**Những gì AI được làm và không được làm:**
- AI chỉ chọn sản phẩm trong catalog và chép số lượng như trong text.
- AI **không** quyết định tồn kho, giá, định tuyến hay ETA, **không** quy đổi đơn vị, và **không** tạo đơn.

**Các lớp chặn nằm trong code (deterministic):**
1. Xoá email, số điện thoại và số định danh cá nhân **trước khi** gửi cho AI.
2. Mỗi dòng phải trích **nguyên văn** một đoạn trong text. Dòng nào trích sai thì bị loại, để chống AI bịa ra dòng.
3. Số lượng phải xuất hiện trong chính đoạn trích, là số nguyên, từ 1 đến 1.000.000.
4. Sản phẩm không có trong catalog thì khách phải tự chọn.
5. Text ghi "pall" mà sản phẩm bán theo tấm thì dòng đó bị đánh dấu, không tự quy đổi. "st" (cái) được tính 1:1 với mọi đơn vị đếm được, giống quy tắc tồn kho đang có.
6. Độ tin cậy dưới 0.7 (ngưỡng của Round 1) thì bị đánh dấu.
7. **Chỉ những dòng không có cảnh báo mới được tick sẵn.** Khách phải tự tick những dòng còn lại.
8. AI lỗi, quá thời gian hoặc trả về dữ liệu vô nghĩa thì màn hình hướng khách quay về chọn từ catalog.

**Điểm cần giải thích trong video:** Round 1 nói match trên 95% sẽ tự động gộp. Trong MVP, **mọi gợi ý của AI đều chờ người duyệt**. Đây là lựa chọn có chủ đích, vì chưa đo được độ chính xác của AI trên dữ liệu thật.

Provider mock (khi `LLM_PROVIDER=mock`) đọc bằng quy tắc từ khoá kèm một bảng từ tiếng Thuỵ Điển nhỏ, nên demo được mà không cần API key. Gemini và Anthropic đã có code nhưng **chưa được thử thật** cho tính năng này.

## 3. Ba sửa nhỏ

| Sửa | Ảnh hưởng |
|---|---|
| Ngày giao **trong quá khứ** (lệch quá 5 phút) bị từ chối với mã `DELIVERY_IN_PAST` | **Thay đổi hành vi.** Trước đây hệ thống nhận đơn và chỉ gắn cờ "at risk" |
| Bỏ option `requestIdLogLabel` đã lỗi thời của Fastify | Lúc khởi động không còn cảnh báo `FSTDEP024` |
| Nhãn "Eta changed" đổi thành "ETA changed" | Chỉ là chữ hiển thị |

## 4. Những gì đổi trong code

### API mới (Local SE)

| Method | Đường dẫn | Ai dùng | Làm gì |
|---|---|---|---|
| POST | `/api/v1/orders/parse` | customer | AI đọc text thành bản nháp. Không lưu gì, không đặt gì |
| POST | `/api/v1/orders/{id}/accept-available` | customer | Chấp nhận phần còn hàng |

### Simulator

- `POST /legacy/admin/stores/{id}/link` để bật hoặc tắt link của một store.
- `GET /legacy/stores` trả thêm hai trường `link_up` và `last_heartbeat_at`.
- `POST /ui-api/stores/{id}/link` dùng cho dashboard.

### Central

- `GET /dashboard` trả thêm khối `pilot_kpis`.

### Migration mới

Cần reset database để áp dụng (xem mục 6).

| App | File | Nội dung |
|---|---|---|
| Local SE | `003_node_heartbeats.sql` | `stores.last_heartbeat_at`, `stores.heartbeat_checked_at` |
| Local SE | `004_accept_available.sql` | `order_items.requested_quantity` |
| Simulator | `003_node_heartbeats.sql` | `stores.link_down_since` |

### Cấu hình mới

| Biến | Mặc định | Trong `.env.example` |
|---|---|---|
| `NODE_HEARTBEAT_TIMEOUT_SECONDS` | 300 | 60 (cho demo) |
| `NODE_HEARTBEAT_CHECK_SECONDS` | 10 | — |

`compose.yaml` đã truyền thêm biến này cho `onsite-local-se`.

### File mới

- `apps/onsite-local-se/src/modules/nodes/node-health.service.ts`: circuit breaker.
- `apps/onsite-local-se/src/modules/intake/`: bộ đọc đơn AI, gồm guardrail, service và route.
- `apps/web/src/web/orderReader.tsx`: giao diện ô dán tin nhắn.
- 4 file test Local SE mới (`node-health`, `accept-available`, `intake`, `order-draft`) và 1 file E2E mới `h-round2.spec.ts`.
- `docs/ROUND2_IMPROVEMENTS.md` và tài liệu này.

### File sửa chính

- **Local SE:**
  - `llm.ts`: thêm `parseOrder` cho mock, Gemini và Anthropic.
  - `allocation.service.ts`: bỏ qua node offline, thêm `availableNow`.
  - `tasks.service.ts`: tách luồng reject để dùng chung.
  - `orders.service.ts`, `state-machine.ts`, `metrics.service.ts`.
- **Central:** `dashboard.ts`.
- **Web:** `central/App.tsx`, `legacy/App.tsx`, `web/customer.tsx`, `web/admin.tsx`.
- **Tài liệu:** `README.md`, `docs/FINAL_DEMO_RUNBOOK.md`.

Tổng cộng 42 file sửa và 15 file mới, tính cả hai tài liệu này.

## 5. Kết quả kiểm thử

| Loại | Trước | Sau | Ghi chú |
|---|---|---|---|
| Local SE | 289 | **322 pass** | +33 test |
| Simulator | 54 | **57 pass** | |
| Central | 31 | **33 pass** | |
| Web | 75 | **80 pass** | |
| **Tổng unit/integration** | 449 | **492 pass, 0 fail** | Typecheck sạch cả 5 project |
| Smoke API trên stack thật | 45 | **45/45 pass** | Windows native, AI mock |
| E2E trình duyệt (Playwright) | 27 | **29/29 pass** | Chromium, Windows native, AI mock. Xem bên dưới |
| CI trên GitHub Actions (Linux) | Pass | **Pass** | Cả 2 job: test + E2E, và Docker Compose. Xem bên dưới |

**Về E2E:** đã chạy trọn 29 test, gồm 2 test mới trong `h-round2.spec.ts`, mất khoảng 3,2 phút. Stack E2E chạy trên port riêng (13000 trở lên) với database `*_e2e` dùng một lần, nên dữ liệu demo không bị ảnh hưởng.

- Lần chạy đầu tiên của đợt trước bị dừng giữa chừng vì máy (8 GB RAM) gần hết bộ nhớ khi chạy cả stack demo lẫn stack E2E. Những test fail lúc đó có lỗi `Target crashed`, không phải lỗi logic.
- Test dùng ngày `2026-01-01` làm hạn sớm, đã sửa sang "15 phút nữa theo giờ Thuỵ Điển", nay đã pass.
- E2E bắt được **1 lỗi thật** ở bộ đọc đơn mock: tin nhắn chỉ được tách ở dấu phẩy và chữ `och`, không tách ở cuối câu. Vì vậy lời chào ("Hej! Ring mig på [removed]. Vi behöver…") và ghi chú giao hàng bị dính vào dòng trích dẫn. Đã sửa trong `llm.ts`: tách thêm ở cuối câu và trích từ con số số lượng. Đã thêm 1 unit test để bắt lỗi này mà không cần trình duyệt.
- Cách chạy lại: build cả 4 app (E2E chạy bản build trong `dist`), rồi `cd apps/e2e && npx playwright test`.

**Về CI:** workflow `onsite-mvp-validation.yml` đã pass trên `main` sau khi merge, ở commit `ada9a67`, lần chạy [42042536171](https://github.com/huynh-phong/OnSite-Platform/actions/runs/42042536171). Cả 2 job đều pass:

- **Typecheck, test tự động và E2E trình duyệt** trên Linux, Node 20.
- **Dựng toàn bộ stack bằng Docker Compose** trên Linux.

Như lần CI trước, E2E chạy trên các process Node chứ không nhắm vào container. Docker trên Windows vẫn chưa được thử.

## 6. Cập nhật máy của bạn sau khi pull

```bash
scripts/init-env.sh                          # thêm NODE_HEARTBEAT_TIMEOUT_SECONDS vào .env, không đụng giá trị cũ
for app in sweden-simulator onsite-central onsite-local-se web; do (cd apps/$app && npm ci); done
ONSITE_LLM_PROVIDER=mock scripts/run-native.sh up
scripts/run-native.sh reset S1               # bắt buộc: áp dụng migration mới
```

Với Docker: `docker compose up --build -d` rồi chạy `scripts/reset-demo.sh S1`. Phần này đã pass trên Linux trong CI với code Round 2, nhưng **chưa được thử trên Windows**.

## 7. Các cảnh demo mới

Đã thêm vào `docs/FINAL_DEMO_RUNBOOK.md`, mục 4.

- **D (bổ sung):** S2 báo thiếu 10 bao, khách bấm **Accept the 90 available**, đơn chuyển sang Awaiting approval với 54 + 36.
- **H, AI đọc tin nhắn:** dán đoạn sau vào ô "Paste an order message":
  `Hej! Ring mig på 070-123 45 67. Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.`
  Kết quả mong đợi: xoá 1 số điện thoại; cement 20 được tick sẵn; gypsum bị đánh dấu "pall khác đơn vị tấm" và để khách tự sửa.
- **I, Circuit breaker:** đặt 30 bao (đơn đi Store B), bấm **Drop link** cho Store B. Khoảng 70 giây sau, đơn chuyển sang hub. Bấm **Restore** thì Store B quay lại.
- **F (bổ sung):** trên Central, chỉ vào thẻ **Pilot go/no-go KPIs (Round 1)**.

## 8. Việc còn phải làm trước 9/11

| Việc | Ai | Ghi chú |
|---|---|---|
| Thử bộ đọc đơn với Gemini thật (nếu định demo bằng AI thật) | AI | Hiện mới chạy với mock. Không được công bố độ chính xác |
| Duyệt và chỉnh 2 bản nháp PDF | Consultant | `materials/drafts/System Context Diagram (draft).pdf` và `User Journey (draft).pdf`. **Hai file này chỉ có trên máy đã làm, không nằm trong repo.** Bản HTML nguồn nằm cùng thư mục |
| Viết AI Journal theo template | Cả nhóm | Có thể ghi đợt này như một mục: dùng Claude Code để tìm khoảng trống so với Round 1 và cài đặt 4 cải tiến. Nhóm kiểm chứng bằng 43 test mới, smoke test, 29 test E2E trình duyệt, và review code |
| Tập runbook một lần có bấm giờ, rồi quay video ≤ 7 phút | Cả nhóm | Thêm đoạn "What changed since Round 1": 4 cải tiến trên, cộng lý do mọi gợi ý AI đều chờ người duyệt |
| Kiểm tra không lộ secret trong video và PDF | Cả nhóm | Không quay `.env` hay terminal in mật khẩu |

## 9. Những điều vẫn không được tuyên bố

Các giới hạn sau từ `PHASE3_FINAL_MVP_REPORT.md` mục J vẫn đúng:
- Dữ liệu là mô phỏng.
- Chưa đo độ chính xác của AI, kể cả bộ đọc đơn mới.
- Số liệu hiệu năng chỉ đo trên một laptop.
- Docker mới được kiểm chứng trên Linux CI.
- Đan Mạch và Na Uy mới chỉ ở mức thiết kế.
