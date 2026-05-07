# Edge Relay

HTTP proxy untuk Vercel Edge Runtime.

## Cara Pakai

### Header yang Dibutuhkan

| Header | Required | Default | Deskripsi |
|--------|----------|---------|-----------|
| `x-relay-target` | Yes | - | URL target yang ingin di-proxy |
| `x-relay-path` | No | `/` | Path yang ditambahkan ke target |

### Contoh

```bash
# Proxy ke httpbin.org/get
curl -H "x-relay-target: https://httpbin.org" https://your-edge-function.vercel.app

# Proxy ke endpoint spesifik
curl -H "x-relay-target: https://api.example.com" \
     -H "x-relay-path: /v1/users" \
     https://your-edge-function.vercel.app
```

### HTTP Methods

Mendukung semua HTTP methods:
- `GET`, `HEAD` - tanpa body
- `POST`, `PUT`, `PATCH`, `DELETE` - dengan body

### Header Handling

Relay headers yang di-strip sebelum forwarded:
- `x-relay-target`
- `x-relay-path`
- `host`

Headers lain tetap di-pass.

### Error Handling

```json
{
  "error": "Missing x-relay-target header"
}
```
HTTP 400 jika `x-relay-target` tidak ada.

## Struktur Kode

```
proxy-vercel/
├── index.ts        # Edge handler
├── relay-utils.ts  # Pure functions untuk relay logic
└── index.test.ts   # Unit tests
```

### relay-utils.ts

| Function | Deskripsi |
|----------|-----------|
| `normalizeTargetUrl(target, path)` | Gabung target + path, hapus trailing slash |
| `stripRelayHeaders(headers)` | Hapus relay-specific headers |
| `shouldSendBody(method)` | Cek apakah method butuh body |
| `buildRelayRequest(req, url, headers)` | Bangun RequestInit untuk fetch |
| `createRelayResponse(response)` | Buat Response dari fetch result |

## Development

```bash
bun test        # Run tests
bun run index.ts  # Start local server (untuk manual testing)
```
