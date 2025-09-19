// netlify/functions/paypal-create-order.js
const { requireAuth } = require('./auth-middleware');

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV           = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_BASE_URL      = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- anti-414 helpers ----
const CHUNK_SIZE = 400; // assez petit pour l’URL Supabase REST

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function tryRpc(supabase, fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error; // fera tomber dans le fallback
    return { ok: true, data };
  } catch (_) {
    return { ok: false, data: null };
  }
}

async function getSoldIdxs(supabase, blocks) {
  // 1) Tente une RPC (si tu l’as créée côté DB) :
  // create or replace function public.cells_sold_in(p_blocks int[])
  // returns table(idx int) language sql as $$
  //   select idx from public.cells where idx = any(p_blocks) and sold_at is not null
  // $$;
  const viaRpc = await tryRpc(supabase, 'cells_sold_in', { p_blocks: blocks });
  if (viaRpc.ok) return viaRpc.data || [];

  // 2) Fallback: batch .in(...).not(...) pour éviter une URL géante
  const batches = chunk(blocks, CHUNK_SIZE);
  const sold = [];
  for (const b of batches) {
    const { data, error } = await supabase
      .from('cells').select('idx')
      .in('idx', b)
      .not('sold_at', 'is', null);
    if (error) throw Object.assign(new Error('CELLS_QUERY_FAILED'), { details: error });
    if (data?.length) sold.push(...data.map(r => Number(r.idx)));
  }
  return sold;
}

async function getLockConflicts(supabase, blocks, uid, nowIso) {
  // 1) Tente une RPC (si dispo) :
  // create or replace function public.locks_conflicts(p_blocks int[], p_uid uuid, p_now timestamptz)
  // returns table(idx int, uid uuid, until timestamptz) language sql as $$
  //   select idx, uid, until from public.locks
  //   where idx = any(p_blocks) and until > p_now and uid <> p_uid
  // $$;
  const viaRpc = await tryRpc(supabase, 'locks_conflicts', { p_blocks: blocks, p_uid: uid, p_now: nowIso });
  if (viaRpc.ok) return viaRpc.data || [];

  // 2) Fallback: batch .in(...).gt(...).neq(...)
  const batches = chunk(blocks, CHUNK_SIZE);
  const conflicts = [];
  for (const b of batches) {
    const { data, error } = await supabase
      .from('locks').select('idx, uid, until')
      .in('idx', b)
      .gt('until', nowIso)
      .neq('uid', uid);
    if (error) throw Object.assign(new Error('LOCKS_QUERY_FAILED'), { details: error });
    if (data?.length) conflicts.push(...data);
  }
  return conflicts;
}

function j(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'paypal-create-order.v4' });
const ok  = (b)           => j(200,{ ok:true,  signature:'paypal-create-order.v4', ...b });

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
    if (auth?.statusCode) return auth;
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

    // 1) Charger l’ordre
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, 'ORDER_NOT_FOUND');
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');
    if (order.status === 'completed')   return bad(409, 'ALREADY_COMPLETED');

    if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
      try {
        await supabase.from('orders')
          .update({ status: 'expired', updated_at: new Date().toISOString() })
          .eq('order_id', orderId);
      } catch (_) {}
      return bad(409, 'ORDER_EXPIRED');
    }

    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');

    // 2) Vérifs "sold" & "locks" -> RPC si dispo, sinon batch .in(...)
    let soldRows, lockRows;
    try {
      const soldIdxs = await getSoldIdxs(supabase, blocks);
      soldRows = soldIdxs?.map(idx => ({ idx: Number(idx) })) || [];
    } catch (e) {
      if (e.message === 'CELLS_QUERY_FAILED') return bad(500, 'CELLS_QUERY_FAILED', { message: e.details?.message || String(e.details || e) });
      throw e;
    }
    if (soldRows.length) return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });

    const nowIso = new Date().toISOString();
    try {
      lockRows = await getLockConflicts(supabase, blocks, uid, nowIso);
    } catch (e) {
      if (e.message === 'LOCKS_QUERY_FAILED') return bad(500, 'LOCKS_QUERY_FAILED', { message: e.details?.message || String(e.details || e) });
      throw e;
    }
    if (lockRows?.length) return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });

    // 3) Prix serveur
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

    if ((order.unit_price != null && Number(order.unit_price) !== unitPrice) ||
        (order.total      != null && Number(order.total)      !== total)) {
      try {
        await supabase.from('orders').update({
          server_unit_price: unitPrice,
          server_total: total,
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);
      } catch(_) {}
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal: total, currency });
    }

    // 4) Créer l’ordre PayPal
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

    // 5) Persister
    try {
      await supabase.from('orders').update({
        paypal_order_id: ppOrder.id,
        unit_price: unitPrice,
        total: total,
        currency: currency,
        provider: 'paypal',
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);
    } catch (_) {}

    return ok({ id: ppOrder.id, status: ppOrder.status || 'CREATED' });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
