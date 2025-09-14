// netlify/functions/paypal-webhook.js
// Webhook PayPal -> finalisation server-side (prix serveur, tout ou rien, via Supabase RPC)
// Étapes : vérif signature PayPal -> retrouver notre orderId (custom_id) -> contrôles -> prix serveur -> RPC -> marquer completed.
// 100% Supabase (plus de GitHub JSON).

const PAYPAL_BASE_URL  = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ; // (client_secret côté serveur)

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { verifyPayPalWebhook } = require('./_paypal-verify');
const { logManualRefundNeeded } = require('./_manual-refund-logger');

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-webhook.v4' });
const ok  = (b)            => json(200,{ ok:true,  signature:'paypal-webhook.v4', ...b });

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
  if (!r.ok) throw new Error(`PAYPAL_TOKEN_FAILED:${r.status}`);
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
  try {
    const body = (Number.isFinite(amount) && currency)
      ? { amount: { value: Number(amount).toFixed(2), currency_code: String(currency).toUpperCase() } }
      : {}; // refund total si pas d'amount fourni
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

// Libération des locks
async function releaseLocks(supabase, blocks, uid) {
  try {
    if (!Array.isArray(blocks) || !blocks.length || !uid) return;
    await supabase.from('locks').delete().in('idx', blocks).eq('uid', uid);
  } catch (_) { /* best-effort */ }
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
    const resource   = body.resource || {};
    const captureId  = resource.id || null;
    const paidTotal  = Number(resource?.amount?.value ?? NaN);
    const paidCurr   = (resource?.amount?.currency_code || 'USD').toUpperCase();
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

    // --- 4) Contrôles Supabase (déjà vendu / locks)
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells').select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);
    if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
    if (soldRows && soldRows.length) {
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
      }).eq('id', order.id);
      //new journal
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,              // à ce stade on a paidTotal / paidCurr
            currency: paidCurr,
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'ALREADY_SOLD',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      //new journal
      return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });
    }

    const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks').select('idx, uid, until')
      .in('idx', blocks)
      .gt('until', nowIso)
      .neq('uid', uid);
    if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
    if (lockRows && lockRows.length) {
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
      }).eq('id', order.id);
      //new journal
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
      //new journal
      return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });
    }

    // (Ré)appliquer locks 2 min pour uid
    /*const until = new Date(Date.now() + 2*60*1000).toISOString();
    const upsertRows = blocks.map(idx => ({ idx, uid, until }));
    const { error: upsertErr } = await supabase.from('locks').upsert(upsertRows, { onConflict: 'idx' });
    if (upsertErr) return bad(500, 'LOCKS_UPSERT_FAILED', { message: upsertErr.message });
    */
    //new
    // 🔍 STRICT LOCK VALIDATION (pas de ré-upsert)
{
  const nowIso = new Date().toISOString();
  const { data: myLocks, error: lockErr2 } = await supabase
    .from('locks')
    .select('idx')
    .in('idx', blocks)
    .gt('until', nowIso)
    .eq('uid', uid);

  if (lockErr2) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr2.message });
  if (!myLocks || myLocks.length !== blocks.length) {
    // Locks invalides → tenter refund (webhook a déjà la capture)
    const currencyForRefund = (order.currency || paidCurr || 'USD').toUpperCase();

    let refundedOk = false;
    let refundObj  = null;
    try {
      const accessToken = await getPayPalAccessToken();   // 👈 déplacé DANS le try
      refundObj = captureId
        ? await refundPayPalCapture(accessToken, captureId, paidTotal, currencyForRefund)
        : null;
      refundedOk = !!(refundObj && (refundObj.id || refundObj.status));
    } catch (_) {
      // token/refund raté → on laissera refundedOk=false
    }

    try { await releaseLocks(supabase, blocks, uid); } catch (_) {}

    // Journal DB : on écrit quoi qu'il arrive, même si PayPal a échoué
    const { error: updErr } = await supabase.from('orders').update({
      status: refundedOk ? 'refunded' : 'refund_failed',
      refund_status: refundedOk ? 'succeeded' : 'failed',
      needs_manual_refund: !refundedOk,
      refund_attempted_at: new Date().toISOString(),
      refund_error: refundedOk ? null : 'REFUND_FAILED',
      refund_id: refundedOk ? (refundObj?.id || refundObj?.refund_id || null) : null,
      paypal_order_id: paypalOrderId || order.paypal_order_id || null,
      paypal_capture_id: captureId || order.paypal_capture_id || null,
      fail_reason: 'LOCKS_INVALID',
      currency: currencyForRefund,                           // 👈 sécurise la devise
      updated_at: new Date().toISOString()
    })
    .eq('order_id', orderId);                                // 👈 cohérence du filtre

    if (updErr) console.error('[orders.update refund/LOCKS_INVALID]', updErr, { orderId });

    if (!refundedOk) {
      // Journal GitHub en cas de refund raté (évite usedCurrency non défini ici)
      try {
        await logManualRefundNeeded({
          route: 'webhook',
          orderId,
          uid,
          regionId: regionUuid,
          blocks,
          amount: paidTotal,
          currency: currencyForRefund,                       // 👈 pas de usedCurrency ici
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

    //new
    // --- 5) Prix serveur
    const { count, error: countErr } = await supabase
      .from('cells')
      .select('idx', { count:'exact', head:true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;
    const totalPixels = blocks.length * 100;
    const total       = Math.round(unitPrice * totalPixels * 100) / 100;
    const usedCurrency= (order.currency || paidCurr || 'USD').toUpperCase();

    // Vérif sous-paiement si on a un montant capturé
    if (Number.isFinite(paidTotal) && paidTotal + 1e-9 < total) {
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
        server_total: total,
        amount: paidTotal,
        currency: usedCurrency,
        paypal_order_id: paypalOrderId || order.paypal_order_id || null,
        paypal_capture_id: captureId || order.paypal_capture_id || null,
        fail_reason: 'UNDERPAID',
        updated_at: new Date().toISOString()
      }).eq('id', order.id);
      //new journal
      if (!refundedOk) {
        try {
          await logManualRefundNeeded({
            route: 'webhook',
            orderId,
            uid,
            regionId: regionUuid,
            blocks,
            amount: paidTotal,
            currency: usedCurrency,         // ici usedCurrency est défini
            paypalOrderId: paypalOrderId || order.paypal_order_id || null,
            paypalCaptureId: captureId || order.paypal_capture_id || null,
            reason: 'UNDERPAID',
            error: String(refundObj?.message || refundObj?.name || 'REFUND_FAILED')
          });
        } catch (_) {}
      }
      //new journal
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
      _image_url: imageUrl || null,   // optionnel
      _amount:    amountForDb
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();

      if (msg.includes('PRICE_CHANGED')) {
        // Recalcule pour retourner au caller
        const { count: c2 } = await supabase
          .from('cells').select('idx', { count:'exact', head:true })
          .not('sold_at', 'is', null);
        const bs2   = c2 || 0;
        const tier2 = Math.floor(bs2 / 10);
        const up2   = Math.round((1 + tier2 * 0.01) * 100) / 100;
        const tot2  = Math.round(up2 * totalPixels * 100) / 100;

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
          server_unit_price: up2,
          server_total: tot2,
          currency: usedCurrency,
          paypal_order_id: paypalOrderId || order.paypal_order_id || null,
          paypal_capture_id: captureId || order.paypal_capture_id || null,
          fail_reason: 'PRICE_CHANGED',
          updated_at: new Date().toISOString()
        }).eq('id', order.id);
        //new journal
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
        //new journal
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
      }).eq('id', order.id);

      if (msg.includes('LOCKS_INVALID')) return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS')) return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // --- 7) Succès — marquer completed + journaliser
    await supabase.from('orders').update({
      status: 'completed',
      region_id: regionUuid,
      unit_price: unitPrice,
      total,
      currency: usedCurrency,
      paypal_order_id: paypalOrderId || order.paypal_order_id || null,
      paypal_capture_id: captureId || order.paypal_capture_id || null,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);

    // Libération des locks en cas de succès (best-effort)
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
