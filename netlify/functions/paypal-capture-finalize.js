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
// Sandbox par défaut; mets https://api-m.paypal.com en prod via la variable d'env
const PAYPAL_BASE_URL      = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
//test refund fail
const FORCE_REFUND_FAIL = process.env.FORCE_REFUND_FAIL === '1';


function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-capture-finalize.v2' });
const ok  = (b)           => json(200,{ ok:true,  signature:'paypal-capture-finalize.v2', ...b });

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

// === helper refund PayPal ===
async function refundPayPalCapture(accessToken, captureId, amount, currency) {
  //test refund fail
  if (FORCE_REFUND_FAIL) {
    throw new Error('TEST_FORCED_REFUND_FAIL');
  }
  //test refund fail
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

// === helper libération des locks ===
async function releaseLocks(supabase, blocks, uid) {
  try {
    if (!Array.isArray(blocks) || !blocks.length || !uid) return;
    await supabase.from('locks').delete().in('idx', blocks).eq('uid', uid);
  } catch (_) { /* best-effort */ }
}

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING');

    // ✅ requireAuth renvoie un objet (ou une réponse 401)
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

    // 1) Charger l’ordre depuis la table orders et vérifier ownership
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, 'ORDER_NOT_FOUND');
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

    // Idempotence: si déjà complété → OK direct
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

    // Vérifier cohérence paypalOrderId
    if (order.paypal_order_id && order.paypal_order_id !== paypalOrderId) {
      return bad(409, 'PAYPAL_ORDER_MISMATCH', { expected: order.paypal_order_id, got: paypalOrderId });
    }

    // 2) Recalcule prix côté serveur
    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');
    const currency = String(order.currency || 'USD').toUpperCase();

    // Nombre déjà vendus → palier
    const { count, error: countErr } = await supabase
      .from('cells').select('idx', { count:'exact', head:true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;
    const totalPixels = blocks.length * 100;
    const serverTotal = Math.round(unitPrice * totalPixels * 100) / 100;

    // Si l'ordre stocké possède un total différent → on refuse la CAPTURE
    if (order.total != null && Number(order.total) !== Number(serverTotal)) {
      // journalise en DB (price_changed)
      await supabase.from('orders').update({
        server_unit_price: unitPrice,
        server_total: serverTotal,
        updated_at: new Date().toISOString(),
        fail_reason: 'PRICE_CHANGED'
      }).eq('id', order.id);
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal, currency });
    }

    // 3) CAPTURE PayPal (serveur → serveur)
    const accessToken = await getPayPalAccessToken();

    // GET order pour contrôler l’amount prévu côté PayPal
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

    // Vérifs avant capture
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
      }).eq('id', order.id);
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal, currency });
    }
    if (ppOrder.status === 'COMPLETED') {
      // Déjà capturé -> on saute la capture et on va finaliser
    } else if (ppOrder.status !== 'APPROVED') {
      return bad(409, 'ORDER_NOT_APPROVED', { paypalStatus: ppOrder.status });
    }

    // CAPTURE (si pas déjà completed)
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
      const capJson = await captureRes.json().catch(()=>({}));
      if (!captureRes.ok) {
        return bad(502, 'PAYPAL_CAPTURE_FAILED', { details: capJson });
      }
      capture = capJson;
      if (capture.status !== 'COMPLETED') {
        return bad(502, 'PAYPAL_CAPTURE_NOT_COMPLETED', { paypalStatus: capture.status });
      }
    } else {
      // Si déjà completed, re-GET pour récupérer la représentation avec captures
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

    // 4) Finalisation atomique via RPC
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.link_url || '').trim();
    const blocksOk = blocks;
    if (!name || !linkUrl || !blocksOk.length) return bad(400, 'MISSING_FIELDS');

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

      // === REFUND + libération des locks si la finalisation échoue après capture ===
      let refundedOk = false;
      let refundObj  = null;
      try {
        refundObj  = await refundPayPalCapture(accessToken, captureId, capValue, currency);
        refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
      } catch(_) {}

      try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

      // journal clair en DB
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
          paypal_order_id: paypalOrderId,
          paypal_capture_id: captureId,
          server_unit_price: unitPrice,
          server_total: serverTotal,
          currency,
          updated_at: new Date().toISOString(),
          fail_reason: (msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
                   : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
                   : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR'))
        }).eq('id', order.id);
      } else {
        await supabase.from('orders').update({
          status: 'refund_failed',
          refund_status: 'failed',
          needs_manual_refund: true,
          refund_attempted_at: new Date().toISOString(),
          refund_error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED'),
          paypal_order_id: paypalOrderId,
          paypal_capture_id: captureId,
          server_unit_price: unitPrice,
          server_total: serverTotal,
          currency,
          updated_at: new Date().toISOString(),
          fail_reason: (msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
                   : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
                   : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR'))
        }).eq('id', order.id);

        // 👇👇👇 **AJOUTE CE BLOC ICI** (juste après l'update "refund_failed")
        try {
          const failReasonForLog =
            (msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
            : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
            : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR'));

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
            reason: failReasonForLog,
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
        // ☝️☝️☝️ fin du bloc à ajouter
      }

      if (refundedOk) {
        return bad(500, 'FINALIZE_FAILED_REFUNDED', { message: msg || 'RPC_FINALIZE_FAILED' });
      }
      if (msg.includes('LOCKS_INVALID'))                          return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))                              return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 5) Marquer l'ordre DB comme completed (best-effort)
    await supabase.from('orders').update({
      status: 'completed',
      paypal_order_id: paypalOrderId,
      paypal_capture_id: captureId,
      unit_price: unitPrice,
      total: serverTotal,
      currency,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);

    // libération des locks en cas de succès (best-effort)
    try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

    return ok({
      status:'completed',
      orderId,
      regionId: regionId,
      imageUrl: imageUrl || null,
      paypalOrderId,
      paypalCaptureId: captureId
    });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
