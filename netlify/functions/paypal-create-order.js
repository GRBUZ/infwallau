// netlify/functions/paypal-create-order.js
const { requireAuth } = require('./auth-middleware');

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV           = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_BASE_URL      = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){
  return { statusCode: status, headers: { 'content-type':'application/json', 'cache-control':'no-store' }, body: JSON.stringify(obj) };
}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'paypal-create-order.v2' });
const ok  = (b)           => j(200,{ ok:true,  signature:'paypal-create-order.v2', ...b });

async function ghGetJson(path){
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`, {
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" }
  });
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
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CONFIG_MISSING');
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`PAYPAL_TOKEN_FAILED:${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('PAYPAL_TOKEN_NO_ACCESS_TOKEN');
  return j.access_token;
}

// Remplace TOUT ce bloc exports.handler par celui-ci :

exports.handler = async (event) => {
  // --- AUTH d'abord (utilise ton auth-middleware tel qu’on l’a fixé) ---
  const auth = requireAuth(event);           // <- appelle le middleware avec l'event
  if (!auth.authenticated) return auth;      // <- en cas d'échec, c'est déjà un {statusCode:401,...}
  const { uid } = auth;                      // <- récupère l'UID du token
  event.auth = auth;                         // (optionnel) si d'autres utilitaires lisent event.auth

  // --- le reste est ta logique inchangée ---
  if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
  if (!GH_REPO || !GH_TOKEN)       return bad(500, 'GITHUB_CONFIG_MISSING');
  if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, 'BAD_JSON'); }
  const orderId = String(body.orderId || '').trim();
  if (!orderId) return bad(400, 'MISSING_ORDER_ID');

  // 1) Charger l’ordre préparé par /start-order
  const orderPath = `${ORDERS_DIR}/${orderId}.json`;
  const { json: order, sha: orderSha } = await ghGetJson(orderPath);
  if (!order) return bad(404, 'ORDER_NOT_FOUND');
  if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

  const blocks = Array.isArray(order.blocks) ? order.blocks.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
  if (!blocks.length) return bad(400, 'NO_BLOCKS');

  // 2) Vérifs Supabase: déjà vendus ? locks par autre ?
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

  const { data: soldRows, error: soldErr } = await supabase
    .from('cells').select('idx')
    .in('idx', blocks)
    .not('sold_at', 'is', null);
  if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
  if (soldRows && soldRows.length) return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });

  const nowIso = new Date().toISOString();
  const { data: lockRows, error: lockErr } = await supabase
    .from('locks').select('idx, uid, until')
    .in('idx', blocks)
    .gt('until', nowIso)
    .neq('uid', uid);
  if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
  if (lockRows && lockRows.length) return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });

  // 3) Prix serveur
  const { count, error: countErr } = await supabase
    .from('cells').select('idx', { count: 'exact', head: true })
    .not('sold_at', 'is', null);
  if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

  const blocksSold = count || 0;
  const tier = Math.floor(blocksSold / 10);
  const unitPrice = Math.round((1 + tier * 0.01) * 100) / 100;
  const totalPixels = blocks.length * 100;
  const total = Math.round(unitPrice * totalPixels * 100) / 100;
  const currency = (order.currency || 'USD').toUpperCase();

  if (order.unitPrice != null && Number(order.unitPrice) !== unitPrice) {
    const patched = { ...order, priceChangedAt: Date.now(), serverUnitPrice: unitPrice, serverTotal: total };
    try { await ghPutJson(orderPath, patched, orderSha, `chore: price changed for ${orderId}`); } catch {}
    return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal: total, currency });
  }

  // 4) Créer la commande PayPal avec le montant serveur
  const accessToken = await getPayPalAccessToken();
  const ppOrderData = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: currency, value: total.toFixed(2) },
      description: `${blocks.length} blocks (${totalPixels} px)`,
      custom_id: orderId,
      invoice_id: orderId
    }],
    application_context: {
      brand_name: 'Million Pixels',
      landing_page: 'BILLING',
      user_action: 'PAY_NOW'
    }
  };

  const createResponse = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // Pour être sûr d'avoir le corps JSON complet :
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(ppOrderData)
  });

  if (!createResponse.ok) {
    const err = await createResponse.json().catch(() => ({}));
    return bad(500, 'PAYPAL_CREATE_FAILED', { details: err });
  }

  const ppOrder = await createResponse.json();

  // 5) Persister le paypalOrderId dans l’order JSON
  try {
    const updated = { ...order, paypalOrderId: ppOrder.id, unitPrice, total, currency, updatedAt: Date.now() };
    await ghPutJson(orderPath, updated, orderSha, `chore: paypal order created ${ppOrder.id}`);
  } catch (_) {}

  return ok({ id: ppOrder.id, status: ppOrder.status || 'CREATED' });
};

