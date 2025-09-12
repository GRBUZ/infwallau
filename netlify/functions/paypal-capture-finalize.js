// netlify/functions/paypal-capture-finalize.js
// Capture PayPal côté serveur + finalisation atomique via Supabase RPC finalize_paid_order
// Entrée: POST { orderId, paypalOrderId }
// Sortie: { ok:true, status:'completed', regionId, imageUrl?, paypalOrderId, paypalCaptureId }

const { requireAuth } = require('./auth-middleware');

// --- Supabase
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- GitHub (orders)
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

// --- PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
//const PAYPAL_SECRET    = process.env.PAYPAL_SECRET;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
// Sandbox par défaut; mets https://api-m.paypal.com en prod via la variable d'env
const PAYPAL_BASE_URL  = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj),
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-capture-finalize.v1' });
const ok  = (b)           => json(200,{ ok:true,  signature:'paypal-capture-finalize.v1', ...b });

async function ghGetJson(path){
  if (!GH_REPO || !GH_TOKEN) return { json:null, sha:null };
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`,
    { headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept':'application/vnd.github+json' } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}
async function ghPutJson(path, jsonData, sha, message){
  if (!GH_REPO || !GH_TOKEN) return null;
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

// === PATCH AJOUTÉ: helper refund PayPal ===
async function refundPayPalCapture(accessToken, captureId, amount, currency) {
  try {
    const resp = await fetch(`${PAYPAL_BASE_URL}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: { value: Number(amount).toFixed(2), currency_code: currency } })
    });
    const j = await resp.json().catch(()=> ({}));
    if (!resp.ok) throw new Error(`PAYPAL_REFUND_FAILED:${resp.status}:${j?.name || ''}`);
    return j; // { id, status, ... }
  } catch (e) {
    console.error('[PayPal] refund failed:', e);
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

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING');
    if (!GH_REPO || !GH_TOKEN) return bad(500,'GITHUB_CONFIG_MISSING');

    // ✅ Ton requireAuth renvoie un objet (ou une réponse 401), ce n’est pas un wrapper.
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth; // 401/JSON directement
    event.auth = auth; // homogénéité avec le reste de ton code
    const { uid } = auth;
    if (!uid) return bad(401, 'UNAUTHORIZED');

    let body={}; try{ body = JSON.parse(event.body||'{}'); }catch{ return bad(400,'BAD_JSON'); }
    const orderId       = String(body.orderId || '').trim();
    const paypalOrderId = String(body.paypalOrderId || '').trim();
    if (!orderId)       return bad(400, 'MISSING_ORDER_ID');
    if (!paypalOrderId) return bad(400, 'MISSING_PAYPAL_ORDER_ID');

    // 1) Charger l’ordre GitHub et vérifier ownership
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const { json: order, sha: orderSha } = await ghGetJson(orderPath);
    if (!order) return bad(404, 'ORDER_NOT_FOUND');
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN');

    // Idempotence: si déjà complété → OK direct
    if (order.status === 'completed' && order.paypalCaptureId) {
      return ok({ status:'completed', orderId, regionId: order.regionDbId, imageUrl: order.finalImageUrl || null, paypalOrderId, paypalCaptureId: order.paypalCaptureId });
    }

    // Vérifier cohérence paypalOrderId
    if (order.paypalOrderId && order.paypalOrderId !== paypalOrderId) {
      return bad(409, 'PAYPAL_ORDER_MISMATCH', { expected: order.paypalOrderId, got: paypalOrderId });
    }

    // 2) Recalcule prix côté serveur
    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');
    const currency = String(order.currency || 'USD').toUpperCase();

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

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

    // Si l'order GitHub possède un total différent → on refuse la CAPTURE (le client doit refaire /create-order)
    if (order.total != null && Number(order.total) !== Number(serverTotal)) {
      const patched = { ...order, priceChangedAt: Date.now(), serverUnitPrice: unitPrice, serverTotal, currency };
      try { await ghPutJson(orderPath, patched, orderSha, `chore: price changed before capture for ${orderId}`); } catch {}
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
      const patched = { ...order, priceChangedAt: Date.now(), serverUnitPrice: unitPrice, serverTotal, currency };
      try { await ghPutJson(orderPath, patched, orderSha, `chore: paypal amount mismatch before capture for ${orderId}`); } catch {}
      return bad(409, 'PRICE_CHANGED', { serverUnitPrice: unitPrice, serverTotal, currency });
    }
    if (ppOrder.status === 'COMPLETED') {
      // Déjà capturé (ex: capture SDK front) -> on saute la capture et on va finaliser
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
    const linkUrl  = String(order.linkUrl || '').trim();
    const blocksOk = blocks;
    if (!name || !linkUrl || !blocksOk.length) return bad(400, 'MISSING_FIELDS');

    let regionId = String(order.regionId || '').trim();
    if (!isUuid(regionId)) regionId = (await import('node:crypto')).randomUUID();

    const imageUrl = order.image?.url || order.finalImageUrl || null;
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

      // === PATCH: REFUND + libération des locks si la finalisation échoue après capture ===
      try {
        const refund = await refundPayPalCapture(accessToken, captureId, capValue, currency);
        try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

        // journal best-effort
        try {
          const updated = {
            ...order,
            status: 'failed_refunded',
            updatedAt: Date.now(),
            failReason: msg.includes('LOCKS_INVALID') ? 'LOCKS_INVALID'
                     : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) ? 'ALREADY_SOLD'
                     : (msg.includes('NO_BLOCKS') ? 'NO_BLOCKS' : 'FINALIZE_ERROR'),
            refundId: refund?.id || null,
            paypalOrderId,
            paypalCaptureId: captureId,
            serverUnitPrice: unitPrice,
            serverTotal,
            currency
          };
          await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} refunded (finalize failed)`);
        } catch(_) {}
      } catch(_) {}

      if (msg.includes('LOCKS_INVALID'))                          return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) return bad(409, 'ALREADY_SOLD');
      if (msg.includes('NO_BLOCKS'))                              return bad(400, 'NO_BLOCKS');
      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 5) Marquer l'order GH comme completed (best-effort)
    try {
      const updated = {
        ...order,
        status: 'completed',
        updatedAt: Date.now(),
        regionDbId: regionId,
        finalImageUrl: imageUrl || null,
        paypalOrderId,
        paypalCaptureId: captureId,
        unitPrice,
        total: serverTotal,
        currency
      };
      await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (capture+rpc)`);
    } catch (_){}

    // === PATCH: libération des locks en cas de succès (best-effort) ===
    try { await releaseLocks(supabase, blocksOk, uid); } catch(_) {}

    return ok({ status:'completed', orderId, regionId, imageUrl: imageUrl || null, paypalOrderId, paypalCaptureId: captureId });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
