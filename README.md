Influencers Wall — Basic (no image)
=====================================

What it does
------------
- 100×100 grid; drag or click to select blocks.
- Modal asks only **Display name** + **Profile URL** (no image).
- On confirm, blocks are marked **SOLD** (grey) and linkable to the URL.
- Price line: +$0.01 every 1000 pixels sold.

Deploy (Netlify)
----------------
1) Put all files at repo root. Commit & push.
2) In Netlify → **Site settings → Build & deploy → Environment** add:
   - `SITE_ID` = your Project ID (General → Project information → Project ID)
   - `BLOBS_TOKEN` = a Personal Access Token (or `NETLIFY_AUTH_TOKEN`) with blobs access
3) **Clear cache and deploy**.
4) Check `/.netlify/functions/diag` → should show `{ ok: true, blobsOk: true }`.
5) Test the UI: select → Buy Pixels → fill name+URL → Confirm.

Notes
-----
- If some blocks are already taken, server returns 409 and the UI removes those from the selection.
- Later, you can manually add images in your repo and extend the front to show them using your data file.
