# Edge Relay

HTTP proxy untuk Vercel Edge Runtime.

## Live Deployment

- **Docs/Tester**: `https://proxy-bun.vercel.app/docs`
- **Utama**: `https://proxy-bun.vercel.app`
- **Alternatif**: `https://vercel-relay-alpha-umber.vercel.app`
- **Alternatif**: `https://proxy-bun-mytheclipse8647-orfq73fe.apn.leapcell.dev`

## Cara Pakai

### Header yang Dibutuhkan

| Header | Required | Default | Deskripsi |
|--------|----------|---------|-----------|
| `x-relay-target` | Yes | - | URL target yang ingin di-proxy |
| `x-relay-path` | No | `/` | Path yang ditambahkan ke target |

### Contoh

```bash
curl -H "x-relay-target: https://jsonplaceholder.typicode.com/posts/1" https://proxy-bun.vercel.app/
```
```bash
curl -H "x-relay-target: https://api.example.com" \
     -H "x-relay-path: /v1/users" \
     https://proxy-bun.vercel.app/
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
│   │   ├── docs/page.tsx   # UI / Documentation
│   │   └── route.ts        # Edge API handler
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
