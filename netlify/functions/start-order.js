// netlify/functions/start-order.js — Supabase validations + upload + prix serveur
// Garde la même API et ajoute { unitPrice, total, currency } dans la réponse.

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";
const ORDERS_DIR = process.env.ORDERS_DIR || "data/orders";

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET  = process.env.SUPABASE_BUCKET || 'images';

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "start-order.supabase.v2" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "start-order.supabase.v2", ...body })
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

// --- GitHub helpers (journalise l'ordre JSON comme avant)
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
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
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
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Payload JSON
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Valider et normaliser (name, linkUrl, blocks)
    const { name, linkUrl, blocks } = await guardFinalizeInput(event);
    if (!Array.isArray(blocks) || blocks.length === 0) return bad(400, "NO_BLOCKS");

    // Image OBLIGATOIRE pour la commande
    const filename    = safeFilename(payload.filename || "image.jpg");
    const contentType = String(payload.contentType || "");
    let   b64         = String(payload.contentBase64 || "");
    if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");
    if (!b64) return bad(400, "NO_FILE_BASE64");
    const m = b64.match(/^data:[^;]+;base64,(.*)$/i);
    if (m) b64 = m[1];

    // ==== Supabase client ====
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    // 1) blocs déjà vendus ?
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells')
      .select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);

    if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
    if (soldRows && soldRows.length) {
      return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });
    }

    // 2) lockés par un autre ?
    const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks')
      .select('idx, uid, until')
      .in('idx', blocks)
      .gt('until', nowIso)
      .neq('uid', uid);

    if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
    if (lockRows && lockRows.length) {
      return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });
    }

    // ==== (NOUVEAU) Prix côté serveur ====
    // prix unitaire = 1 + floor(blocksSold/10)*0.01 (2 décimales)
    const { count, error: countErr } = await supabase
      .from('cells')
      .select('idx', { count: 'exact', head: true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10); // = floor(pixelsSold/1000)
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100; // 2 décimales
    const totalPixels = blocks.length * 100;
    const total       = Math.round((unitPrice * totalPixels) * 100) / 100;
    const currency    = 'USD';

    // ==== Upload image Supabase (final, pas de staging) ====
    const buffer = Buffer.from(b64, "base64");
    const regionId = (await import('node:crypto')).randomUUID(); // UUID DB
    const objectPath = `regions/${regionId}/${filename}`;

    const { data: upRes, error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(objectPath, buffer, { contentType, upsert: true });

    if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const imageUrl = pub?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;

    // ==== Journaliser l'ordre pending (compat GitHub) ====
    const orderId   = makeId("ord");
    const rect      = computeRect(blocks);
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const orderJson = {
      status: "pending",
      uid,
      name,
      linkUrl,
      blocks,
      rect,
      regionId, // uuid DB-friendly
      image: { storage:"supabase", bucket: SUPABASE_BUCKET, path: objectPath, url: imageUrl, contentType },
      // anciens champs (compat)
      amount: payload.amount || null,
      currency,
      // nouveaux champs prix serveur
      unitPrice,
      total,
      createdAt: Date.now(),
      expiresAt: Date.now() + 20*60*1000
    };
    await ghPutJsonWithRetry(orderPath, orderJson, null, `feat: create order ${orderId}`);

    // ==== Réponse ====
    return ok({ orderId, regionId, imageUrl, unitPrice, total, currency });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
