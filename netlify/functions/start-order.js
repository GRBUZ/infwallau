// netlify/functions/start-order.js — 100% Supabase (plus de GitHub)
// POST { name, linkUrl, blocks[], filename, contentType, contentBase64 } 
// -> { ok:true, orderId, regionId, imageUrl, unitPrice, total, currency }

const { requireAuth } = require('./auth-middleware');

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
function normalizeBlocks(arr){
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const n of arr) {
    const v = parseInt(n, 10);
    if (Number.isFinite(v) && v >= 0) out.push(v);
  }
  // dédupe
  return [...new Set(out)];
}
function isHttpUrl(u){
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

// --- helpers pour fallback chunké (éviter URL trop longues)
const CHUNK = 800;
function chunkArray(arr, size = CHUNK){
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

exports.handler = async (event) => {
  try {
    // Auth
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Payload
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Validation minimale inline (pour éviter tout .then() caché dans un util)
    const name    = String(payload.name || '').trim();
    const linkUrl = String(payload.linkUrl || '').trim();
    const blocks  = normalizeBlocks(payload.blocks);
    if (!name) return bad(400, "MISSING_NAME");
    if (!linkUrl || !isHttpUrl(linkUrl)) return bad(400, "INVALID_LINK_URL");
    if (!blocks.length) return bad(400, "NO_BLOCKS");

    // Image requise pour l’ordre
    const filename    = safeFilename(payload.filename || "image.jpg");
    const contentType = String(payload.contentType || "");
    let   b64         = String(payload.contentBase64 || "");
    if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");
    if (!b64) return bad(400, "NO_FILE_BASE64");
    const m = b64.match(/^data:[^;]+;base64,(.*)$/i);
    if (m) b64 = m[1];

    // Supabase
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    // 1) déjà vendus ? (→ RPC si dispo, sinon fallback chunké)
    let soldIdxs = [];
    let soldRpcFailed = false;
    try {
      // nécessite la fonction: create or replace function public.cells_sold_in(_blocks int[]) returns setof int ...
      const { data: soldList, error: soldErr } = await supabase.rpc('cells_sold_in', { _blocks: blocks });
      if (soldErr) throw soldErr;
      soldIdxs = Array.isArray(soldList) ? soldList.map(Number) : [];
    } catch (_) {
      soldRpcFailed = true;
    }

    if (soldRpcFailed) {
      soldIdxs = [];
      for (const part of chunkArray(blocks)) {
        const { data, error } = await supabase
          .from('cells')
          .select('idx')
          .in('idx', part)
          .not('sold_at', 'is', null);
        if (error) return bad(500, 'CELLS_QUERY_FAILED', { message: error.message });
        if (data && data.length) soldIdxs.push(...data.map(r => Number(r.idx)));
      }
    }

    if (soldIdxs.length) return bad(409, 'ALREADY_SOLD', { idx: soldIdxs[0] });

    // 2) lockés par un autre ? (→ RPC si dispo, sinon fallback chunké)
    const nowIso = new Date().toISOString();
    let lockedByOther = [];
    let lockRpcFailed = false;
    try {
      // nécessite la fonction:
      // create or replace function public.locks_conflicts_in(_uid text, _blocks int[]) returns setof int
      //   as $$ select idx from public.locks where idx = any(_blocks) and until > now() and uid <> _uid $$;
      const { data: lockList, error: lockErr } = await supabase.rpc('locks_conflicts_in', {
        _uid: uid,
        _blocks: blocks
      });
      if (lockErr) throw lockErr;
      lockedByOther = Array.isArray(lockList) ? lockList.map(Number) : [];
    } catch (_) {
      lockRpcFailed = true;
    }

    if (lockRpcFailed) {
      lockedByOther = [];
      for (const part of chunkArray(blocks)) {
        const { data, error } = await supabase
          .from('locks')
          .select('idx')
          .in('idx', part)
          .gt('until', nowIso)
          .neq('uid', uid);
        if (error) return bad(500, 'LOCKS_QUERY_FAILED', { message: error.message });
        if (data && data.length) lockedByOther.push(...data.map(r => Number(r.idx)));
      }
    }

    if (lockedByOther.length) return bad(409, 'LOCKED_BY_OTHER', { idx: lockedByOther[0] });
    
    //new
    // 3) Prix côté serveur — à partir des locks (prix garantis par bloc)
/*const { data: myLocks, error: myErr } = await supabase
  .rpc('locks_by_uid_in', { _uid: uid, _blocks: blocks });
if (myErr) return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: myErr.message });

const total = (Array.isArray(myLocks) ? myLocks : [])
  .reduce((acc, r) => acc + Number(r.unit_price || r.unitPrice || 0) * 100, 0);
const currency = 'USD';
// (facultatif, pour lisibilité) moyenne unitaire = total / pixels
const totalPixels = blocks.length * 100;
const unitPriceAvg = totalPixels ? Math.round((total/totalPixels) * 100) / 100 : null;*/

//new new
// 3) Prix côté serveur — somme et moyenne calculées 100% en SQL
const { data: sumRows, error: sumErr } = await supabase
  .rpc('locks_pricing_sum', { _uid: uid, _blocks: blocks });

if (sumErr) return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: sumErr.message });

// Supabase → array; on prend la première ligne
const row0 = Array.isArray(sumRows) ? sumRows[0] : null;

// champs attendus en snake_case depuis la RPC
const totalCentsRaw   = row0?.total_cents ?? 0;     // peut arriver comme number ou string
const unitPriceAvgRaw = row0?.unit_price_avg ?? null;

// conversions sûres
const totalCents = typeof totalCentsRaw === 'string' ? parseInt(totalCentsRaw, 10) : Number(totalCentsRaw);
const total      = (Number.isFinite(totalCents) ? totalCents : 0) / 100;

// unit price moyen (en $/px), peut être null si aucun lock
const unitPriceAvg = (unitPriceAvgRaw == null) ? null : Number(unitPriceAvgRaw);

const currency = 'USD';

console.warn('[pricing_sum]', {
  blocks: blocks.length,
  total_cents: totalCents,
  unit_price_avg: unitPriceAvg
});

//new new


    // 4) Upload image
    const buffer = Buffer.from(b64, "base64");
    const { randomUUID } = await import('node:crypto');
    const regionUuid = randomUUID();
    const objectPath = `regions/${regionUuid}/${filename}`;

    const { error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(objectPath, buffer, { contentType, upsert: true });
    if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

    // getPublicUrl est SYNCHRONE en supabase-js v2 → pas de .then() ici
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const imageUrl = pub?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;

    // 5) Créer l’order (DB)
    const orderId   = makeId("ord"); // identifiant “lisible” côté front
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
        //unit_price: unitPriceAvg,
        unit_price: unitPriceToStore,
        total,
        currency:   'USD',
        provider:   'paypal',
        status:     'pending',
        expires_at: expiresAt
      }]);
    if (insErr) return bad(500, "DB_INSERT_FAILED", { message: insErr.message });

    // 6) Locks 2 minutes pour l’UID (best-effort)
    //const until = new Date(Date.now() + 2*60*1000).toISOString();
    //const lockRowsNew = blocks.map(idx => ({ idx, uid, until }));
    //await supabase.from('locks').upsert(lockRowsNew, { onConflict: 'idx' });

    return ok({ orderId, regionId: regionUuid, imageUrl, unitPriceAvg, total, currency });

  } catch (e) {
    // Log côté fonction et renvoyer un message clair
    console.error('[start-order] ERROR', e);
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
