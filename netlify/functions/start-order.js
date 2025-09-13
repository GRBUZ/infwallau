// netlify/functions/start-order.js — 100% Supabase, plus de GitHub
// API identique: renvoie { orderId, regionId, imageUrl, unitPrice, total, currency }

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');

// --- Supabase
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET  = process.env.SUPABASE_BUCKET || 'images';

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "start-order.supabase.v3" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "start-order.supabase.v3", ...body })
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

exports.handler = async (event) => {
  try {
    // Auth (ton requireAuth renvoie un objet OU une réponse 401 prête)
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Payload JSON
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Valider et normaliser (name, linkUrl, blocks) — réutilise ta validation
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

    // 3) Prix côté serveur
    // unitPrice = 1 + floor(blocksSold/10)*0.01 (2 décimales)
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

    // 4) Upload image (Supabase Storage)
    const buffer    = Buffer.from(b64, "base64");
    const regionId  = (await import('node:crypto')).then(m => m.randomUUID());
    const regionUuid= await regionId;

    const objectPath = `regions/${regionUuid}/${filename}`;
    const { data: upRes, error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(objectPath, buffer, { contentType, upsert: true });
    if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const imageUrl = pub?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;

    // 5) Créer la commande en DB (table `orders`)
    const orderId = makeId("ord");
    const expiresAt = new Date(Date.now() + 20*60*1000).toISOString();

    const { error: insErr } = await supabase
      .from('orders')
      .insert([{
        order_id:   orderId,
        uid,
        name,
        link_url:   linkUrl,
        blocks,
        region_id:  regionUuid,
        image_url:  imageUrl,
        unit_price: unitPrice,
        total,
        currency,
        provider:   'paypal',
        status:     'pending',
        expires_at: expiresAt
      }]);

    if (insErr) return bad(500, 'ORDERS_INSERT_FAILED', { message: insErr.message });

    // 6) Réponse (API inchangée)
    return ok({ orderId, regionId: regionUuid, imageUrl, unitPrice, total, currency });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
