# OnLuyen Auto Solver Ultra v8.0 (Deep Reasoning Edition)

Phiên bản đại tu toàn diện về khả năng đọc hiểu đề thi và suy luận AI cho `app.onluyen.vn`.

## Các nâng cấp cốt lõi so với bản v6.1
1. **Không còn bóp nghẹt suy nghĩ AI**: Mở rộng `maxOutputTokens: 8192` + `thinkingLevel: "HIGH"` trên `gemini-3-flash-preview` và dự phòng `gemini-3.1-flash-lite`, loại bỏ model treo timeout.
2. **Đọc chuẩn mọi định dạng đề học thuật (`dom_extractor.js`)**:
   - Chuyển MathML sang LaTeX (`\frac`, `\sqrt`, `\vec`, ma trận) cho cả KaTeX và MathJax mà không lặp chữ.
   - Bảo tồn và gộp chuẩn các đoạn gạch chân Tiếng Anh `[GẠCH_CHÂN: ...]` (kể cả khi Word tách nhỏ `<u>e</u><u>a</u>`).
   - Chuyển bảng số liệu / bảng biến thiên sang Markdown `| ... |`.
   - Tự động thu thập **Đoạn văn ngữ cảnh cột trái** trong bài Đọc hiểu và bỏ giới hạn cứng `r.left > 160`.
3. **Chống lệch dòng Đúng/Sai & bắt nhầm trắc nghiệm**:
   - Loại bỏ hàng tiêu đề `<thead>`/`<th>` và ánh xạ đúng cột Đúng/Sai trước khi gán nút `a, b, c, d`.
   - Loại bỏ chữ `<b>A</b>` nằm giữa đề bài khi tìm `A, B, C, D`, hỗ trợ cả 1 cột dọc, lưới 2x2 và hàng ngang.
   - Nhận diện trạng thái đang chọn bằng so sánh tương đối trong nhóm thay vì đoán màu xám cố định.
4. **Kiến trúc Phản biện Độc lập 2 Lớp (Adversarial Auditor Pass)**:
   - Chế độ `smart` tự gọi Giám khảo Lớp 2 khi độ tin cậy `< 88%`, khi câu tự đánh dấu phân vân, hoặc khi bấm giải lại (`Alt + R`).
   - Chế độ `ultra` kiểm chứng 2 lớp cho toàn bộ câu tính toán, phủ định, Đúng/Sai và Trả lời ngắn.
   - Hỗ trợ điền từ/cụm từ Tiếng Anh có khoảng trắng ở `SHORT_ANSWER` (`answerKind: "TEXT"`).
5. **An toàn chụp ảnh & Chống lặp đáp án sai**:
   - Chỉ chụp màn hình khi tab OnLuyen đang active.
   - Cộng dồn danh sách tất cả đáp án đã bị từ chối khi dùng `Alt + R`.

## Cách cài đặt
1. Mở Chrome/Edge -> vào `chrome://extensions/`.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển).
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục `D:\OnLuyen_AutoSolver_Ultra`.
4. Phím tắt: `Alt + S` (Bật/Tắt) | `Alt + R` (Giải lại câu đang mở và tránh đáp án sai cũ).
