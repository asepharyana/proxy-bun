# Edge Relay

HTTP proxy untuk Vercel Edge Runtime.

## Live Deployment

Endpoint utama: `https://proxy-bun.vercel.app/api/relay`
Endpoint kedua: `https://vercel-relay-bgddcbfit-asepharyana71s-projects.vercel.app`
## Cara Pakai

### Header yang Dibutuhkan

| Header | Required | Default | Deskripsi |
|--------|----------|---------|-----------|
| `x-relay-target` | Yes | - | URL target yang ingin di-proxy |
| `x-relay-path` | No | `/` | Path yang ditambahkan ke target |

### Contoh

```bash
# Proxy
curl -H "x-relay-target: https://jsonplaceholder.typicode.com/posts/1" https://proxy-bun.vercel.app/api/relay

# Proxy ke endpoint spesifik
curl -H "x-relay-target: https://api.example.com" \
     -H "x-relay-path: /v1/users" \
     https://proxy-bun.vercel.app/api/relay
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
proxy-bun/
├── src/
│   ├── app/
│   │   └── api/relay/route.ts  # Edge handler
│   └── lib/
│       ├── relay-utils.ts      # Pure functions untuk relay logic
│       └── relay-utils.test.ts # Unit tests
```

### relay-utils.ts

| Function | Deskripsi |
|----------|-----------|
| `normalizeTargetUrl(target, path)` | Gabung target + path, hapus trailing slash |
| `filterHeaders(headers)` | Filter relay & security headers |
| `shouldSendBody(method)` | Cek apakah method butuh body |
| `buildRelayRequest(req, url, headers)` | Bangun RequestInit untuk fetch |
| `createRelayResponse(response)` | Buat Response dari fetch result |

## Development

```bash
bun test     # Run tests
bun run dev  # Start local Next.js server
```
