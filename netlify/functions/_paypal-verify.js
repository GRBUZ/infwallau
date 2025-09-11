// netlify/functions/_paypal-verify.js
// Helper pour vérifier un webhook PayPal via l'endpoint officiel
// Variables requises: PAYPAL_ENV ('sandbox'|'live'), PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID

const PAYPAL_ENV           = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID    = process.env.PAYPAL_WEBHOOK_ID;

const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CONFIG_MISSING');
  }
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`PAYPAL_TOKEN_FAILED:${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('PAYPAL_TOKEN_NO_ACCESS_TOKEN');
  return j.access_token;
}

/**
 * Vérifie la signature d'un webhook PayPal.
 * @param {Object} headers - event.headers (clés insensibles à la casse)
 * @param {string} rawBody - body brut (string, pas encore parsé)
 * @returns {Promise<{verified:boolean, details?:object}>}
 */
async function verifyPayPalWebhook(headers, rawBody) {
  if (!PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID_MISSING');

  // headers en lower-case
  const h = {};
  for (const [k,v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;

  const transmissionId  = h['paypal-transmission-id'];
  const transmissionTime= h['paypal-transmission-time'];
  const certUrl         = h['paypal-cert-url'];
  const authAlgo        = h['paypal-auth-algo'];
  const transmissionSig = h['paypal-transmission-sig'];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return { verified:false, details:{ reason:'MISSING_REQUIRED_HEADERS' } };
  }

  const webhookEvent = JSON.parse(rawBody || '{}'); // l’objet d’événement original

  const token = await getAccessToken();
  const r = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      transmission_id:  transmissionId,
      transmission_time: transmissionTime,
      cert_url:         certUrl,
      auth_algo:        authAlgo,
      transmission_sig: transmissionSig,
      webhook_id:       PAYPAL_WEBHOOK_ID,
      webhook_event:    webhookEvent
    })
  });

  if (!r.ok) {
    return { verified:false, details:{ reason:`VERIFY_HTTP_${r.status}` } };
  }

  const j = await r.json(); // { verification_status: 'SUCCESS' | 'FAILURE', ... }
  return {
    verified: String(j.verification_status).toUpperCase() === 'SUCCESS',
    details:  j
  };
}

module.exports = { verifyPayPalWebhook };
