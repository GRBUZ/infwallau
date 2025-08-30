// netlify/functions/upload.js (v2, JSON-only)
const { requireAuth } = require('./auth-middleware');

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra, signature:"upload.v2" })
  };
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  const cleaned = base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 100);
  const nameWithoutExt = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${nameWithoutExt}_${timestamp}_${random}${ext}`;
}

// === seul writer: binaire dans le repo ===
async function ghPutBinary(path, buffer, message){
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };
  let sha = null;
  const probe = await fetch(`${baseURL}?ref=${GH_BRANCH}`, { headers });
  if (probe.ok) {
    const j = await probe.json();
    sha = j.sha || null;
  } else if (probe.status !== 404) {
    throw new Error(`GH_GET_PROBE_FAILED:${probe.status}`);
  }
  const body = {
    message: message || `feat: upload ${path}`,
    content: Buffer.from(buffer).toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const put = await fetch(baseURL, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GH_PUT_BIN_FAILED:${put.status}`);
  return put.json();
}

//new
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function ghPutBinaryWithRetry(repoPath, buffer, message, maxAttempts = 4) {
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      // ghPutBinary fait déjà un probe (GET) + PUT avec sha si besoin
      return await ghPutBinary(repoPath, buffer, message);
    } catch (e) {
      const msg = String(e?.message || e);
      lastErr = e;
      // 409 = conflit GitHub: on re-tente (HEAD a changé pendant notre PUT)
      if (msg.includes('GH_PUT_BIN_FAILED:409')) {
        await sleep(120 * attempt); // backoff linéaire (simple & suffisant ici)
        continue;
      }
      // autres erreurs -> pas de retry
      throw e;
    }
  }
  throw lastErr || new Error('UPLOAD_MAX_RETRIES_EXCEEDED');
}
//new

exports.handler = async (event) => {
  try {
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    // ---- JSON ONLY ----
    const body = JSON.parse(event.body || '{}');
    const regionId = String(body.regionId || "").trim();
    const filename = safeFilename(body.filename || "image.jpg");
    const b64 = String(body.contentBase64 || "");
    const contentType = String(body.contentType || "");

    if (!regionId) return bad(400, "MISSING_REGION_ID");
    if (!b64) return bad(400, "NO_FILE_BASE64");
    if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");

    const buffer = Buffer.from(b64, "base64");

    const repoPath = `assets/images/${regionId}/${filename}`;
    //await ghPutBinary(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);
    await ghPutBinaryWithRetry(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);

    const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${repoPath}`;

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({ ok:true, signature:"upload.v2", regionId, path: repoPath, imageUrl })
    };
  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e), signature:"upload.v2" });
  }
};
