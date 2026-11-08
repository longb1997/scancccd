# Spec: Chụp CCCD 2 mặt có kiểm tra chất lượng

Status: ready-for-agent

Tham chiếu UX: video app MobiFone (màn "Chụp CCCD mặt trước/mặt sau").

## Mục tiêu

1. Nhận biết **mặt trước / mặt sau** của thẻ CCCD Việt Nam.
2. Phát hiện thẻ **bị cắt** (lọt ra ngoài khung), **bị lóa**, **bị mờ**.

Ràng buộc: không OpenCV. Chỉ `react-native-vision-camera` v5 + plugin ML Kit. Được viết native nếu cần (hiện không cần).

## Phạm vi

- Luồng: chụp mặt trước → màn kết quả (Chụp lại / Tiếp tục) → chụp mặt sau → màn kết quả.
- Demo **Android trước**. iOS sau (nitro#2052 chặn build iOS trên RN 0.88.1).
- Thẻ hỗ trợ: (c) CCCD gắn chip 2021, (d) Căn cước 2024.

Không làm: xác thực khuôn mặt, NFC, form eSIM, modal hướng dẫn, đối chiếu 2 mặt cùng thẻ, kiểm tra "quá tối", trạng thái riêng cho thẻ cũ (CMND / CCCD 2016 rơi vào thông báo chung), cắt ảnh theo viền thẻ, upload.

## Stack

- `react-native-vision-camera@5.2.4` (+ nitro-modules, nitro-image, vision-camera-worklets, react-native-worklets)
- `react-native-vision-camera-mlkit` (OCR ML Kit v2, có ROI)
- Lóa/mờ: JS worklet đọc plane Y, lưới lấy mẫu thưa trong vùng khung.
- Giữ RN 0.88.1. Gặp lỗi build/crash → dừng, báo, không tự hạ RN.

## Màn chụp

- Khoá dọc, thẻ nằm ngang trong khung hướng dẫn tỉ lệ 1.586.
- Chỉ phân tích phần ảnh trong khung. Phần thẻ ngoài khung = bị cắt.
- Flash, công tắc "Chụp tự động", nút chụp.
- Tự động: chụp khi mọi điều kiện đạt liên tục ~1s. Thủ công: nút chỉ bấm được khi đang đạt.
- Quyền camera bị từ chối: 1 dòng thông báo + nút "Mở cài đặt".
- Dòng debug (chỉ `__DEV__`): độ nét, % pixel cháy sáng, từ khoá/mốc đọc được — để chỉnh ngưỡng trên máy thật.

## Thứ tự thông báo (ưu tiên từ trên xuống)

1. Sai mặt / không thấy thẻ → "Vui lòng chụp ảnh giấy tờ mặt trước|sau"
2. Lóa → "Ảnh bị lóa" (chỉ khi đã nhận ra ≥1 từ khoá thẻ)
3. Mờ → "Ảnh bị mờ" (chỉ khi đã nhận ra ≥1 từ khoá thẻ)
4. Quá nhỏ → "Di chuyển gần hơn"
5. Thiếu mốc → "Đưa toàn bộ giấy tờ vào khung"
6. Đạt, chờ ổn định → "Giữ cố định"

Lóa/mờ đứng trước cắt vì chúng làm OCR mất chữ, sẽ bị báo nhầm thành "bị cắt".

## Nhận diện mặt

Chuẩn hoá chữ OCR: viết hoa, bỏ dấu, Đ→D (ML Kit đọc dấu tiếng Việt rất sai).

1. **Mặt sau**: có dòng giống MRZ (`IDVNM` hoặc chuỗi `<<<`) hoặc từ khoá mặt sau.
2. **Mặt trước**: không có MRZ và có từ khoá mặt trước. `CONG DAN`/`CITIZEN` → (c); `DINH DANH`/`CHU DEM` → (d).
3. Không khớp → không có thẻ.

Mẫu (c)/(d) chỉ dùng nội bộ để chọn mốc.

## Mốc chống cắt

| | Mốc trên | Mốc dưới | Trái/phải |
|---|---|---|---|
| (c) trước | `CONG HOA XA HOI CHU NGHIA VIET NAM` (đọc đủ tới VIET NAM) | `CO GIA TRI DEN` (dưới trái) | mốc dưới nằm bên trái; header đủ = phải |
| (c) sau | `DAC DIEM NHAN DANG` | MRZ | MRZ đủ 30 ký tự |
| (d) trước | `CONG HOA XA HOI CHU NGHIA VIET NAM` | `QUOC TICH` | trái: ước lượng từ vị trí/độ rộng header |
| (d) sau | `NOI CU TRU` | MRZ | MRZ đủ 30 ký tự |

"Quá nhỏ": độ rộng header (trước) / MRZ (sau) so với độ rộng khung < ngưỡng.

Hạn chế đã biết: thẻ xoay nghiêng mạnh có thể lọt 1 góc mà không phát hiện.

## Ảnh đầu ra

Ảnh nguyên khung, lưu tạm trên máy, hiện ở màn kết quả. Không xử lý thêm.

## Rủi ro

- VisionCamera v5 chưa xác nhận chạy RN 0.88.
- nitro#1705: crash ngẫu nhiên khi JS + worklet cùng gọi Nitro → mỗi frame 1 luồng phân tích, chỉ đẩy kết quả cuối về UI.
- Ngưỡng lóa/mờ/quá nhỏ cần chỉnh trên máy thật với thẻ thật.
