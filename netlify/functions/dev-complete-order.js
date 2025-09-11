// netlify/functions/dev-complete-order.js — Supabase (ne touche plus state.json)
// DEV ONLY: finalise immédiatement une commande sans PayPal.
// Requiert: ALLOW_DEV_COMPLETE=true

const { requireAuth } = require('./auth-middleware');

const ALLOW_DEV_COMPLETE = String(process.env.ALLOW_DEV_COMPLETE || '').toLowerCase() === 'true';

// --- GitHub (on garde juste pour lire l'order JSON existant)
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`,
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

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'dev-complete.supabase.v1' });
const ok  = (b)         => json(200,{ ok:true,  signature:'dev-complete.supabase.v1', ...b });

function isUuid(v){
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!ALLOW_DEV_COMPLETE)        return bad(403, 'DEV_COMPLETE_DISABLED');

    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    let body={}; try{ body = JSON.parse(event.body||'{}'); }catch{ return bad(400,'BAD_JSON'); }
    const orderId = String(body.orderId || '').trim();
    if (!orderId) return bad(400, 'MISSING_ORDER_ID');

    if (!GH_REPO || !GH_TOKEN) return bad(500, 'GITHUB_CONFIG_MISSING');

    // 1) Charger la commande (JSON GitHub)
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const { json: order, sha: orderSha } = await ghGetJson(orderPath);
    if (!order) return bad(404, 'ORDER_NOT_FOUND');
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

    // Idempotence (si déjà complétée côté GitHub, on répond OK pour compat)
    if (order.status === 'completed') {
      return ok({ orderId, status: 'completed', regionId: order.regionId || order.regionDbId, imageUrl: order.finalImageUrl || order.image?.url });
    }

    // 2) Résoudre l’URL image (Supabase attendu ; legacy non supporté ici)
    const imageUrl = order.image?.url || '';
    if (!imageUrl) return bad(400, 'ORDER_NO_IMAGE_URL');

    // 3) Préparer les champs pour la RPC
    const name    = String(order.name || '').trim();
    const linkUrl = String(order.linkUrl || '').trim();
    const blocks  = Array.isArray(order.blocks) ? order.blocks.map(n => parseInt(n,10)).filter(Number.isFinite) : [];

    if (!name || !linkUrl || !blocks.length) return bad(400, 'MISSING_FIELDS');

    // region_id en UUID (si l’existant n’est pas un UUID, on en génère un nouveau)
    const regionIdInput = String(order.regionId || '').trim();
    const regionUuid = isUuid(regionIdInput) ? regionIdInput : (await import('node:crypto')).randomUUID();

    // order uuid pour la DB (indépendant de ton id GitHub)
    const orderUuid = (await import('node:crypto')).randomUUID();

    // 4) Appeler Supabase RPC: finalize_paid_order
    const SUPABASE_URL     = process.env.SUPABASE_URL;
    const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,   // UUID DB (pas celui du fichier GitHub)
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocks,
      _region_id: regionUuid,  // ID de région DB
      _image_url: imageUrl,
      _amount:    null
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();
      if (msg.includes('LOCKS_INVALID'))           return bad(409, 'LOCKS_INVALID');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))               return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 5) Marquer l’order JSON comme completed (compat, non bloquant)
    try {
      const updated = {
        ...order,
        status: 'completed',
        updatedAt: Date.now(),
        finalImageUrl: imageUrl,
        regionDbId: regionUuid
      };
      await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (supabase)`);
    } catch(_){ /* pas bloquant */ }

    // 6) Réponse (le front rafraîchira /status → DB)
    return ok({ orderId, status: 'completed', regionId: regionUuid, imageUrl });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
