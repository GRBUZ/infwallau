// jwt-middleware.js — robuste aux différents formats de Netlify Functions
// - Supporte Request (v2 ESM): req.headers.get('authorization')
// - Supporte event (v1 CJS):   event.headers.authorization
// - Supporte req "express-like": req.headers.authorization

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || process.env.NETLIFY_JWT_SECRET || 'dev-secret';

// --- helpers ---
function getAuthHeader(input) {
  // 1) Netlify v2 / WHATWG Request
  if (input && input.headers && typeof input.headers.get === 'function') {
    return (
      input.headers.get('authorization') ||
      input.headers.get('Authorization') ||
      ''
    );
  }
  // 2) Netlify v1 "event"
  if (input && input.headers && typeof input.headers === 'object') {
    const h = input.headers;
    return h.authorization || h.Authorization || '';
  }
  // 3) Express-like req
  if (input && input.headers) {
    const h = input.headers;
    if (typeof h.get === 'function') {
      // certains frameworks exposent aussi get()
      return h.get('authorization') || h.get('Authorization') || '';
    }
    return h.authorization || h.Authorization || '';
  }
  return '';
}

function parseBearer(headerValue) {
  if (!headerValue) return '';
  const parts = String(headerValue).split(' ');
  if (parts.length >= 2 && /^Bearer$/i.test(parts[0])) {
    return parts.slice(1).join(' ');
  }
  // si jamais on envoie "token" brut
  return headerValue.trim();
}

// --- coeur d'authent ---
function authenticate(input) {
  const raw = getAuthHeader(input);
  const token = parseBearer(raw);
  if (!token) {
    const e = new Error('Missing Authorization header');
    e.statusCode = 401;
    throw e;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const e = new Error('Invalid token');
    e.statusCode = 401;
    throw e;
  }

  // normalise l’UID qu’on expose aux handlers
  const uid =
    decoded.uid ||
    decoded.sub ||
    decoded.user_id ||
    decoded.userId ||
    decoded.id;

  if (!uid) {
    const e = new Error('Token has no uid');
    e.statusCode = 401;
    throw e;
  }
  return { uid, decoded };
}

// --- API exportée (compatible avec ton code existant) ---

/**
 * requireAuth(reqOrEvent)
 * - usage actuel dans ton code: const { requireAuth } = require('./jwt-middleware')
 *   const { uid } = await requireAuth(req)
 */
async function requireAuth(reqOrEvent) {
  return authenticate(reqOrEvent);
}

/**
 * getAuthenticatedUID(reqOrEvent)
 * - alias pratique si tu veux juste l'uid
 */
function getAuthenticatedUID(reqOrEvent) {
  const { uid } = authenticate(reqOrEvent);
  return uid;
}

/**
 * wrap(handler)
 * - option : envelopper un handler pour forcer auth et injecter uid en 3e arg
 *   module.exports = wrap(async (req, ctx, uid) => { ... })
 */
function wrap(handler) {
  return async (reqOrEvent, context) => {
    const { uid, decoded } = authenticate(reqOrEvent);
    return handler(reqOrEvent, context, uid, decoded);
  };
}

module.exports = {
  requireAuth,
  getAuthenticatedUID,
  wrap,
};
