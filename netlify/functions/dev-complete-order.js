// netlify/functions/dev-complete-order.js
// DEV ONLY: finalise immédiatement une commande sans PayPal.
// ⚠️ Activé seulement si process.env.ALLOW_DEV_COMPLETE === "true".
// JWT requis, et l'order doit appartenir au user.

const { requireAuth } = require('./auth-middleware');

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const ORDERS_DIR = process.env.ORDERS_DIR || "data/orders";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";
const ALLOW_DEV_COMPLETE = String(process.env.ALLOW_DEV_COMPLETE || "").toLowerCase() === "true";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "dev-complete-order.v1" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "dev-complete-order.v1", ...body })
  };
}

// ---- GitHub helpers (même style que tes autres fonctions)
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
    message: message || "chore: write json",
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
        "Accept":"application/vnd.github+json",
        "Content-Type":"application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}
async function ghGetFile(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (!r.ok) throw new Error(`GH_GET_FILE_FAILED:${r.status}`);
  return r.json(); // { content (b64), sha, ... }
}
async function ghDeletePath(path, sha, message){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept":"application/vnd.github+json",
        "Content-Type":"application/json"
      },
      body: JSON.stringify({ message: message || `chore: delete ${path}`, sha, branch: GH_BRANCH })
    }
  );
  if (!r.ok) throw new Error(`GH_DELETE_FAILED:${r.status}`);
  return r.json();
}
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
async function ghPutBinaryWithRetry(path, buffer, message, maxAttempts = 4){
  let last;
  for (let i=0;i<maxAttempts;i++){
    try { return await ghPutBinary(path, buffer, message); }
    catch(e){
      last = e;
      const msg = String(e?.message || e);
      if (msg.includes('GH_PUT_BIN_FAILED:409') && i < maxAttempts-1){
        await sleep(120*(i+1)); continue;
      }
      throw e;
    }
  }
  throw last || new Error('UPLOAD_MAX_RETRIES_EXCEEDED');
}

function toRawUrl(path){
  return `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${path}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!ALLOW_DEV_COMPLETE) return bad(403, "DEV_COMPLETE_DISABLED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    // JWT (dev-complete est appelé par le client)
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    const body = JSON.parse(event.body || '{}');
    const orderId = String(body.orderId || "").trim();
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    // Lire l'ordre
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const { json: order, sha: orderSha } = await ghGetJson(orderPath);
    if (!order) return bad(404, "ORDER_NOT_FOUND");
    if (order.uid && order.uid !== uid) return bad(403, "FORBIDDEN");
    if (order.status === "completed") return ok({ orderId, status: "completed" });

    // Promouvoir l'image (staging -> assets)
    const stagingPath = order.image?.repoPath;
    if (!stagingPath) return bad(400, "ORDER_NO_STAGING_IMAGE");

    const stageFile = await ghGetFile(stagingPath);
    const contentB64 = stageFile?.content || "";
    if (!contentB64) return bad(500, "STAGING_READ_FAILED");
    const buffer = Buffer.from(contentB64, "base64");

    const filename = stagingPath.split('/').pop();
    const destPath = `assets/images/${order.regionId}/${filename}`;
    await ghPutBinaryWithRetry(destPath, buffer, `feat: promote image for ${order.regionId}`);
    const finalUrl = toRawUrl(destPath);

    // cleanup staging (optionnel)
    try { await ghDeletePath(stagingPath, stageFile.sha, `chore: cleanup staging for ${orderId}`); } catch(_){}

    // Ecrire state.json avec retry 409
    let attempts = 0, delay = 150;
    while (attempts < 4) {
      attempts++;

      const { json: st0, sha: stSha } = await ghGetJson(STATE_PATH);
      const st = st0 || { sold:{}, locks:{}, regions:{} };
      st.sold   ||= {};
      st.locks  ||= {};
      st.regions||= {};

      // Vérifier disponibilité
      const now = Date.now();
      for (const idx of (order.blocks || [])) {
        if (st.sold[idx]) {
          const failed = { ...order, status:"failed", updatedAt: Date.now(), failReason:"ALREADY_SOLD" };
          await ghPutJson(orderPath, failed, orderSha, `chore: order ${orderId} failed (already sold)`);
          return bad(409, "ALREADY_SOLD");
        }
        const L = st.locks[idx];
        if (L && L.until > now && L.uid && order.uid && L.uid !== order.uid) {
          const failed = { ...order, status:"failed", updatedAt: Date.now(), failReason:"LOCKED_BY_OTHER" };
          await ghPutJson(orderPath, failed, orderSha, `chore: order ${orderId} failed (locked by other)`);
          return bad(409, "LOCKED_BY_OTHER");
        }
      }

      const ts = Date.now();
      for (const idx of (order.blocks || [])) {
        st.sold[idx] = { name: order.name, linkUrl: order.linkUrl, ts, regionId: order.regionId };
        if (st.locks[idx]) delete st.locks[idx];
      }

      const existing = st.regions[order.regionId] || {};
      st.regions[order.regionId] = { rect: order.rect, imageUrl: existing.imageUrl || finalUrl };

      try {
        await ghPutJson(STATE_PATH, st, stSha, `feat: finalize order ${orderId} (dev)`);
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('409') && attempts < 4) { await sleep(delay); delay *= 2; continue; }
        const failed = { ...order, status:"failed", updatedAt: Date.now(), failReason: msg };
        await ghPutJson(orderPath, failed, orderSha, `chore: order ${orderId} failed (write state, dev)`);
        return bad(500, "SERVER_ERROR", { message: msg });
      }
    }

    // Marquer completed
    const completed = { ...order, status:"completed", updatedAt: Date.now(), finalImageUrl: finalUrl };
    await ghPutJson(orderPath, completed, orderSha, `chore: order ${orderId} completed (dev)`);

    return ok({ orderId, status: "completed", regionId: order.regionId, imageUrl: finalUrl });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
