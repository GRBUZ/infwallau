// netlify/functions/paypal-webhook.js
// Webhook PayPal -> finalisation server-side (prix serveur, tout ou rien, via Supabase RPC)

const PAYPAL_BASE_URL  = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { verifyPayPalWebhook } = require('./_paypal-verify');
const { logManualRefundNeeded } = require('./_manual-refund-logger');

//refund fail simu
const FORCE_REFUND_FAIL = true; 
//refund fail simu

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-webhook.v5' });
const ok  = (b)            => json(200,{ ok:true,  signature:'paypal-webhook.v5', ...b });

function isUuid(v){
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CONFIG_MISSING');
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) {
    const err = await r.json().catch(()=>({}));
    throw new Error(`PAYPAL_TOKEN_FAILED:${r.status}:${err.error || ''}`);
  }
  const j = await r.json();
  return j.access_token;
}

async function getOrderCustomId(accessToken, paypalOrderId){
  const orderRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type':'application/json' }
  });
  if (!orderRes.ok) return { customId:null };
  const orderJson = await orderRes.json().catch(()=>({}));
  const customId = orderJson?.purchase_units?.[0]?.custom_id || null;
  return { customId, orderJson };
}

// Refund PayPal (amount/currency optionnels -> full refund si omis)
async function refundPayPalCapture(accessToken, captureId, amount, currency) {
  //refund fail simu
  // 🎯 Test mode: forcer l’échec du refund
  if (FORCE_REFUND_FAIL) {
    throw new Error('TEST_FORCED_REFUND_FAIL');
  }
  //refund fail simu
  try {
    const body = (Number.isFinite(amount) && currency)
      ? { amount: { value: Number(amount).toFixed(2), currency_code: String(currency).toUpperCase() } }
      : {};
    const resp = await fetch(`${PAYPAL_BASE_URL}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(body)
    });
    const j = await resp.json().catch(()=> ({}));
    if (!resp.ok) throw new Error(`PAYPAL_REFUND_FAILED:${resp.status}:${j?.name || ''}`);
    return j; // { id, status, ... }
  } catch (e) {
    console.error('[PayPal Webhook] refund failed:', e);
    return null; // best-effort
  }
}

// utils
const CHUNK = 1000;
const chunk = (arr, n=CHUNK) => {
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i, i+n));
  return out;
};

// Libération des locks (chunkée)
async function releaseLocks(supabase, blocks, uid) {
  try {
    if (!Array.isArray(blocks) || !blocks.length || !uid) return;
    for (const slice of chunk(Array.from(new Set(blocks)))) {
      await supabase.from('locks').delete().in('idx', slice).eq('uid', uid);
    }
  } catch (_) { /* best-effort */ }
}

// --- helpers RPC-first ---
async function countSoldConflicts(supabase, blocks) {
  // 1) Essayer le RPC cells_sold_in(_idxs)
  try {
    const { data, error } = await supabase.rpc('cells_sold_in', { _idxs: blocks });
    if (!error && Array.isArray(data)) return data.length;
  } catch (_) {}
  // 2) Fallback: count exact en tranches (head:true)
  let total = 0;
  for (const slice of chunk(blocks)) {
    const { count, error } = await supabase
      .from('cells')
      .select('idx', { count:'exact', head:true })
      .in('idx', slice)
      .not('sold_at', 'is', null);
    if (error) throw Object.assign(new Error(error.message), { code: 'CELLS_QUERY_FAILED' });
    total += (count || 0);
    if (total > 0) break; // early-exit, on veut juste savoir s’il y en a
  }
  return total;
}

async function countLocksByOthers(supabase, blocks, uid) {
  // 1) Essayer le RPC locks_conflicts_in(_idxs, _uid) -> renvoie les locks d’un autre uid
  try {
    const { data, error } = await supabase.rpc('locks_conflicts_in', { _idxs: blocks, _uid: uid });
    if (!error && Array.isArray(data)) return data.length;
  } catch (_) {}
  // 2) Fallback: count exact en tranches
  let total = 0;
  const nowIso = new Date().toISOString();
  for (const slice of chunk(blocks)) {
    const { count, error } = await supabase
      .from('locks')
      .select('idx', { count:'exact', head:true })
      .in('idx', slice)
      .gt('until', nowIso)
      .neq('uid', uid);
    if (error) throw Object.assign(new Error(error.message), { code: 'LOCKS_QUERY_FAILED' });
    total += (count || 0);
    if (total > 0) break;
  }
  return total;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // --- 1) Signature PayPal (raw body)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');

    const { verified } = await verifyPayPalWebhook(event.headers || {}, rawBody);
    if (!verified) return bad(401, 'UNAUTHORIZED');

    const body = JSON.parse(rawBody);
    const eventType = String(body.event_type || '').toUpperCase();

    // On agit uniquement à la capture d'argent
    if (eventType !== 'PAYMENT.CAPTURE.COMPLETED') {
      return ok({ ignored: true, event_type: eventType });
    }

    // --- 2) Extraire infos PayPal utiles
    const resource      = body.resource || {};
    const captureId     = resource.id || null;
    const paidTotal     = Number(resource?.amount?.value ?? NaN);
    const paidCurr      = (resource?.amount?.currency_code || 'USD').toUpperCase();
    const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id || null;

    // Notre orderId interne (custom_id)
    let orderId = String(resource?.purchase_units?.[0]?.custom_id || '').trim();
    if (!orderId && paypalOrderId) {
      const accessToken = await getPayPalAccessToken();
      const res = await getOrderCustomId(accessToken, paypalOrderId);
      orderId = res.customId || '';
    }
    if (!orderId) {
      return bad(400, "MISSING_ORDER_ID", {
        hint: "purchase_units[0].custom_id absent — vérifie que paypal-create-order pose custom_id=orderId"
      });
    }

    // --- 3) Charger commande depuis Supabase
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, "ORDER_NOT_FOUND");

    // Ne pas finaliser si un refund est en cours/terminé
    if (['refund_pending', 'refunded', 'refund_failed'].includes(order.status)) {
      return ok({ ignored: true, reason: 'refund_in_progress_or_done', orderId });
    }
    // Idempotence: si déjà complété
    if (order.status === "completed" && order.paypal_capture_id) {
      return ok({
        orderId,
        already: true,
        status: "completed",
        regionId: order.region_id,
        imageUrl: order.image_url,
        unitPrice: order.unit_price || null,
        total: order.total || null,
        currency: order.currency || paidCurr,
        paypalOrderId: order.paypal_order_id || paypalOrderId || null,
        paypalCaptureId: order.paypal_capture_id
      });
    }

    const uid      = String(order.uid || '').trim();
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.link_url || '').trim();
    const blocks   = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    const regionIn = String(order.region_id || '').trim();
    const imageUrl = order.image_url || null;

    if (!uid || !name || !linkUrl || !blocks.length) {
      return bad(400, "ORDER_INVALID");
    }
    const regionUuid = isUuid(regionIn) ? regionIn : (await import('node:crypto')).randomUUID();

    // --- 4) Contrôles pré-RPC: vendu ? locké par un autre ?
    // RPC-first + fallback count-only (anti-row-cap, anti-payload)
    let soldConflicts = 0;
    try {
      soldConflicts = await countSoldConflicts(supabase, blocks);
    } catch (e) {
      return bad(500, e.code === 'CELLS_QUERY_FAILED' ? 'CELLS_QUERY_FAILED' : 'CELLS_QUERY_FAILED', { message: e.message });
    }
    if (soldConflicts > 0) {
      // refund + release + journal DB
      let refundedOk = false;
      let refundObj  = null;
      try {
        const accessToken = await getPayPalAccessToken();
        refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}
      try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
      await supabase.from('orders').update({
        status: refundedOk ? 'refunded' : 'refund_failed',
        refund_status: refundedOk ? 'succeeded' : 'failed',
        needs_manual_refund: !refundedOk,
        refund_attempted_at: new Date().toISOString(),
        refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
        refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: 'ALREADY_SOLD',
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,
            currency: paidCurr,
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'ALREADY_SOLD',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      return bad(409, 'ALREADY_SOLD');
    }

    let locksByOthers = 0;
    try {
      locksByOthers = await countLocksByOthers(supabase, blocks, uid);
    } catch (e) {
      return bad(500, 'LOCKS_QUERY_FAILED', { message: e.message });
    }
    if (locksByOthers > 0) {
      // refund + release + journal DB
      let refundedOk = false;
      let refundObj  = null;
      try {
        const accessToken = await getPayPalAccessToken();
        refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}
      try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
      await supabase.from('orders').update({
        status: refundedOk ? 'refunded' : 'refund_failed',
        refund_status: refundedOk ? 'succeeded' : 'failed',
        needs_manual_refund: !refundedOk,
        refund_attempted_at: new Date().toISOString(),
        refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
        refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: 'LOCKED_BY_OTHER',
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,
            currency: paidCurr,
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'LOCKED_BY_OTHER',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      return bad(409, 'LOCKED_BY_OTHER');
    }

    // 🔍 STRICT LOCK VALIDATION (count-only, anti-cap 1000)
    {
      const nowIso = new Date().toISOString();
      const { count: validCount, error: lockErr2 } = await supabase
        .from('locks')
        .select('idx', { count: 'exact', head: true })
        .in('idx', blocks)
        .gt('until', nowIso)
        .eq('uid', uid);

      if (lockErr2) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr2.message });
      if ((validCount ?? 0) !== blocks.length) {
        const currencyForRefund = (order.currency || paidCurr || 'USD').toUpperCase();

        let refundedOk = false;
        let refundObj  = null;
        try {
          const accessToken = await getPayPalAccessToken();
          refundObj = captureId
            ? await refundPayPalCapture(accessToken, captureId, paidTotal, currencyForRefund)
            : null;
          refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
        } catch (_) {}

        try { await releaseLocks(supabase, blocks, uid); } catch (_) {}

        await supabase.from('orders').update({
          status: refundedOk ? 'refunded' : 'refund_failed',
          refund_status: refundedOk ? 'succeeded' : 'failed',
          needs_manual_refund: !refundedOk,
          refund_attempted_at: new Date().toISOString(),
          refund_error: refundedOk ? null : 'REFUND_FAILED',
          refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
          paypal_order_id: paypalOrderId || order.paypal_order_id || null,
          paypal_capture_id: captureId || order.paypal_capture_id || null,
          fail_reason: 'LOCKS_INVALID',
          currency: currencyForRefund,
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);

        if (!refundedOk) {
          try {
            await logManualRefundNeeded({
              route: 'webhook',
              orderId,
              uid,
              regionId: regionUuid,
              blocks,
              amount: paidTotal,
              currency: currencyForRefund,
              paypalOrderId: paypalOrderId || order.paypal_order_id || null,
              paypalCaptureId: captureId || order.paypal_capture_id || null,
              reason: 'LOCKS_INVALID',
              error: 'REFUND_FAILED'
            });
          } catch(_) {}
        }

        return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      }
    }

    const total = Number(order.total);
const usedCurrency = (order.currency || paidCurr || 'USD').toUpperCase();
if (!Number.isFinite(total)) return bad(409, 'ORDER_PRICE_MISSING');


    // (nouveau) devise incohérente → refund
    if (paidCurr && usedCurrency && paidCurr !== usedCurrency) {
      let refundedOk = false;
      let refundObj  = null;
      try {
        const accessToken = await getPayPalAccessToken();
        refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}
      try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
      await supabase.from('orders').update({
        status: refundedOk ? 'refunded' : 'refund_failed',
        refund_status: refundedOk ? 'succeeded' : 'failed',
        needs_manual_refund: !refundedOk,
        refund_attempted_at: new Date().toISOString(),
        refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
        refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
        server_total: total,
        amount: paidTotal,
        currency: usedCurrency,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: 'CURRENCY_MISMATCH',
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,
            currency: usedCurrency,
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'CURRENCY_MISMATCH',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      return bad(409, 'CURRENCY_MISMATCH', { expected: usedCurrency, got: paidCurr });
    }

    // Vérif sous-paiement si on a un montant capturé
    if (Number.isFinite(paidTotal) && paidTotal + 1e-9 < total) {
      let refundedOk = false;
      let refundObj  = null;
      try {
        const accessToken = await getPayPalAccessToken();
        refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}
      try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
      await supabase.from('orders').update({
        status: refundedOk ? 'refunded' : 'refund_failed',
        refund_status: refundedOk ? 'succeeded' : 'failed',
        needs_manual_refund: !refundedOk,
        refund_attempted_at: new Date().toISOString(),
        refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
        refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
        server_total: total,
        amount: paidTotal,
        currency: usedCurrency,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: 'UNDERPAID',
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,
            currency: usedCurrency,
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'UNDERPAID',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      return bad(409, 'UNDERPAID', { serverTotal: total, paidTotal, currency: usedCurrency });
    }

    // --- 6) RPC (montant = payé si dispo, sinon total serveur)
    const amountForDb = Number.isFinite(paidTotal) ? paidTotal : total;
    const orderUuid = (await import('node:crypto')).randomUUID();
    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocks,
      _region_id: regionUuid,
      _image_url: imageUrl || null,
      _amount:    amountForDb
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();

      if (msg.includes('PRICE_CHANGED')) {
        const { count: c2 } = await supabase
          .from('cells').select('idx', { count:'exact', head:true })
          .not('sold_at', 'is', null);
        const bs2   = c2 || 0;
        const tier2 = Math.floor(bs2 / 10);
        const up2   = Math.round((1 + tier2 * 0.01) * 100) / 100;
        const tot2  = Math.round(up2 * totalPixels * 100) / 100;

        let refundedOk = false;
        let refundObj  = null;
        try {
          const accessToken = await getPayPalAccessToken();
          refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
          refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
        } catch(_) {}
        try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
        await supabase.from('orders').update({
          status: refundedOk ? 'refunded' : 'refund_failed',
          refund_status: refundedOk ? 'succeeded' : 'failed',
          needs_manual_refund: !refundedOk,
          refund_attempted_at: new Date().toISOString(),
          refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
          refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
          server_unit_price: up2,
          server_total: tot2,
          currency: usedCurrency,
          paypal_order_id: paypalOrderId || order.paypal_order_id || null,
          paypal_capture_id: captureId || order.paypal_capture_id || null,
          fail_reason: 'PRICE_CHANGED',
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);
        if (!refundedOk) {
          try {
            await logManualRefundNeeded({
              route: 'webhook',
              orderId,
              uid,
              regionId: regionUuid,
              blocks,
              amount: paidTotal,
              currency: usedCurrency,
              paypalOrderId: paypalOrderId || order.paypal_order_id || null,
              paypalCaptureId: captureId || order.paypal_capture_id || null,
              reason: 'PRICE_CHANGED',
              error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
            });
          } catch (_) {}
        }
        return bad(409, 'PRICE_CHANGED', { serverUnitPrice: up2, serverTotal: tot2, currency: usedCurrency });
      }

      // Autres erreurs RPC : refund + release + journal DB
      let refundedOk = false;
      let refundObj  = null;
      try {
        const accessToken = await getPayPalAccessToken();
        refundObj  = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}
      try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
      await supabase.from('orders').update({
        status: refundedOk ? 'refunded' : 'refund_failed',
        refund_status: refundedOk ? 'succeeded' : 'failed',
        needs_manual_refund: !refundedOk,
        refund_attempted_at: new Date().toISOString(),
        refund_error: refundedOk ? null : String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
        refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: (msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
                  : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
                  : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR')),
        updated_at: new Date().toISOString()
      }).eq('order_id', orderId);

      if (msg.includes('LOCKS_INVALID'))                            return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))                                return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // --- 7) Succès — marquer completed
    await supabase.from('orders').update({
      status: 'completed',
      region_id: regionUuid,
      unit_price: unitPrice,
      total,
      currency: usedCurrency,
      paypal_order_id: paypalOrderId || order.paypal_order_id || null,
      paypal_capture_id: captureId || order.paypal_capture_id || null,
      updated_at: new Date().toISOString()
    }).eq('order_id', orderId);

    // Libération des locks (best-effort)
    try { await releaseLocks(supabase, blocks, uid); } catch(_) {}

    return ok({
      orderId,
      status:'completed',
      regionId: regionUuid,
      imageUrl: imageUrl || null,
      unitPrice,
      total,
      currency: usedCurrency,
      paypalOrderId: paypalOrderId || null,
      paypalCaptureId: captureId || null
    });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
