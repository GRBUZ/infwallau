// netlify/functions/paypal-capture-finalize.js
// Capture PayPal côté serveur + finalisation atomique via Supabase RPC finalize_paid_order
// Entrée: POST { orderId, paypalOrderId }
// Sortie: { ok:true, status:'completed', regionId, imageUrl?, paypalOrderId, paypalCaptureId }

const { requireAuth } = require('./auth-middleware');
const { logManualRefundNeeded } = require('./_manual-refund-logger');

// --- Supabase
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- PayPal
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL      = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-capture-finalize.v3' });
const ok  = (b)           => json(200,{ ok:true,  signature:'paypal-capture-finalize.v3', ...b });

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CONFIG_MISSING');
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) {
    const err = await r.json().catch(()=>({}));
    throw new Error(`PAYPAL_TOKEN_FAILED:${r.status}:${err.error || ''}`);
  }
  const j = await r.json();
  return j.access_token;
}

// --- helpers ---
async function refundPayPalCapture(accessToken, captureId, amount, currency) {
  try {
    const resp = await fetch(`${PAYPAL_BASE_URL}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ amount: { value: Number(amount).toFixed(2), currency_code: String(currency || 'USD').toUpperCase() } })
    });
    const j = await resp.json().catch(()=> ({}));
    if (!resp.ok) throw new Error(`PAYPAL_REFUND_FAILED:${resp.status}:${j?.name || ''}`);
    return j; // { id, status, ... }
  } catch (e) {
    console.error('[PayPal] refund failed:', e);
    return null; // best-effort
  }
}

async function releaseLocks(supabase, blocks, uid) {
  try {
    if (!Array.isArray(blocks) || !blocks.length || !uid) return;
    const CHUNK = 1000;
    for (let i = 0; i < blocks.length; i += CHUNK) {
      const slice = blocks.slice(i, i + CHUNK);
      await supabase.from('locks').delete().in('idx', slice).eq('uid', uid);
    }
  } catch (_) { /* best-effort */ }
}

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function tryRpc(supabase, fn, params) {
  try {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING');

    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    event.auth = auth;
    const { uid } = auth;
    if (!uid) return bad(401, 'UNAUTHORIZED');

    let body={}; try{ body = JSON.parse(event.body||'{}'); }catch{ return bad(400,'BAD_JSON'); }
    const orderId       = String(body.orderId || '').trim();
    const paypalOrderId = String(body.paypalOrderId || '').trim();
    if (!orderId)       return bad(400, 'MISSING_ORDER_ID');
    if (!paypalOrderId) return bad(400, 'MISSING_PAYPAL_ORDER_ID');

    // ==== Supabase client ====
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Charger l’ordre et vérifier ownership
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, 'ORDER_NOT_FOUND');
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

    // Idempotence
    if (order.status === 'completed' && order.paypal_capture_id) {
      return ok({
        status: 'completed',
        orderId,
        regionId: order.region_id,
        imageUrl: order.image_url || null,
        paypalOrderId: order.paypal_order_id || paypalOrderId,
        paypalCaptureId: order.paypal_capture_id
      });
    }

    if (order.paypal_order_id && order.paypal_order_id !== paypalOrderId) {
      return bad(409, 'PAYPAL_ORDER_MISMATCH', { expected: order.paypal_order_id, got: paypalOrderId });
    }

    // 2) Prix serveur
    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');
    //const currency = String(order.currency || 'USD').toUpperCase();
/*
    const { count, error: countErr } = await supabase
      .from('cells').select('idx', { count:'exact', head:true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;
    const totalPixels = blocks.length * 100;
    const serverTotal = Math.round(unitPrice * totalPixels * 100) / 100;

    if (order.total != null && Number(order.total) !== Number(serverTotal)) {
      await supabase.from('orders').update({
        server_unit_price: unitPrice,
        server_total: serverTotal,
        updated_at: new Date().toISOString(),
        fail_reason: 'PRICE_CHANGED'
      }).eq('order_id', orderId);
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal, currency });
    }*/
   const serverTotal = Number(order.total);
const currency    = String(order.currency || 'USD').toUpperCase();
if (!Number.isFinite(serverTotal)) return bad(409, 'ORDER_PRICE_MISSING');


    // 3) CAPTURE PayPal
    const accessToken = await getPayPalAccessToken();

    // GET order
    const getOrderRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type':'application/json' }
    });
    if (!getOrderRes.ok) {
      const err = await getOrderRes.json().catch(()=>({}));
      return bad(502, 'PAYPAL_GET_ORDER_FAILED', { details: err });
    }
    const ppOrder = await getOrderRes.json();
    const pu = (ppOrder.purchase_units && ppOrder.purchase_units[0]) || {};
    const ppAmount = pu.amount || {};
    const ppCurrency = (ppAmount.currency_code || '').toUpperCase();
    const ppValue = Number(ppAmount.value || 0);

    if (pu.custom_id && pu.custom_id !== orderId) {
      return bad(409, 'CUSTOM_ID_MISMATCH', { expected: orderId, got: pu.custom_id });
    }
    if (ppCurrency !== currency) {
      return bad(409, 'CURRENCY_MISMATCH', { expected: currency, got: ppCurrency });
    }
    if (Number(ppValue) !== Number(serverTotal)) {
      await supabase.from('orders').update({
        server_unit_price: unitPrice,
        server_total: serverTotal,
        updated_at: new Date().toISOString(),
        fail_reason: 'PRICE_CHANGED'
      }).eq('order_id', orderId);
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal, currency });
    }
    if (ppOrder.status !== 'COMPLETED' && ppOrder.status !== 'APPROVED') {
      return bad(409, 'ORDER_NOT_APPROVED', { paypalStatus: ppOrder.status });
    }

    // CAPTURE si nécessaire
    let capture;
    if (ppOrder.status !== 'COMPLETED') {
      const captureRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({})
      });

      const capJson = await captureRes.json().catch(()=> ({}));

      if (!captureRes.ok) {
        const name   = (capJson && capJson.name) || '';
        const issues = Array.isArray(capJson?.details) ? capJson.details.map(d => d.issue) : [];
        const isInstrDeclined = name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED');

        if (isInstrDeclined) {
          return bad(409, 'INSTRUMENT_DECLINED', {
            retriable: true,
            details: capJson
          });
        }
        return bad(502, 'PAYPAL_CAPTURE_FAILED', { details: capJson });
      }

      capture = capJson;

      if (capture.status !== 'COMPLETED') {
        return bad(502, 'PAYPAL_CAPTURE_NOT_COMPLETED', { paypalStatus: capture.status, details: capture });
      }
    } else {
      capture = ppOrder;
    }

    // Extraire captureId + montants
    const pu0 = (capture.purchase_units && capture.purchase_units[0]) || {};
    const payments = pu0.payments || {};
    const captures = payments.captures || [];
    const firstCap = captures[0] || {};
    const captureId = firstCap.id || null;
    const capAmount = firstCap.amount || {};
    const capCurrency = (capAmount.currency_code || '').toUpperCase();
    const capValue = Number(capAmount.value || 0);

    if (!captureId) return bad(502, 'MISSING_CAPTURE_ID');
    if (capCurrency !== currency) return bad(409, 'CURRENCY_MISMATCH', { expected: currency, got: capCurrency });
    if (Number(capValue) !== Number(serverTotal)) {
      return bad(409, 'CAPTURE_AMOUNT_MISMATCH', { expected: serverTotal, got: capValue });
    }

    // ========= 3.5) VALIDATION STRICTE DES LOCKS (anti-414 / anti-1000) =========
    // - 3.5.a : via RPC, vérifier qu'aucun lock d'un autre uid n'existe
    // - 3.5.b : compter (par tranches) nos propres locks encore valides et comparer au total
    const blocksOk = blocks;
    const nowIso = new Date().toISOString();

    // petite util pour centraliser le refund flow existant
    const doRefundFor = async (reason) => {
      const { data: claimRows, error: claimErr } = await supabase
        .from('orders')
        .update({
          status: 'refund_pending',
          fail_reason: reason,
          paypal_order_id: paypalOrderId,
          paypal_capture_id: captureId,
          server_unit_price: unitPrice,
          server_total: serverTotal,
          currency,
          updated_at: new Date().toISOString()
        })
        .eq('order_id', orderId)
        .not('status', 'in', ['completed','refunded','refund_failed','refund_pending'])
        .select('id');

      const weOwnRefund = !claimErr && Array.isArray(claimRows) && claimRows.length > 0;
      if (!weOwnRefund) {
        const { data: fresh } = await supabase
          .from('orders')
          .select('status, region_id, image_url, unit_price, total, currency, paypal_capture_id, paypal_order_id')
          .eq('order_id', orderId)
          .single();

        if (fresh?.status === 'completed') {
          return ok({
            status: 'completed',
            orderId,
            regionId: order.region_id,
            imageUrl: order.image_url || fresh.image_url || null,
            paypalOrderId: fresh.paypal_order_id || paypalOrderId,
            paypalCaptureId: fresh.paypal_capture_id || captureId,
            unitPrice,
            total: serverTotal,
            currency
          });
        }
        if (fresh?.status === 'refunded') {
          return bad(500, 'FINALIZE_FAILED_REFUNDED', { message: reason });
        }
        return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      }

      let refundedOk = false;
      let refundObj  = null;
      try {
        refundObj  = await refundPayPalCapture(accessToken, captureId, capValue, currency);
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch (_) {}

      try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

      if (refundedOk) {
        const refundId = refundObj?.id
          || refundObj?.refund_id
          || refundObj?.purchase_units?.[0]?.payments?.refunds?.[0]?.id
          || null;

        await supabase.from('orders').update({
          status: 'refunded',
          refund_status: 'succeeded',
          needs_manual_refund: false,
          refund_attempted_at: new Date().toISOString(),
          refund_id: refundId,
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);

        return bad(500, 'FINALIZE_FAILED_REFUNDED', { message: reason });
      } else {
        await supabase.from('orders').update({
          status: 'refund_failed',
          refund_status: 'failed',
          needs_manual_refund: true,
          refund_attempted_at: new Date().toISOString(),
          refund_error: 'REFUND_FAILED',
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);

        try {
          await logManualRefundNeeded({
            route: 'capture-finalize',
            orderId,
            uid,
            regionId: order.region_id,
            blocks: blocksOk,
            amount: capValue,
            currency,
            paypalOrderId,
            paypalCaptureId: captureId,
            reason,
            error: 'REFUND_FAILED'
          });
        } catch (_) {}

        return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      }
    };

    // 3.5.a — conflits (locks d’un autre uid) via RPC si dispo
    {
      const viaRpc = await tryRpc(supabase, 'locks_conflicts_in', { p_blocks: blocksOk, p_uid: uid, p_now: nowIso });
      if (!viaRpc.error && Array.isArray(viaRpc.data) && viaRpc.data.length > 0) {
        // quelqu’un d’autre détient un lock en cours → on traite comme lock invalide
        const r = await doRefundFor('LOCKS_INVALID');
        return r;
      }
    }

    // 3.5.b — compter nos locks valides par tranches (pas de .in() géant)
    {
      const CHUNK = 1000;
      let myValid = 0;

      for (let i = 0; i < blocksOk.length; i += CHUNK) {
        const slice = blocksOk.slice(i, i + CHUNK);
        const { count: c, error: e } = await supabase
          .from('locks')
          .select('idx', { count: 'exact', head: true })
          .in('idx', slice)
          .gt('until', nowIso)
          .eq('uid', uid);

        if (e) return bad(500, 'LOCKS_QUERY_FAILED', { message: e.message });
        myValid += (c || 0);
      }

      if (myValid !== blocksOk.length) {
        const r = await doRefundFor('LOCKS_INVALID');
        return r;
      }
    }

    // 4) Finalisation atomique via RPC
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.link_url || '').trim();
    if (!name || !linkUrl) return bad(400, 'MISSING_FIELDS');

    let regionId = String(order.region_id || '').trim();
    if (!isUuid(regionId)) regionId = (await import('node:crypto')).randomUUID();

    const imageUrl = order.image_url || null;
    const amount   = Number(capValue);
    const orderUuid = (await import('node:crypto')).randomUUID();

    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocksOk,
      _region_id: regionId,
      _image_url: imageUrl || null,
      _amount:    amount
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();

      const reason =
        msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
      : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
      : (msg.includes('NO_BLOCKS')) ? 'NO_BLOCKS'
      : 'FINALIZE_ERROR';

      const { data: claimRows, error: claimErr } = await supabase
        .from('orders')
        .update({
          status: 'refund_pending',
          fail_reason: reason,
          paypal_order_id: paypalOrderId,
          paypal_capture_id: captureId,
          server_unit_price: unitPrice,
          server_total: serverTotal,
          currency,
          updated_at: new Date().toISOString()
        })
        .eq('order_id', orderId)
        .not('status', 'in', ['completed','refunded','refund_failed','refund_pending'])
        .select('id');

      const weOwnRefund = !claimErr && Array.isArray(claimRows) && claimRows.length > 0;

      if (!weOwnRefund) {
        const { data: fresh } = await supabase
          .from('orders')
          .select('status, region_id, image_url, unit_price, total, currency, paypal_capture_id, paypal_order_id')
          .eq('order_id', orderId)
          .single();

        if (fresh?.status === 'completed') {
          return ok({
            status: 'completed',
            orderId,
            regionId,
            imageUrl: imageUrl || fresh.image_url || null,
            paypalOrderId: fresh.paypal_order_id || paypalOrderId,
            paypalCaptureId: fresh.paypal_capture_id || captureId,
            unitPrice,
            total: serverTotal,
            currency
          });
        }
        if (fresh?.status === 'refunded') {
          return bad(500, 'FINALIZE_FAILED_REFUNDED', { message: 'LOCKS_INVALID' });
        }
        return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      }

      let refundedOk = false;
      let refundObj  = null;
      try {
        refundObj  = await refundPayPalCapture(accessToken, captureId, capValue, currency);
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch (_) {}

      try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

      if (refundedOk) {
        const refundId = refundObj?.id
          || refundObj?.refund_id
          || refundObj?.purchase_units?.[0]?.payments?.refunds?.[0]?.id
          || null;

        await supabase.from('orders').update({
          status: 'refunded',
          refund_status: 'succeeded',
          needs_manual_refund: false,
          refund_attempted_at: new Date().toISOString(),
          refund_id: refundId,
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);
      } else {
        await supabase.from('orders').update({
          status: 'refund_failed',
          refund_status: 'failed',
          needs_manual_refund: true,
          refund_attempted_at: new Date().toISOString(),
          refund_error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);

        try {
          await logManualRefundNeeded({
            route: 'capture-finalize',
            orderId,
            uid,
            regionId,
            blocks: blocksOk,
            amount: capValue,
            currency,
            paypalOrderId,
            paypalCaptureId: captureId,
            reason,
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }

      if (refundedOk) {
        return bad(500, 'FINALIZE_FAILED_REFUNDED', { message: msg || 'RPC_FINALIZE_FAILED' });
      }
      if (msg.includes('LOCKS_INVALID'))                            return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))                                return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 5) Succès: marquer completed
    await supabase.from('orders').update({
      status: 'completed',
      paypal_order_id: paypalOrderId,
      paypal_capture_id: captureId,
      unit_price: unitPrice,
      total: serverTotal,
      currency,
      updated_at: new Date().toISOString()
    }).eq('order_id', orderId);

    // libération des locks (best-effort)
    try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

    return ok({
      status:'completed',
      orderId,
      regionId: order.region_id,
      imageUrl: order.image_url || null,
      paypalOrderId,
      paypalCaptureId: captureId
    });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
