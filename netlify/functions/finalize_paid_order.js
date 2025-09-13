// netlify/functions/finalize_paid_order.js
// Finalisation atomique via Supabase RPC finalize_paid_order (100% Supabase, plus de state.json/GitHub).
// Modes:
//  A) POST { name, linkUrl, blocks[], regionId?, imageUrl?, amount? }  -> finalise direct
//  B) POST { orderId }  -> charge la ligne dans table 'orders' (order_id), vérifie ownership, finalise
//
// Réponse: { ok:true, status:"completed", regionId, imageUrl, orderId? }

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');

// --- Supabase
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'finalize_paid_order.supabase.v1' });
const ok  = (b)           => json(200,{ ok:true,  signature:'finalize_paid_order.supabase.v1', ...b });

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING');

    // Auth obligatoire
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    // Parse body
    let body={}; try { body = JSON.parse(event.body || '{}'); } catch { return bad(400,'BAD_JSON'); }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    let name, linkUrl, blocks, regionId, imageUrl = null, amount = null, orderId = null;

    if (body.orderId) {
      // === Mode B: depuis une ligne 'orders' Supabase ===
      orderId = String(body.orderId || '').trim();
      if (!orderId) return bad(400, 'MISSING_ORDER_ID');

      // Charger la commande en base
      const { data: ord, error: selErr } = await supabase
        .from('orders')
        .select('uid, name, link_url, blocks, region_id, image_url, amount, total, currency, status, updated_at')
        .eq('order_id', orderId)
        .single();

      if (selErr) return bad(500, 'ORDERS_SELECT_FAILED', { message: selErr.message });
      if (!ord)   return bad(404, 'ORDER_NOT_FOUND');

      if (ord.uid && ord.uid !== uid) return bad(403, 'FORBIDDEN');
      if (!Array.isArray(ord.blocks) || !ord.blocks.length) return bad(400, 'NO_BLOCKS');

      // Si déjà finalisée, idempotence
      if (String(ord.status || '').toLowerCase() === 'completed') {
        return ok({ status:'completed', orderId, regionId: ord.region_id, imageUrl: ord.image_url || null });
      }

      name     = String(ord.name || '').trim();
      linkUrl  = String(ord.link_url || '').trim();
      blocks   = ord.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite);
      regionId = String(ord.region_id || '').trim();
      imageUrl = ord.image_url || null;
      // montant: si amount présent, sinon total, sinon null
      amount   = (ord.amount != null) ? Number(ord.amount) : (ord.total != null ? Number(ord.total) : null);

      if (!name || !linkUrl || !blocks.length) return bad(400, 'MISSING_FIELDS');
      if (!isUuid(regionId)) regionId = (await import('node:crypto')).randomUUID();

      // Appel RPC atomique
      const orderUuid = (await import('node:crypto')).randomUUID();
      const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
        _order_id:  orderUuid,
        _uid:       uid,
        _name:      name,
        _link_url:  linkUrl,
        _blocks:    blocks,
        _region_id: regionId,
        _image_url: imageUrl || null,
        _amount:    (amount != null ? Number(amount) : null)
      });

      if (rpcErr) {
        const msg = (rpcErr.message || '').toUpperCase();
        if (msg.includes('LOCKS_INVALID'))                          return bad(409, 'LOCK_MISSING_OR_EXPIRED');
        if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
        if (msg.includes('NO_BLOCKS'))                              return bad(400, 'NO_BLOCKS');
        if (msg.includes('PRICE_CHANGED'))                          return bad(409, 'PRICE_CHANGED');
        return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
      }

      // Marquer la ligne comme complétée (best-effort)
      try {
        const { error: upErr } = await supabase
          .from('orders')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('order_id', orderId);
        if (upErr) console.warn('[finalize_paid_order] orders.update failed:', upErr.message);
      } catch (_) {}

      return ok({ status:'completed', orderId, regionId, imageUrl: imageUrl || null });

    } else {
      // === Mode A: direct ===
      const validated = await guardFinalizeInput(event);
      name    = validated.name;
      linkUrl = validated.linkUrl;
      blocks  = validated.blocks;

      const candidateRegion = String(body.regionId || '').trim();
      regionId = isUuid(candidateRegion) ? candidateRegion : (await import('node:crypto')).randomUUID();
      imageUrl = (typeof body.imageUrl === 'string' && body.imageUrl.trim()) ? body.imageUrl.trim() : null;

      if (body.amount != null) {
        const a = Number(body.amount);
        if (!Number.isFinite(a) || a < 0) return bad(400, 'INVALID_AMOUNT');
        amount = a;
      }

      const orderUuid = (await import('node:crypto')).randomUUID();
      const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
        _order_id:  orderUuid,
        _uid:       uid,
        _name:      name,
        _link_url:  linkUrl,
        _blocks:    blocks,
        _region_id: regionId,
        _image_url: imageUrl || null,
        _amount:    (amount != null ? Number(amount) : null)
      });

      if (rpcErr) {
        const msg = (rpcErr.message || '').toUpperCase();
        if (msg.includes('LOCKS_INVALID'))                          return bad(409, 'LOCK_MISSING_OR_EXPIRED');
        if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
        if (msg.includes('NO_BLOCKS'))                              return bad(400, 'NO_BLOCKS');
        if (msg.includes('PRICE_CHANGED'))                          return bad(409, 'PRICE_CHANGED');
        return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
      }

      return ok({ status:'completed', regionId, imageUrl: imageUrl || null });
    }

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
