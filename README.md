# 🚀 Edge Relay (Proxy Bun)

High-performance HTTP Proxy & Relay handler optimized for Vercel Edge Runtime, Cloudflare Workers, and Bun.

## 🌐 Live Deployment

| Provider | Endpoint |
|----------|----------|
| **Primary (Vercel)** | `https://proxy-bun.vercel.app` |
| **Secondary (CF Workers)** | `https://opennext-app.superaseph.workers.dev` |
| **Leapcell** | `https://proxy-bun-mytheclipse8647-orfq73fe.apn.leapcell.dev` |
| **Interactive Docs** | `https://proxy-bun.vercel.app/docs` |

---

## 🛠 Cara Pakai

Proxy ini bekerja dengan menangkap request ke endpoint relay dan meneruskannya ke target yang ditentukan via headers.

### Required Headers

| Header | Required | Default | Deskripsi |
|--------|----------|---------|-----------|
| `x-relay-target` | **Yes** | - | Base URL target (e.g. `https://api.openai.com`) |
| `x-relay-path` | No | `/` | Path tambahan (e.g. `/v1/chat/completions`) |

---

## 📖 Contoh Penggunaan

### 1. Simple GET Request
Mengambil data dari JSONPlaceholder.
```bash
curl -H "x-relay-target: https://jsonplaceholder.typicode.com/posts/1" \
     https://proxy-bun.vercel.app/
```

### 2. POST with Body & Headers
Meneruskan API Key dan data JSON ke target.
```bash
curl -X POST \
     -H "x-relay-target: https://api.example.com" \
     -H "x-relay-path: /v1/data" \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"key": "value"}' \
     https://proxy-bun.vercel.app/
```

### 3. Binary Data / Upload
Mendukung upload file via `POST`/`PUT` (streaming).
```bash
curl -X PUT \
     -H "x-relay-target: https://storage.com" \
     -H "x-relay-path: /upload/image.png" \
     --data-binary "@/path/to/image.png" \
     https://proxy-bun.vercel.app/
```

---

## ⚙️ Fitur & Spesifikasi

### ⚡ Protocol Support
- **HTTP/1.1 & HTTP/2** - Full support.
- **Methods** - `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
- **Streaming** - Mendukung response streaming (Server-Sent Events / SSE) secara native.
- **CORS** - Otomatis menambahkan header `Access-Control-Allow-*` agar bisa diakses dari browser.

### 🛡️ Security & Header Handling
Relay ini bersifat transparan kecuali untuk header berikut yang di-**strip** sebelum diteruskan ke target:
- `host` (diganti dengan host target)
- `x-relay-target`
- `x-relay-path`

Semua header lain (seperti `Authorization`, `User-Agent`, `Cookie`, dsb) akan diteruskan apa adanya.

### 🧪 Error Codes
| Status | Deskripsi |
|--------|-----------|
| `400` | Missing `x-relay-target` header. |
| `403` | Target domain tidak valid (jika whitelist aktif). |
| `502` | Target gagal dihubungi / Bad Gateway. |

---

## 📂 Struktur Project

```text
src/
├── app/
│   ├── route.ts        # Entry point proxy (Edge Handler)
│   └── docs/           # UI Interactive Docs & Tester
└── lib/
    ├── relay-utils.ts  # Logic filter header & request builder
    └── utils.ts        # Helper UI
```

## 🏗 Development

Gunakan [Bun](https://bun.sh) untuk performa terbaik.

```bash
# Install dependencies
bun install

# Run dev server
bun dev

# Run unit tests
bun test
```

## 🚀 Deployment (GitHub Actions)
Project ini otomatis dideploy ke Cloudflare Workers setiap ada push ke `master`.
Konfigurasi workflow ada di `.github/workflows/deploy.yml`.

---
🤖 **Powered by Bun + Next.js Edge Runtime**
