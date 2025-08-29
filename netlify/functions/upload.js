// netlify/functions/upload.js
// Upload image pour un regionId RÉSERVÉ (refuse si lock absent/expiré)

const { requireAuth, getAuthenticatedUID } = require('./jwt-middleware.js');

// utils communs (copier en haut de chaque fn)
const CORS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const ok = (obj) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(obj) });
//const bad = (status, error, extra={}) => ({ statusCode: status, headers: CORS, body: JSON.stringify({ ok:false, error, ...extra }) });


const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra })
  };
}

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha, message){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const body = {
    message: message || "chore: set region imageUrl",
    content: Buffer.from(pretty, "utf-8").toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}

async function ghPutBinary(repoPath, buffer, message){
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(repoPath)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // probe (sha si déjà présent)
  let sha = null;
  const probe = await fetch(`${baseURL}?ref=${GH_BRANCH}`, { headers });
  if (probe.ok) {
    const j = await probe.json();
    sha = j.sha || null;
  } else if (probe.status !== 404) {
    throw new Error(`GH_GET_PROBE_FAILED:${probe.status}`);
  }

  const body = {
    message: message || `feat: upload ${repoPath}`,
    content: Buffer.from(buffer).toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;

  const put = await fetch(baseURL, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GH_PUT_BIN_FAILED:${put.status}`);
  return put.json();
}

function pruneLocks(locks) {
  const now = Date.now();
  const out = {};
  for (const [k,v] of Object.entries(locks || {})) {
    if (v && typeof v.until === 'number' && v.until > now) out[k] = v;
  }
  return out;
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  return base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 120) || "image.jpg";
}

exports.handler = async (event, context) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });

  // Auth JWT (ne JAMAIS lire req.headers.authorization directement)
  const auth = requireAuth(event);
  if (auth && auth.statusCode) return auth; // 401 déjà formatée par le middleware
  const uid = auth.uid;

  // Parse JSON body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return bad(400, 'BAD_JSON');
  }

  try {
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN)  return bad(500, "GITHUB_CONFIG_MISSING");

    // Support JSON uniquement (filename + base64). On refuse multipart ici.
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
    if (!ct.includes('application/json')) {
      return bad(415, "UNSUPPORTED_MEDIA_TYPE", { hint: "send JSON {regionId, filename, contentBase64} (or 'data')" });
    }

    // Récupération des champs attendus pour la nouvelle archi
    const regionId = String(body.regionId || '').trim();
    const filename = safeFilename(body.filename || "image.jpg");
    const dataB64  = body.contentBase64 || body.data || '';

    if (!regionId) return bad(400, "MISSING_REGION_ID");
    if (!dataB64)  return bad(400, "NO_FILE_BASE64");

    // Charger l'état et valider la région/ownership
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const st = state0 || { sold:{}, locks:{}, regions:{} };
    st.locks = pruneLocks(st.locks);

    const region = (st.regions || {})[regionId];
    if (!region) return bad(404, "REGION_NOT_FOUND");
    if (region.uid && region.uid !== uid) return bad(403, "NOT_REGION_OWNER");

    // S'assurer qu'il reste au moins un lock actif pour cette région par ce uid
    const hasActiveLock = Object.values(st.locks).some(l => l && l.regionId === regionId && l.uid === uid && l.until > Date.now());
    if (!hasActiveLock) return bad(409, "LOCK_MISSING_OR_EXPIRED");

    // Upload du binaire vers le repo
    const repoPath = `assets/images/${regionId}/${filename}`;
    const buffer   = Buffer.from(String(dataB64), 'base64');
    await ghPutBinary(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);

    // URL RAW GitHub et mise à jour de state.json
    const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${repoPath}`;
    st.regions[regionId].imageUrl = imageUrl;

    await ghPutJson(STATE_PATH, st, sha, `chore: set imageUrl for ${regionId}`);

    // Réponse simplifiée et utile au front
    return ok({ ok: true, regionId, imageUrl, path: repoPath });
  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String((e && e.message) || e) });
  }
};
