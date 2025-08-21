Profile Photo Upload — Add-on
---------------------------------
This patch adds a file input in the purchase modal to upload a profile image to your repo under `assets/images/`.
It does NOT automatically write the URL into your JSON — it shows the uploaded URL so you can paste it
manually later into `data/state.json` (as requested).

Files included
-------------
- index.html               — adds the "Profile Photo (optional)" field and a read-only "Uploaded URL" with a "Copy" button.
- js/upload-addon.js       — handles client-side base64 encode and calls the upload function.
- netlify/functions/upload.mjs — writes the image to GitHub via the Contents API.

Server config (Netlify env)
---------------------------
Make sure these env vars are already set (same as your finalize function):
- GH_REPO   = e.g. GRBUZ/Fixrepo
- GH_TOKEN  = a GitHub Personal Access Token with repo:contents (classic fine)
- GH_BRANCH = main  (or your default branch)
Optional:
- PATH_IMAGES = assets/images

How it works
------------
1) User selects an image file.
2) The browser encodes it to base64 and POSTs JSON to '/.netlify/functions/upload'.
3) The function writes it into GitHub at 'assets/images/name-timestamp-rand.ext' and returns a raw URL.
4) The UI shows that URL so you can copy/paste it into your JSON later.
