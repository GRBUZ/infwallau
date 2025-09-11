// netlify/functions/finalize_paid_order.js
// Finalisation atomique via Supabase RPC finalize_paid_order (plus de state.json).
// Modes:
//  A) POST { name, linkUrl, blocks[], regionId?, imageUrl?, amount? }  -> finalise direct
//  B) POST { orderId }  -> charge data/orders/<orderId>.json (GitHub), vérifie ownership, finalise
//
// Réponse: { ok:true, status:"completed", regionId, imageUrl, orderId? }

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');

// --- Supabase
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- GitHub (optionnel, pour mode "orderId")
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'finalize_paid_order.v1' });
const ok  = (b)           => json(200,{ ok:true,  signature:'finalize_paid_order.v1', ...b });

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
async function ghGetJson(path){
  if (!GH_REPO || !GH_TOKEN) return { json:null, sha:null };
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`,
    { headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept':'application/vnd.github+json' } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}
async function ghPutJson(path, jsonData, sha, message){
  if (!GH_REPO || !GH_TOKEN) return null;
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING');

    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    let body={}; try { body = JSON.parse(event.body || '{}'); } catch { return bad(400,'BAD_JSON'); }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    let name, linkUrl, blocks, regionId, imageUrl = null, amount = null, orderId = null;

    if (body.orderId) {
      // === Mode B: depuis un order GitHub ===
      orderId = String(body.orderId || '').trim();
      if (!orderId) return bad(400, 'MISSING_ORDER_ID');

      const orderPath = `${ORDERS_DIR}/${orderId}.json`;
      const { json: order, sha: orderSha } = await ghGetJson(orderPath);
      if (!order) return bad(404, 'ORDER_NOT_FOUND');
      if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

      name    = String(order.name || '').trim();
      linkUrl = String(order.linkUrl || '').trim();
      blocks  = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
      regionId= String(order.regionId || '').trim();
      imageUrl= order.image?.url || order.finalImageUrl || null;
      amount  = order.amount ?? null;

      if (!name || !linkUrl || !blocks.length) return bad(400, 'MISSING_FIELDS');
      if (!isUuid(regionId)) regionId = (await import('node:crypto')).randomUUID();

      // Appel RPC
      const orderUuid = (await import('node:crypto')).randomUUID();
      const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
        _order_id:  orderUuid,
        _uid:       uid,
        _name:      name,
        _link_url:  linkUrl,
        _blocks:    blocks,
        _region_id: regionId,
        _image_url: imageUrl || null,
        _amount:    amount
      });

      if (rpcErr) {
        const msg = (rpcErr.message || '').toUpperCase();
        if (msg.includes('LOCKS_INVALID'))                         return bad(409, 'LOCK_MISSING_OR_EXPIRED');
        if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
        if (msg.includes('NO_BLOCKS'))                             return bad(400, 'NO_BLOCKS');
        return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
      }

      // Best-effort : marquer l'order GH comme completed
      try {
        const updated = { ...order, status:'completed', updatedAt: Date.now(), finalImageUrl: imageUrl, regionDbId: regionId };
        await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (rpc)`);
      } catch(_){}

      return ok({ status:'completed', orderId, regionId, imageUrl: imageUrl || null });

    } else {
      // === Mode A: direct ===
      // Réutilise ta validation (name, linkUrl, blocks)
      const validated = await guardFinalizeInput(event);
      name    = validated.name;
      linkUrl = validated.linkUrl;
      blocks  = validated.blocks;

      // regionId / imageUrl / amount venant du body (optionnels)
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
        _amount:    amount
      });

      if (rpcErr) {
        const msg = (rpcErr.message || '').toUpperCase();
        if (msg.includes('LOCKS_INVALID'))                         return bad(409, 'LOCK_MISSING_OR_EXPIRED');
        if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
        if (msg.includes('NO_BLOCKS'))                             return bad(400, 'NO_BLOCKS');
        return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
      }

      return ok({ status:'completed', regionId, imageUrl: imageUrl || null });
    }

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
