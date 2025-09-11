// netlify/functions/finalize.js — Supabase version (plus de state.json)
// Compat réponse: { ok:true, regionId, rect, soldCount }
// Contrainte: locks en DB (table locks), vente atomique via RPC finalize_paid_order

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function respond(status, obj) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => respond(s, { ok:false, error:e, ...extra, signature:"finalize.supabase.v1" });
const ok  = (b)           => respond(200, { ok:true,  signature:"finalize.supabase.v1", ...b });

function computeRect(blocks){
  let minR=Infinity, maxR=-Infinity, minC=Infinity, maxC=-Infinity;
  for (const idx of blocks) {
    const r = Math.floor(idx / 100);
    const c = idx % 100;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  return { x: minC, y: minR, w: (maxC - minC + 1), h: (maxR - minR + 1) };
}
function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try {
    // Auth
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Valide et normalise (name, linkUrl, blocks)
    const { name, linkUrl, blocks } = await guardFinalizeInput(event);
    if (!Array.isArray(blocks) || blocks.length === 0) return bad(400, "NO_BLOCKS");

    // RegionId DB = UUID (on génère si absent/non-UUID)
    let reqBody = {};
    try { reqBody = event.body ? JSON.parse(event.body) : {}; } catch {}
    const candidateRegion = String(reqBody.regionId || "").trim();
    const regionId = isUuid(candidateRegion) ? candidateRegion : (await import('node:crypto')).randomUUID();

    // Rect pour le retour (UI)
    const rect = computeRect(blocks);

    // Appel Supabase RPC (tout-ou-rien)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // order_id DB détaché de ton id front (utile pour traces/facturation ultérieure)
    const orderUuid = (await import('node:crypto')).randomUUID();

    // Ici pas de paiement → _amount:null, _image_url:null (l’image peut être liée ensuite via /link-image DB)
    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocks,
      _region_id: regionId,
      _image_url: null,
      _amount:    null
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();
      if (msg.includes('LOCKS_INVALID'))           return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))               return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // Succès → le front rafraîchit /status (DB) et voit sold + regions
    return ok({ regionId, rect, soldCount: blocks.length });

  } catch (e) {
    return bad(500, "FINALIZE_FAILED", { message: String(e?.message || e) });
  }
};
