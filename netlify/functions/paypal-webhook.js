// netlify/functions/paypal-webhook.js
// Webhook PayPal -> finalisation server-side (prix serveur, tout ou rien, via Supabase RPC)
// Étapes : vérif signature PayPal -> retrouver notre orderId (custom_id) -> contrôles -> prix serveur -> RPC -> marquer completed.
//
// Variables requises :
//   GH_REPO, GH_TOKEN, [GH_BRANCH], [ORDERS_DIR]
//
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET, [PAYPAL_BASE_URL] (défaut sandbox)
//   PAYPAL_WEBHOOK_SECRET (plus utilisé ici), verifyPayPalWebhook (cryptographique officiel)

const PAYPAL_BASE_URL   = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID  = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET     = process.env.PAYPAL_SECRET;
// const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET; // (non utilisé, on passe par verifyPayPalWebhook)

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { verifyPayPalWebhook } = require('./_paypal-verify');

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-webhook.v3' });
const ok  = (b)         => json(200,{ ok:true,  signature:'paypal-webhook.v3', ...b });

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

function isUuid(v){
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) throw new Error('PAYPAL_CONFIG_MISSING');
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
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

// === PATCH AJOUTÉ: helper refund PayPal (amount/currency optionnels -> full refund si omis) ===
async function refundPayPalCapture(accessToken, captureId, amount, currency) {
  try {
    const body = (Number.isFinite(amount) && currency)
      ? { amount: { value: Number(amount).toFixed(2), currency_code: String(currency).toUpperCase() } }
      : {}; // refund total si pas d'amount fourni
    const resp = await fetch(`${PAYPAL_BASE_URL}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
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

// === PATCH AJOUTÉ: helper libération des locks ===
async function releaseLocks(supabase, blocks, uid) {
  try {
    if (!Array.isArray(blocks) || !blocks.length || !uid) return;
    await supabase.from('locks').delete().in('idx', blocks).eq('uid', uid);
  } catch (_) { /* best-effort */ }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");
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
    // Essayer d'obtenir le PayPal Order Id (lié à la capture)
    const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id || null;

    // Notre orderId interne est censé être dans purchase_units[].custom_id.
    // Suivant les events, il peut ne pas figurer dans le payload -> fallback GET order.
    let orderId = String(resource?.purchase_units?.[0]?.custom_id || '').trim();
    let orderJson = null;

    if (!orderId && paypalOrderId) {
      const accessToken = await getPayPalAccessToken();
      const res = await getOrderCustomId(accessToken, paypalOrderId);
      orderId = res.customId || '';
      orderJson = res.orderJson || null;
    }

    if (!orderId) {
      return bad(400, "MISSING_ORDER_ID", {
        hint: "purchase_units[0].custom_id absent — vérifie que paypal-create-order pose custom_id=orderId"
      });
    }

    // --- 3) Charger commande GH
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const { json: order, sha: orderSha } = await ghGetJson(orderPath);
    if (!order) return bad(404, "ORDER_NOT_FOUND");

    // Idempotence
    if (order.status === "completed" && order.paypalCaptureId) {
      return ok({
        orderId,
        already: true,
        status: "completed",
        regionId: order.regionId || order.regionDbId,
        imageUrl: order.finalImageUrl || order.image?.url,
        unitPrice: order.unitPrice || null,
        total: order.total || null,
        currency: order.currency || paidCurr,
        paypalOrderId: order.paypalOrderId || paypalOrderId || null,
        paypalCaptureId: order.paypalCaptureId
      });
    }

    const uid      = String(order.uid || '').trim();
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.linkUrl || '').trim();
    const blocks   = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    const regionIn = String(order.regionId || '').trim();
    const imageUrl = order.image?.url || order.finalImageUrl || null;

    if (!uid || !name || !linkUrl || !blocks.length) {
      return bad(400, "ORDER_INVALID");
    }
    const regionUuid = isUuid(regionIn) ? regionIn : (await import('node:crypto')).randomUUID();

    // --- 4) Supabase + contrôles
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // déjà vendu ?
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells').select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);
    if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
    if (soldRows && soldRows.length) {
      // === PATCH: refund + release ===
      try {
        const accessToken = await getPayPalAccessToken();
        const refund = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
        try {
          const updated = { ...order, status:'failed_refunded', updatedAt: Date.now(), failReason:'ALREADY_SOLD',
            refundId: refund?.id || null, paypalOrderId: paypalOrderId || order.paypalOrderId || null,
            paypalCaptureId: captureId || order.paypalCaptureId || null };
          await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (already sold)`);
        } catch(_) {}
      } catch(_) {}
      return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });
    }

    // locks par autre UID ?
    const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks').select('idx, uid, until')
      .in('idx', blocks)
      .gt('until', nowIso)
      .neq('uid', uid);
    if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
    if (lockRows && lockRows.length) {
      // === PATCH: refund + release ===
      try {
        const accessToken = await getPayPalAccessToken();
        const refund = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
        try {
          const updated = { ...order, status:'failed_refunded', updatedAt: Date.now(), failReason:'LOCKED_BY_OTHER',
            refundId: refund?.id || null, paypalOrderId: paypalOrderId || order.paypalOrderId || null,
            paypalCaptureId: captureId || order.paypalCaptureId || null };
          await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (locked by other)`);
        } catch(_) {}
      } catch(_) {}
      return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });
    }

    // (Ré)appliquer locks 2 min pour uid
    const until = new Date(Date.now() + 2*60*1000).toISOString();
    const upsertRows = blocks.map(idx => ({ idx, uid, until }));
    const { error: upsertErr } = await supabase.from('locks').upsert(upsertRows, { onConflict: 'idx' });
    if (upsertErr) return bad(500, 'LOCKS_UPSERT_FAILED', { message: upsertErr.message });

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
      // === PATCH: refund + release ===
      try {
        const accessToken = await getPayPalAccessToken();
        const refund = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
        try {
          const updated = { ...order, status:'failed_refunded', updatedAt: Date.now(), failReason:'UNDERPAID',
            serverTotal: total, paidTotal, currency: usedCurrency,
            refundId: refund?.id || null, paypalOrderId: paypalOrderId || order.paypalOrderId || null,
            paypalCaptureId: captureId || order.paypalCaptureId || null };
          await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (underpaid)`);
        } catch(_) {}
      } catch(_) {}
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

        // === PATCH: refund + release ===
        try {
          const accessToken = await getPayPalAccessToken();
          const refund = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
          try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
          try {
            const updated = { ...order, status:'failed_refunded', updatedAt: Date.now(), failReason:'PRICE_CHANGED',
              serverUnitPrice: up2, serverTotal: tot2, currency: usedCurrency,
              refundId: refund?.id || null, paypalOrderId: paypalOrderId || order.paypalOrderId || null,
              paypalCaptureId: captureId || order.paypalCaptureId || null };
            await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (price_changed)`);
          } catch(_) {}
        } catch(_) {}

        return bad(409, 'PRICE_CHANGED', { serverUnitPrice: up2, serverTotal: tot2, currency: usedCurrency });
      }

      // === PATCH: refund + release pour autres erreurs RPC ===
      try {
        const accessToken = await getPayPalAccessToken();
        const refund = captureId ? await refundPayPalCapture(accessToken, captureId, paidTotal, paidCurr) : null;
        try { await releaseLocks(supabase, blocks, uid); } catch(_) {}
        try {
          const updated = { ...order, status:'failed_refunded', updatedAt: Date.now(),
            failReason: (msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
                     : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
                     : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR')),
            refundId: refund?.id || null, paypalOrderId: paypalOrderId || order.paypalOrderId || null,
            paypalCaptureId: captureId || order.paypalCaptureId || null };
          await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (finalize failed)`);
        } catch(_) {}
      } catch(_) {}

      if (msg.includes('LOCKS_INVALID')) return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS')) return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // --- 7) Succès — marquer completed + journaliser
    try {
      const updated = {
        ...order,
        status: 'completed',
        updatedAt: Date.now(),
        finalImageUrl: imageUrl || null,
        regionDbId: regionUuid,
        unitPrice,
        total,
        currency: usedCurrency,
        paypalOrderId: paypalOrderId || order.paypalOrderId || null,
        paypalCaptureId: captureId || order.paypalCaptureId || null
      };
      await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (webhook)`);
    } catch(_) { /* non bloquant */ }

    // === PATCH: libération des locks en cas de succès (best-effort) ===
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
