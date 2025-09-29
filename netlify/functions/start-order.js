// netlify/functions/start-order.js — Optimisé pour supporter upload immédiat OU pré-uploadé
// POST { name, linkUrl, blocks[], filename, contentType, contentBase64 } 
// OU POST { name, linkUrl, blocks[], imageUrl, regionId } <- NOUVEAU pour image pré-uploadée
// -> { ok:true, orderId, regionId, imageUrl, unitPriceAvg, total, currency }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET  = process.env.SUPABASE_BUCKET || 'images';

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "start-order.supabase.v4" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "start-order.supabase.v4", ...body })
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
  return [...new Set(out)];
}

function isHttpUrl(u){
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

function isValidRegionId(id) {
  // Vérifier si c'est un UUID valide ou un ID temporaire
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || 
         /^temp-\d+$/.test(id);
}

const CHUNK = 800;
function chunkArray(arr, size = CHUNK){
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

exports.handler = async (event) => {
  try {
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Validation commune
    const name    = String(payload.name || '').trim();
    const linkUrl = String(payload.linkUrl || '').trim();
    const blocks  = normalizeBlocks(payload.blocks);
    
    if (!name) return bad(400, "MISSING_NAME");
    if (!linkUrl || !isHttpUrl(linkUrl)) return bad(400, "INVALID_LINK_URL");
    if (!blocks.length) return bad(400, "NO_BLOCKS");

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    // ========================================
    // OPTIMISATION: Détecter le mode d'upload
    // ========================================
    const hasPreUploadedImage = payload.imageUrl && isHttpUrl(payload.imageUrl);
    const hasInlineImage = payload.contentBase64 && payload.contentType;

    if (!hasPreUploadedImage && !hasInlineImage) {
      return bad(400, "MISSING_IMAGE", { message: "Provide either imageUrl (pre-uploaded) or contentBase64 (inline)" });
    }

    // 1) Vérifier déjà vendus
    let soldIdxs = [];
    try {
      const { data: soldList, error: soldErr } = await supabase.rpc('cells_sold_in', { _blocks: blocks });
      if (soldErr) throw soldErr;
      soldIdxs = Array.isArray(soldList) ? soldList.map(Number) : [];
    } catch (_) {
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

    // 2) Vérifier locks par d'autres
    const nowIso = new Date().toISOString();
    let lockedByOther = [];
    try {
      const { data: lockList, error: lockErr } = await supabase.rpc('locks_conflicts_in', {
        _uid: uid,
        _blocks: blocks
      });
      if (lockErr) throw lockErr;
      lockedByOther = Array.isArray(lockList) ? lockList.map(Number) : [];
    } catch (_) {
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

    // 3) Prix côté serveur depuis les locks
    const { data: sumRows, error: sumErr } = await supabase
      .rpc('locks_pricing_sum', { _uid: uid, _blocks: blocks });

    if (sumErr) return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: sumErr.message });

    const row0 = Array.isArray(sumRows) ? sumRows[0] : null;
    const totalCentsRaw   = row0?.total_cents ?? 0;
    const unitPriceAvgRaw = row0?.unit_price_avg ?? null;

    const totalCents = typeof totalCentsRaw === 'string' ? parseInt(totalCentsRaw, 10) : Number(totalCentsRaw);
    const total      = (Number.isFinite(totalCents) ? totalCents : 0) / 100;
    const unitPriceAvg = (unitPriceAvgRaw == null) ? null : Number(unitPriceAvgRaw);
    const currency = 'USD';

    console.log('[start-order] pricing:', { blocks: blocks.length, total_cents: totalCents, unit_price_avg: unitPriceAvg });

    // ========================================
    // 4) GESTION DE L'IMAGE selon le mode
    // ========================================
    let imageUrl;
    let regionUuid;

    if (hasPreUploadedImage) {
      // MODE A: Image déjà uploadée en arrière-plan
      console.log('[start-order] Using pre-uploaded image:', payload.imageUrl);
      
      imageUrl = payload.imageUrl;
      
      // Utiliser le regionId fourni s'il est valide, sinon en générer un nouveau
      if (payload.regionId && isValidRegionId(payload.regionId)) {
        regionUuid = payload.regionId;
      } else {
        const { randomUUID } = await import('node:crypto');
        regionUuid = randomUUID();
      }

      // Vérifier que l'image existe dans le bucket (sécurité)
      try {
        const pathMatch = imageUrl.match(/\/images\/(.+)$/);
        if (pathMatch) {
          const imagePath = pathMatch[1];
          const { data: fileData, error: fileErr } = await supabase
            .storage
            .from(SUPABASE_BUCKET)
            .list(imagePath.split('/').slice(0, -1).join('/'), {
              limit: 1,
              search: imagePath.split('/').pop()
            });
          
          if (fileErr || !fileData || fileData.length === 0) {
            console.warn('[start-order] Pre-uploaded image not found in bucket');
            return bad(400, "INVALID_IMAGE_URL", { message: "Image not found in storage" });
          }
        }
      } catch (verifyErr) {
        console.warn('[start-order] Could not verify image:', verifyErr);
        // On continue quand même - l'URL pourrait être valide
      }

    } else {
      // MODE B: Upload immédiat (ancien comportement)
      console.log('[start-order] Uploading image inline');
      
      const filename = safeFilename(payload.filename || "image.jpg");
      const contentType = String(payload.contentType || "");
      let b64 = String(payload.contentBase64 || "");
      
      if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");
      if (!b64) return bad(400, "NO_FILE_BASE64");
      
      const m = b64.match(/^data:[^;]+;base64,(.*)$/i);
      if (m) b64 = m[1];

      const buffer = Buffer.from(b64, "base64");
      const { randomUUID } = await import('node:crypto');
      regionUuid = randomUUID();
      const objectPath = `regions/${regionUuid}/${filename}`;

      const { error: upErr } = await supabase
        .storage
        .from(SUPABASE_BUCKET)
        .upload(objectPath, buffer, { contentType, upsert: true });
      
      if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

      const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
      imageUrl = pub?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
    }

    // 5) Créer l'order en DB
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
        unit_price: unitPriceAvg,
        total,
        currency:   'USD',
        provider:   'paypal',
        status:     'pending',
        expires_at: expiresAt
      }]);
    
    if (insErr) return bad(500, "DB_INSERT_FAILED", { message: insErr.message });

    console.log('[start-order] Order created:', { orderId, regionId: regionUuid, mode: hasPreUploadedImage ? 'pre-uploaded' : 'inline' });

    return ok({ orderId, regionId: regionUuid, imageUrl, unitPriceAvg, total, currency });

  } catch (e) {
    console.error('[start-order] ERROR', e);
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};