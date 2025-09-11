// netlify/functions/dev-complete-order.js
// DEV ONLY: finalise immédiatement une commande sans PayPal, en utilisant le PRIX SERVEUR.
// Requiert: ALLOW_DEV_COMPLETE=true

const { requireAuth } = require('./auth-middleware');

const ALLOW_DEV_COMPLETE = String(process.env.ALLOW_DEV_COMPLETE || '').toLowerCase() === 'true';

// --- GitHub (lecture/écriture de l'order JSON existant pour compat)
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
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'dev-complete.supabase.v2' });
const ok  = (b)         => json(200,{ ok:true,  signature:'dev-complete.supabase.v2', ...b });

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

    // Idempotence
    if (order.status === 'completed') {
      return ok({
        orderId,
        status: 'completed',
        regionId: order.regionId || order.regionDbId,
        imageUrl: order.finalImageUrl || order.image?.url,
        unitPrice: order.unitPrice || null,
        total: order.total || null,
        currency: order.currency || 'USD'
      });
    }

    // 2) Résoudre l’URL image (Supabase attendu ; legacy non supporté)
    const imageUrl = order.image?.url || '';
    if (!imageUrl) return bad(400, 'ORDER_NO_IMAGE_URL');

    // 3) Préparer les champs pour la RPC
    const name    = String(order.name || '').trim();
    const linkUrl = String(order.linkUrl || '').trim();
    const blocks  = Array.isArray(order.blocks) ? order.blocks.map(n => parseInt(n,10)).filter(Number.isFinite) : [];
    if (!name || !linkUrl || !blocks.length) return bad(400, 'MISSING_FIELDS');

    const regionIdInput = String(order.regionId || '').trim();
    const regionUuid = isUuid(regionIdInput) ? regionIdInput : (await import('node:crypto')).randomUUID();

    const SUPABASE_URL     = process.env.SUPABASE_URL;
    const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 4) PRIX SERVEUR juste avant finaliser
    const { count, error: countErr } = await supabase
      .from('cells')
      .select('idx', { count: 'exact', head: true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);                      // floor(pixelsSold/1000)
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;        // 2 décimales
    const totalPixels = blocks.length * 100;
    const total       = Math.round((unitPrice * totalPixels) * 100) / 100;
    const currency    = order.currency || 'USD';

    // 5) Appeler la RPC (autoritaire). Elle recalculera et refusera si PRICE_CHANGED.
    const orderUuid = (await import('node:crypto')).randomUUID();

    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,   // UUID DB (pas celui du fichier GitHub)
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocks,
      _region_id: regionUuid,
      _image_url: imageUrl,
      _amount:    unitPrice     // on envoie le prix serveur calculé juste avant
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();

      if (msg.includes('PRICE_CHANGED')) {
        // Recalcule une 2e fois pour retourner le prix serveur à jour au front
        const { count: count2 } = await supabase
          .from('cells').select('idx', { count:'exact', head:true })
          .not('sold_at', 'is', null);
        const blocksSold2 = count2 || 0;
        const tier2       = Math.floor(blocksSold2 / 10);
        const unitPrice2  = Math.round((1 + tier2 * 0.01) * 100) / 100;
        const total2      = Math.round(unitPrice2 * totalPixels * 100) / 100;

        return bad(409, 'PRICE_CHANGED', {
          serverUnitPrice: unitPrice2,
          serverTotal: total2,
          currency
        });
      }

      if (msg.includes('LOCKS_INVALID')) return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))    return bad(400, 'NO_BLOCKS');

      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 6) Marquer l’order JSON comme completed (compat, non bloquant)
    try {
      const updated = {
        ...order,
        status: 'completed',
        updatedAt: Date.now(),
        finalImageUrl: imageUrl,
        regionDbId: regionUuid,
        // journalise aussi le prix serveur utilisé
        unitPrice, total, currency
      };
      await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (supabase)`);
    } catch(_){ /* pas bloquant */ }

    // 7) Réponse
    return ok({ orderId, status: 'completed', regionId: regionUuid, imageUrl, unitPrice, total, currency });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
