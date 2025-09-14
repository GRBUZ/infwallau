// netlify/functions/_manual-refund-logger.js
// Écrit un petit JSON dans GitHub si un refund automatique a échoué.
// No-op si GH_* n'est pas configuré.

const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const LOG_DIR   = process.env.REFUND_LOG_DIR || 'ops/manual-refunds';

function hasGh() { return !!(GH_REPO && GH_TOKEN); }

async function ghCreateJson(path, jsonData, message){
  if (!hasGh()) return false;
  const pretty  = JSON.stringify(jsonData, null, 2) + '\n';
  const content = Buffer.from(pretty, 'utf-8').toString('base64');

  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message || 'chore: queue manual refund',
        content,
        branch: GH_BRANCH
      })
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    console.error('[RefundLogger] GH PUT failed', res.status, t);
    return false;
  }
  return true;
}

function buildPath(orderId, captureId){
  const dt  = new Date();
  const y   = dt.getUTCFullYear();
  const m   = String(dt.getUTCMonth()+1).padStart(2,'0');
  const d   = String(dt.getUTCDate()).padStart(2,'0');
  const ts  = dt.toISOString().replace(/[:.]/g,''); // y-m-dThhmmssZ
  const rnd = Math.random().toString(36).slice(2,8);
  const oid = orderId || 'noorder';
  const cap = captureId || 'nocapture';
  return `${LOG_DIR}/${y}/${m}/${d}/${oid}__${cap}__${ts}_${rnd}.json`;
}

async function logManualRefundNeeded(payload = {}){
  if (!hasGh()) return false;

  const record = {
    type: 'manual_refund_needed',
    createdAt: Date.now(),
    createdAtIso: new Date().toISOString(),
    // données utiles au back-office, pas de secret
    orderId:        payload.orderId || null,
    uid:            payload.uid || null,
    regionId:       payload.regionId || null,
    blocks:         Array.isArray(payload.blocks) ? payload.blocks : undefined,
    amount:         Number.isFinite(payload.amount) ? Number(payload.amount) : null,
    currency:       (payload.currency || 'USD').toUpperCase(),
    paypalOrderId:  payload.paypalOrderId || null,
    paypalCaptureId:payload.paypalCaptureId || null,
    reason:         payload.reason || 'REFUND_FAILED',
    error:          payload.error  || null,
    route:          payload.route  || null // 'capture-finalize' | 'webhook'
  };

  const path = buildPath(record.orderId, record.paypalCaptureId);
  return ghCreateJson(path, record, `ops: manual refund needed for ${record.orderId || 'unknown'}`);
}

module.exports = { logManualRefundNeeded };
