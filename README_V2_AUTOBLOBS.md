Functions v2 + Blobs (auto-config)
===================================
This patch converts functions to **Functions v2 (ESM)** so `getStore('name')` works
**without** manually passing `siteID` and `token`.

Files replaced:
- netlify/functions/finalize.mjs
- netlify/functions/status.mjs
- netlify/functions/diag.mjs
- netlify.toml (adds functions v2 + optional `netlify_blobs` hint)
- package.json (`type: module`, `@netlify/blobs` ^8.2.0)

Steps:
1) Replace the existing function files with these `.mjs` ones.
2) Commit & deploy. You can **remove** the `SITE_ID` / `BLOBS_TOKEN` env vars.
3) Open `/.netlify/functions/diag` → expect `{ ok: true, blobsOk: true }`.
