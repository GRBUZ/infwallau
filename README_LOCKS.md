GitHub Locks Patch
===================
This patch adds **reservations (locks)** stored in `data/state.json` in your GitHub repo.
- Reserve on **Buy** (one commit), not on every click → fast UI & fewer conflicts.
- Locks have a **TTL of 3 minutes** and are cleaned server-side.
- `finalize` refuses blocks that are sold or locked by someone else.

Files
-----
- `netlify/functions/status.mjs` → returns `{ sold, locks }`
- `netlify/functions/reserve.mjs` → POST `{ uid, blocks[] }` → reserves available blocks
- `netlify/functions/unlock.mjs`  → POST `{ uid, blocks[] }` → releases your locks
- `netlify/functions/finalize.mjs`→ POST `{ uid, blocks[], name, linkUrl }` → writes sales, clears your locks
- `js/app.js` (front) → calls reserve/unlock/finalize; shows pending (reserved) cells
- `css/style.css` → adds `.pending` style (yellowish)
- `index.html`, `netlify.toml`, `package.json`

Env vars (Netlify → Site settings → Build & deploy → Environment)
-----------------------------------------------------------------
- `GH_REPO` = `GRBUZ/Fixrepo`
- `GH_TOKEN` = GitHub Personal Access Token (public_repo or repo)
- *(optional)* `GH_BRANCH` = `main`
- *(optional)* `PATH_JSON` = `data/state.json`

Flow
----
1) User selects blocks (pure client-side, fast).
2) Click **Buy Pixels** → `POST /reserve` (server writes locks in GitHub).
3) Modal → confirm → `POST /finalize`:
   - server prunes expired locks, rejects blocks sold or locked by others
   - writes sales and removes your locks
4) Cancel/ESC → `POST /unlock`

Notes
-----
- Status polling updates the UI so other users see **pending** blocks in near real-time.
- For images later, you can keep storing URLs in the same `sold` map.
