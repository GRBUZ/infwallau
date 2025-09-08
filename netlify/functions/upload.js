// netlify/functions/upload.js — JSON-only, safe update of regions[regionId].imageUrl if present
const { requireAuth } = require('./auth-middleware');

const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";
const STATE_PATH = process.env.STATE_PATH || "data/state.json";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra, signature:"upload.v2" })
  };
}
function ok(payload = {}) {
  return {
    statusCode: 200,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:true, signature:"upload.v2", ...payload })
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
    message: message || "chore: update state (set imageUrl)",
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

// PUT binaire (+probe) avec retry sur 409
async function ghPutBinary(path, buffer, message){
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };
  // probe
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
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function ghPutBinaryWithRetry(repoPath, buffer, message, maxAttempts = 4) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await ghPutBinary(repoPath, buffer, message);
    } catch (e) {
      const msg = String(e?.message || e);
      lastErr = e;
      if (msg.includes('GH_PUT_BIN_FAILED:409')) {
        await sleep(120 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('UPLOAD_MAX_RETRIES_EXCEEDED');
}

exports.handler = async (event) => {
  try {
    // Auth JWT
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    // ---- JSON ONLY ----
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return bad(400, "BAD_JSON");
    }

    const regionId    = String(body.regionId || "").trim();
    const filename    = safeFilename(body.filename || "image.jpg");
    const b64         = String(body.contentBase64 || body.data || "");
    const contentType = String(body.contentType || "");

    if (!regionId) return bad(400, "MISSING_REGION_ID");
    if (!b64) return bad(400, "NO_FILE_BASE64");
    if (contentType && !contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");

    const buffer   = Buffer.from(b64, "base64");
    const repoPath = `assets/images/${regionId}/${filename}`;

    // 1) Upload binaire (avec retry 409)
    await ghPutBinaryWithRetry(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);
    const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${repoPath}`;

    // 2) Essayez d’attacher l’image à la région si elle existe et est à moi.
    //    (On reste permissif : si la région n’existe pas encore, on n’écrit pas.)
    try {
      const got = await ghGetJson(STATE_PATH);
      const st  = got.json || { sold:{}, locks:{}, regions:{} };
      st.regions = st.regions || {};

      const reg = st.regions[regionId];
      // On met à jour *seulement* si la région existe déjà ET (pas d’uid ou uid=le mien)
      if (reg && (!reg.uid || reg.uid === uid)) {
        st.regions[regionId] = {
          ...reg,
          imageUrl,
          uid: reg.uid || uid
        };
        try {
          // juste avant d’écrire newState
          const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
          const oldSoldCount = Object.keys(oldState.sold || {}).length;
          const newSoldCount = Object.keys(newState.sold || {}).length;
          if (newSoldCount < oldSoldCount) {
            // on n’écrit pas → quelque chose aurait écrasé l’historique
            return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
          }
          await ghPutJson(STATE_PATH, st, got.sha, `chore: set imageUrl for ${regionId}`);
        } catch (errPut) {
          // retry simple si 409 (recharge puis réécrit)
          if (String(errPut?.message||errPut).includes('409')) {
            const got2 = await ghGetJson(STATE_PATH);
            const st2  = got2.json || { sold:{}, locks:{}, regions:{} };
            st2.regions = st2.regions || {};
            const reg2  = st2.regions[regionId] || {};
            st2.regions[regionId] = { ...reg2, imageUrl, uid: reg2.uid || uid };
            // juste avant d’écrire newState
            const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
            const oldSoldCount = Object.keys(oldState.sold || {}).length;
            const newSoldCount = Object.keys(newState.sold || {}).length;
            if (newSoldCount < oldSoldCount) {
              // on n’écrit pas → quelque chose aurait écrasé l’historique
              return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
            }

            await ghPutJson(STATE_PATH, st2, got2.sha, `chore: set imageUrl for ${regionId} (retry)`);
          } else {
            // ne bloque pas l’upload si l’écriture JSON échoue
            console.warn('[upload] state update failed:', errPut);
          }
        }
      }
    } catch (errState) {
      // ne bloque pas l’upload si la lecture/écriture JSON échoue
      console.warn('[upload] state read failed (non blocking):', errState);
    }

    return ok({ regionId, path: repoPath, imageUrl });
  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};