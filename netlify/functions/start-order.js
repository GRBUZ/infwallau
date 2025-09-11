// netlify/functions/start-order.js
const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation'); // garde le même validateur

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const ORDERS_DIR = process.env.ORDERS_DIR || "data/orders";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "start-order.v1" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "start-order.v1", ...body })
  };
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  const cleaned = base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 100);
  const nameWithoutExt = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${nameWithoutExt}_${ts}_${rnd}${ext}`;
}
function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
}
function computeRect(blocks){
  let minR=1e9, maxR=-1e9, minC=1e9, maxC=-1e9;
  for (const idx of blocks){
    const r = Math.floor(idx / 100);
    const c = idx % 100;
    if (r<minR) minR=r; if (r>maxR) maxR=r;
    if (c<minC) minC=c; if (c>maxC) maxC=c;
  }
  return { x:minC, y:minR, w:(maxC-minC+1), h:(maxR-minR+1) };
}

// ---- GitHub helpers (inchangés)
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
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function ghPutJsonWithRetry(path, jsonData, sha, message, maxAttempts = 4){
  let last;
  for (let i=0;i<maxAttempts;i++){
    try { return await ghPutJson(path, jsonData, sha, message); }
    catch(e){
      last = e;
      const msg = String(e?.message || e);
      if (msg.includes('GH_PUT_JSON_FAILED:409') && i < maxAttempts-1){
        await sleep(120*(i+1)); continue;
      }
      throw e;
    }
  }
  throw last || new Error('GH_PUT_JSON_MAX_RETRIES');
}

exports.handler = async (event) => {
  try {
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    // Payload JSON (image obligatoire)
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Valide et normalise name/linkUrl/blocks via ton validateur
    const { name, linkUrl, blocks } = await guardFinalizeInput(event);
    if (!Array.isArray(blocks) || blocks.length === 0) return bad(400, "NO_BLOCKS");

    // Image OBLIGATOIRE pour la commande
    const filename    = safeFilename(payload.filename || "image.jpg");
    const contentType = String(payload.contentType || "");
    let   b64         = String(payload.contentBase64 || "");
    if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");
    if (!b64) return bad(400, "NO_FILE_BASE64");
    // tolère "data:image/png;base64,...."
    const m = b64.match(/^data:[^;]+;base64,(.*)$/i);
    if (m) b64 = m[1];

    // Vérifier disponibilité des blocs et locks actuels (lecture state.json)
    const { json: state } = await ghGetJson(STATE_PATH);
    const st = state || { sold:{}, locks:{}, regions:{} };
    const now = Date.now();
    for (const idx of blocks) {
      if (st.sold && st.sold[idx]) return bad(409, "ALREADY_SOLD", { idx: Number(idx) });
      const L = st.locks && st.locks[idx];
      if (L && L.until > now && L.uid && L.uid !== uid) {
        return bad(409, "LOCKED_BY_OTHER", { idx: Number(idx) });
      }
    }

    // Créer orderId + regionId + rect
    const orderId  = makeId("ord");
    const regionId = makeId("r");
    const rect     = computeRect(blocks);

    // ====== ⬇️ CHANGEMENT : upload direct Supabase (final), pas de staging GitHub
    const { createClient } = await import('@supabase/supabase-js');
    const SUPABASE_URL     = process.env.SUPABASE_URL;
    const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const SUPABASE_BUCKET  = process.env.SUPABASE_BUCKET || 'images';
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    const buffer = Buffer.from(b64, "base64");
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    const objectPath = `regions/${regionId}/${filename}`;
    const { error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(objectPath, buffer, { contentType, upsert: true });
    if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const imageUrl = pub?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
    // ====== ⬆️ FIN CHANGEMENT

    // Enregistrer ordre pending (toujours dans data/orders/*.json pour compat)
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const orderJson = {
      status: "pending",
      uid,
      name,
      linkUrl,
      blocks,
      rect,
      regionId,
      image: { storage:"supabase", bucket: SUPABASE_BUCKET, path: objectPath, url: imageUrl, contentType },
      amount: payload.amount || null,
      currency: payload.currency || "USD",
      createdAt: Date.now(),
      expiresAt: Date.now() + 20*60*1000
    };
    await ghPutJsonWithRetry(orderPath, orderJson, null, `feat: create order ${orderId}`);

    return ok({ orderId, regionId, imageUrl });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
