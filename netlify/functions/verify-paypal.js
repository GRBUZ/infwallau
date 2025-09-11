// netlify/functions/verify-paypal.js
// Endpoint utilitaire: vérifie cryptographiquement un webhook PayPal (sandbox ou live)

const { verifyPayPalWebhook } = require('./_paypal-verify');

function j(status, obj){
  return { statusCode: status, headers: { 'content-type':'application/json', 'cache-control':'no-store' }, body: JSON.stringify(obj) };
}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'verify-paypal.v1' });
const ok  = (b)           => j(200,{ ok:true,  signature:'verify-paypal.v1', ...b });

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');

    // IMPORTANT: passer le body brut tel que PayPal l’a envoyé
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');

    const { verified, details } = await verifyPayPalWebhook(event.headers || {}, rawBody);
    return ok({ verified, details });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
