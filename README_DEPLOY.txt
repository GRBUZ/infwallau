Quick fix for Netlify build failure (missing @netlify/blobs)
=================================================================

What this patch contains (place at REPO ROOT):
- package.json  -> adds dependency "@netlify/blobs"
- netlify.toml  -> configures functions directory and bundler
- (optional) engines.node >= 18

Steps
-----
1) Add these files at the ROOT of your Git repo (same level as /netlify and /js).
2) Commit & push.
3) In Netlify:
   - Site settings → Build & deploy → clear cache and redeploy
   - Check deploy log: you should see "Installing NPM modules" and @netlify/blobs being installed.
4) Test:
   - Open DevTools → Network → submit a purchase (Confirm)
   - Ensure /.netlify/functions/finalize returns 200 with { ok: true }

Notes
-----
- If you still see "METHOD_NOT_ALLOWED", make sure the request method is POST.
- If functions fail to bundle, keeping node_bundler = "esbuild" with
  external_node_modules = ["@netlify/blobs"] ensures the runtime picks it from node_modules.
- Node 18+ is required for @netlify/blobs.
