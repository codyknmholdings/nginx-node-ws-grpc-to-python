# KNM Voicebot WebSocket Server

## 1. Tổng quan (Overview)

Dự án này triển khai một **WebSocket Server** đóng vai trò trung gian (middleware) giữa Client (ví dụ: trình duyệt, ứng dụng mobile, hoặc tổng đài) và **AI Service**. Hệ thống được thiết kế để xử lý luồng âm thanh thời gian thực (real-time audio streaming) cho các ứng dụng Voicebot.

### Kiến trúc hệ thống (System Architecture)

```text
+------------------------+       WebSocket (8kHz)       +-----------------------+
| Client / Browser / PBX | ---------------------------> |  Nginx Load Balancer  |
+------------------------+                              +-----------------------+
                                                                    |
                                                                    | WebSocket
                                                                    v
                                                        +-----------------------+
                                                        |     Node.js Server    |
                                                        |   (Audio Resampling)  |
                                                        +-----------------------+
                                                                    |
                                                                    | gRPC (24kHz)
                                                                    v
                                                        +-----------------------+
                                                        |       AI Service      |
                                                        |     (Python/C++)      |
                                                        +-----------------------+
```

1.  **Client**: Kết nối qua WebSocket, gửi và nhận âm thanh (thường là 8kHz).
2.  **Nginx**: Reverse proxy và Load balancer, điều hướng traffic WebSocket đến các instance của Node.js Server.
3.  **Node.js Server**:
    - Xử lý kết nối WebSocket.
    - Thực hiện **Audio Resampling** (chuyển đổi mẫu âm thanh):
      - Up-sampling: 8kHz (từ Client) -> 24kHz (gửi tới AI Service).
      - Down-sampling: 24kHz (từ AI Service) -> 8kHz (gửi về Client).
    - Đóng vai trò là **gRPC Client** để giao tiếp với AI Service.
4.  **AI Service**: Xử lý logic nghiệp vụ, nhận diện giọng nói (ASR), xử lý ngôn ngữ tự nhiên (NLP) và tổng hợp giọng nói (TTS).

## 2. Cài đặt và Chạy (Installation & Running)

### Yêu cầu (Prerequisites)

- Docker & Docker Compose
- Node.js (nếu chạy local)

### Chạy với Docker Compose

```bash
docker-compose up --build
```

Lệnh này sẽ khởi động:

- **Nginx** tại port `80` (hoặc port được cấu hình trong `.env`).
- **Server** tại port `8080` (internal).

## 3. API Documentation

### WebSocket Endpoint

**URL:** `ws://<host>/api/asr/streaming`

**Query Parameters:**

| Parameter    | Type   | Required | Description                                        |
| :----------- | :----- | :------- | :------------------------------------------------- |
| `tenant_id`  | string | Yes      | ID của tenant/khách hàng doanh nghiệp.             |
| `call_id`    | string | Yes      | ID duy nhất của cuộc gọi.                          |
| `hotline`    | string | No       | Số hotline nhận cuộc gọi.                          |
| `phone`      | string | No       | Số điện thoại khách hàng.                          |
| `speaker_id` | string | No       | ID người nói (nếu có).                             |
| `env`        | string | No       | Môi trường (ví dụ: `dev`, `prod`). Default: `dev`. |

### Giao thức giao tiếp (Communication Protocol)

Giao tiếp giữa Client và Server thông qua WebSocket sử dụng định dạng JSON.

#### A. Client -> Server Messages

**1. Initial Info (`info_call`)**
Gửi ngay sau khi kết nối thành công để khởi tạo session.

```json
{
  "type": "info_call",
  "workspace_id": "tenant_123",
  "call_id": "call_abc_789",
  "customer_phone_number": "0901234567",
  "type_call": "inbound", // hoặc "outbound"
  "hotline": "1900xxxx",
  "url_audio_file": "" // Optional
}
```

**2. Audio Data (`play_audio`)**
Gửi liên tục các chunk âm thanh (streaming).

```json
{
  "type": "play_audio",
  "audio_content": "<Base64 Encoded PCM Audio>",
  "sample_rate": 8000,
  "sample_width": 2, // 16-bit
  "num_channels": 1,
  "duration": 0.02 // độ dài chunk (giây)
}
```

**3. Disconnect (`disconnect`)**
Gửi khi client muốn kết thúc cuộc gọi chủ động.

```json
{
  "type": "disconnect"
}
```

#### B. Server -> Client Messages

**1. Audio Output (`audio_output`)**
Âm thanh phản hồi từ AI Service (TTS).

```json
{
  "type": "audio_output",
  "audio_content": "<Base64 Encoded PCM Audio>",
  "sample_rate": 8000,
  "sample_width": 2,
  "num_channels": 1,
  "duration": 0.02
}
```

**2. End Call Signal (`end_call`)**
AI Service yêu cầu ngắt cuộc gọi.

```json
{
  "type": "end_call",
  "call_id": "call_abc_789"
}
```

**3. Transfer Call Signal (`transfer_call`)**
Yêu cầu chuyển cuộc gọi sang nhân viên (Human Agent).

```json
{
  "type": "transfer_call",
  "call_id": "call_abc_789",
  "customer_phone_number": "0901234567",
  "target_staff": [
    {
      "name": "Agent A",
      "phone_number": "101"
    }
  ]
}
```

**4. Error (`error`)**

```json
{
  "type": "error",
  "error_code": 500,
  "message": "Internal Server Error"
}
```

## 4. gRPC Service Definition (`voice.proto`)

Server giao tiếp với AI Service qua gRPC. Dưới đây là định nghĩa Proto.

**Service:** `LiveCall`
**RPC:** `StreamCall` (Bidirectional Streaming)

### Messages

- **ClientRequest (NodeJS -> AI):**

  - `initial_info`: Metadata cuộc gọi.
  - `play_audio`: Dữ liệu âm thanh (đã resample lên 24kHz).
  - `disconnect`: Tín hiệu ngắt kết nối.

- **ServerResponse (AI -> NodeJS):**
  - `audio_output`: Dữ liệu âm thanh phản hồi (24kHz).
  - `signal`: `end_call` hoặc `transfer_call`.
  - `error`: Thông tin lỗi.

### Health Check

RPC `Check` được sử dụng để kiểm tra trạng thái của AI Service.

---

_Document generated by GitHub Copilot_
