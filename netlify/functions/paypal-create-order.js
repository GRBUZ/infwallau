// netlify/functions/paypal-create-order.js
const { requireAuth } = require('./auth-middleware');

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV           = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_BASE_URL      = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'paypal-create-order.v3' });
const ok  = (b)           => j(200,{ ok:true,  signature:'paypal-create-order.v3', ...b });

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

exports.handler = async (event) => {
  try {
    // --- AUTH ---
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth; // middleware renvoie déjà une réponse 401 JSON
    const { uid } = auth;
    if (!uid) return bad(401, 'UNAUTHORIZED');

    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, 'BAD_JSON'); }
    const orderId = String(body.orderId || '').trim();
    if (!orderId) return bad(400, 'MISSING_ORDER_ID');

    // --- Supabase client ---
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    // 1) Charger l’ordre préparé par /start-order (table orders)
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, 'ORDER_NOT_FOUND');

    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');
    if (order.status === 'completed')   return bad(409, 'ALREADY_COMPLETED');
    if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
      // on passe en expiré (best-effort)
      try {
        await supabase.from('orders').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('order_id', orderId);
      } catch (_) {}
      return bad(409, 'ORDER_EXPIRED');
    }

    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');

    // 2) Vérifs Supabase: déjà vendus ? locks par autre ?
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

    // 3) Prix serveur (toujours la source de vérité)
    const { count, error: countErr } = await supabase
      .from('cells')
      .select('idx', { count: 'exact', head: true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;
    const totalPixels = blocks.length * 100;
    const total       = Math.round(unitPrice * totalPixels * 100) / 100;
    const currency    = String(order.currency || 'USD').toUpperCase();

    // Si la ligne orders contient déjà un prix différent -> signaler PRICE_CHANGED
    if ((order.unit_price != null && Number(order.unit_price) !== unitPrice) ||
        (order.total      != null && Number(order.total)      !== total)) {
      // journal DB (best-effort)
      try {
        await supabase.from('orders').update({
          server_unit_price: unitPrice,
          server_total: total,
          updated_at: new Date().toISOString()
        })
        .eq('order_id', orderId);
      } catch(_) {}
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
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(ppOrderData)
    });

    if (!createResponse.ok) {
      const err = await createResponse.json().catch(() => ({}));
      return bad(500, 'PAYPAL_CREATE_FAILED', { details: err });
    }

    const ppOrder = await createResponse.json();

    // 5) Persister paypal_order_id + prix serveur (source de vérité)
    try {
      await supabase.from('orders').update({
        paypal_order_id: ppOrder.id,
        unit_price: unitPrice,
        total: total,
        currency: currency,
        provider: 'paypal',
        updated_at: new Date().toISOString()
      })
      .eq('order_id', orderId);
    } catch (_) {}

    return ok({ id: ppOrder.id, status: ppOrder.status || 'CREATED' });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
