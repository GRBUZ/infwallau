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
// ⬇️ signature bump pour vérifier la bonne version en prod
const SIG = 'paypal-capture-finalize.v5';

const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature: SIG });
const ok  = (b)           => json(200,{ ok:true,  ...b, signature: SIG });

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
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED', { step: 'method' });
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500,'SUPABASE_CONFIG_MISSING', { step:'env' });

    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    event.auth = auth;
    const { uid } = auth;
    if (!uid) return bad(401, 'UNAUTHORIZED', { step: 'auth' });

    let body={}; try{ body = JSON.parse(event.body||'{}'); }catch{ return bad(400,'BAD_JSON', { step:'parse' }); }
    const orderId       = String(body.orderId || '').trim();
    const paypalOrderId = String(body.paypalOrderId || '').trim();
    if (!orderId)       return bad(400, 'MISSING_ORDER_ID', { step:'input' });
    if (!paypalOrderId) return bad(400, 'MISSING_PAYPAL_ORDER_ID', { step:'input' });

    // ==== Supabase client ====
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Charger l’ordre et vérifier ownership
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, 'ORDER_NOT_FOUND', { step:'load_order', details: getErr });
    if (order.uid && order.uid !== uid) return bad(403, 'FORBIDDEN', { step:'ownership', orderUid: order.uid, uid });

    // Idempotence
    if (order.status === 'completed' && order.paypal_capture_id) {
      return ok({
        status: 'completed',
        orderId,
        regionId: order.region_id,
        imageUrl: order.image_url || null,
        paypalOrderId: order.paypal_order_id || paypalOrderId,
        paypalCaptureId: order.paypal_capture_id,
        step: 'idempotent'
      });
    }

    if (order.paypal_order_id && order.paypal_order_id !== paypalOrderId) {
      return bad(409, 'PAYPAL_ORDER_MISMATCH', { step:'idempotent', expected: order.paypal_order_id, got: paypalOrderId });
    }

    // 2) Prix serveur (on s'appuie sur la valeur stockée par /start-order)
    const blocks = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS', { step:'price' });

    const serverTotal = Number(order.total);
    const currency    = String(order.currency || 'USD').toUpperCase();
    if (!Number.isFinite(serverTotal)) return bad(409, 'ORDER_PRICE_MISSING', { step:'price' });

    // 3) CAPTURE PayPal
    const accessToken = await getPayPalAccessToken();

    // GET order
    const getOrderRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type':'application/json' }
    });
    if (!getOrderRes.ok) {
      const err = await getOrderRes.json().catch(()=>({}));
      return bad(502, 'PAYPAL_GET_ORDER_FAILED', { step:'pp_get_order', details: err });
    }
    const ppOrder = await getOrderRes.json();
    const pu = (ppOrder.purchase_units && ppOrder.purchase_units[0]) || {};
    const ppAmount = pu.amount || {};
    const ppCurrency = (ppAmount.currency_code || '').toUpperCase();
    const ppValue = Number(ppAmount.value || 0);

    if (pu.custom_id && pu.custom_id !== orderId) {
      return bad(409, 'CUSTOM_ID_MISMATCH', { step:'pp_get_order', expected: orderId, got: pu.custom_id });
    }
    if (ppCurrency !== currency) {
      return bad(409, 'CURRENCY_MISMATCH', { step:'pp_get_order', expected: currency, got: ppCurrency });
    }
    if (Number(ppValue) !== Number(serverTotal)) {
      await supabase.from('orders').update({
        updated_at: new Date().toISOString(),
        fail_reason: 'PRICE_CHANGED'
      }).eq('order_id', orderId);
      return bad(409, 'PRICE_CHANGED', { step:'pp_get_order', serverTotal, currency });
    }
    if (ppOrder.status !== 'COMPLETED' && ppOrder.status !== 'APPROVED') {
      return bad(409, 'ORDER_NOT_APPROVED', { step:'pp_get_order', paypalStatus: ppOrder.status });
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
          return bad(409, 'INSTRUMENT_DECLINED', { step:'pp_capture', retriable: true, details: capJson });
        }
        return bad(502, 'PAYPAL_CAPTURE_FAILED', { step:'pp_capture', details: capJson });
      }

      capture = capJson;

      if (capture.status !== 'COMPLETED') {
        return bad(502, 'PAYPAL_CAPTURE_NOT_COMPLETED', { step:'pp_capture', paypalStatus: capture.status, details: capture });
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

    if (!captureId) return bad(502, 'MISSING_CAPTURE_ID', { step:'pp_capture' });
    if (capCurrency !== currency) return bad(409, 'CURRENCY_MISMATCH', { step:'pp_capture', expected: currency, got: capCurrency });
    if (Number(capValue) !== Number(serverTotal)) {
      return bad(409, 'CAPTURE_AMOUNT_MISMATCH', { step:'pp_capture', expected: serverTotal, got: capValue });
    }

    // ========= 3.5) VALIDATION STRICTE DES LOCKS =========
    const blocksOk = blocks;
    const nowIso = new Date().toISOString();

    // 3.5.a — conflits (locks d’un autre uid) via RPC si dispo
    {
      const viaRpc = await tryRpc(supabase, 'locks_conflicts_in', { p_blocks: blocksOk, p_uid: uid, p_now: nowIso });
      if (!viaRpc.error && Array.isArray(viaRpc.data) && viaRpc.data.length > 0) {
        // Retour verbeux pour debug (pas de refund immédiat)
        return bad(409, 'LOCKS_CONFLICT_RPC', {
          step: 'locks_3.5.a',
          details: {
            expected: blocksOk.length,
            conflictsSample: viaRpc.data.slice(0, 50) // [{idx, uid, until?}] selon ta RPC
          }
        });
      }
    }

    // 3.5.b — compter nos locks valides par tranches (pas de .in() géant)
    {
      const CHUNK = 1000;
      let myValid = 0;

      for (let i = 0; i < blocksOk.length; i += CHUNK) {
        const slice = blocksOk.slice(i, i + CHUNK);
        // légère grâce 5s côté serveur pour éviter les micro-dérives d'horloge
        const nowMinus5s = new Date(Date.now() - 5000).toISOString();
        const { count: c, error: e } = await supabase
          .from('locks')
          .select('idx', { count: 'exact', head: true })
          .in('idx', slice)
          .gt('until', nowMinus5s)
          .eq('uid', uid);

        if (e) return bad(500, 'LOCKS_QUERY_FAILED', { step:'locks_3.5.b', message: e.message });
        myValid += (c || 0);
      }

      // Dump complet (verbeux) si écart
      if (myValid !== blocksOk.length) {
        const validSet = new Set();
        const foreign  = [];   // { idx, uid, until }
        const expired  = [];   // { idx, until }
        const missing  = [];   // indices sans ligne en DB

        const CH = 1000;
        for (let i = 0; i < blocksOk.length; i += CH) {
          const slice = blocksOk.slice(i, i + CH);
          const { data: rows } = await supabase
            .from('locks')
            .select('idx, uid, until')
            .in('idx', slice);

          for (const r of (rows || [])) {
            const untilMs = r.until ? new Date(r.until).getTime() : 0;
            const isMine  = r.uid === uid;
            const isValid = untilMs > Date.now();
            if (isMine && isValid) validSet.add(Number(r.idx));
            else if (!isMine && isValid) foreign.push({ idx: Number(r.idx), uid: r.uid, until: r.until });
            else if (isMine && !isValid) expired.push({ idx: Number(r.idx), until: r.until });
          }
        }
        {
          const seen = new Set([...validSet, ...expired.map(x=>x.idx), ...foreign.map(x=>x.idx)]);
          for (const i of blocksOk) if (!seen.has(i)) missing.push(i);
        }

        return bad(409, 'LOCK_MISSING_OR_EXPIRED', {
          step: 'locks_3.5.b',
          details: {
            expected: blocksOk.length,
            valid: validSet.size,
            sampleMissing: missing.slice(0, 50),
            expiredSample: expired.slice(0, 20),
            foreignSample: foreign.slice(0, 20)
          }
        });

        // NOTE: on NE déclenche PAS de refund ici tant qu'on debug.
        // Ancien comportement (refund) laissé en commentaire :
        // const r = await doRefundFor('LOCKS_INVALID'); return r;
      }
    }

    // 4) Finalisation atomique via RPC
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.link_url || '').trim();
    if (!name || !linkUrl) return bad(400, 'MISSING_FIELDS', { step:'finalize_prep' });

    let regionId = String(order.region_id || '').trim();
    if (!isUuid(regionId)) regionId = (await import('node:crypto')).randomUUID();

    const imageUrl  = order.image_url || null;
    const amount    = Number(capValue);
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
        msg.includes('LOCKS_INVALID')                                 ? 'LOCKS_INVALID'
      : (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT'))    ? 'ALREADY_SOLD'
      : (msg.includes('NO_BLOCKS'))                                   ? 'NO_BLOCKS'
      :                                                                  'FINALIZE_ERROR';

      // Pendant debug, au lieu du refund: renvoyer l’erreur avec message
      return bad(409, 'RPC_FINALIZE_ERROR', {
        step: 'rpc_finalize',
        details: { message: rpcErr.message, reason }
      });

      // (Ancien flux refund conservé pour référence)
      // ...
    }

    // 5) Succès: marquer completed (en doublon avec la RPC qui set orders, au cas où)
    await supabase.from('orders').update({
      status: 'completed',
      paypal_order_id: paypalOrderId,
      paypal_capture_id: captureId,
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
    return bad(500, 'SERVER_ERROR', { step:'catch', message: String(e?.message || e) });
  }
};
