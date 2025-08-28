// netlify/functions/jwt-middleware.js — middleware JWT robuste (v1/v2)
// Conserve ta vérif HMAC maison (pas de dépendance externe)
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';

// ---------- utils ----------
function base64UrlDecode(str) {
  str += '==='.slice(0, (4 - str.length % 4) % 4);
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function verifyJWT(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');

    const [headerB64, payloadB64, signatureB64] = parts;
    const data = `${headerB64}.${payloadB64}`;

    // HMAC SHA-256
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    if (signatureB64 !== expectedSignature) {
      throw new Error('Invalid signature');
    }

    const payload = JSON.parse(base64UrlDecode(payloadB64));

    // expiration (secs)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error('Token expired');
    }

    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: e.message || 'JWT_VERIFY_FAILED' };
  }
}

// Récupère la valeur de l'en-tête Authorization quel que soit le type de requête
function getAuthorizationHeader(input) {
  // Netlify v2 (Request avec headers.get)
  if (input && input.headers && typeof input.headers.get === 'function') {
    return input.headers.get('authorization') || input.headers.get('Authorization') || '';
  }
  // Netlify v1 (event.headers objet)
  if (input && input.headers && typeof input.headers === 'object') {
    const h = input.headers;
    return h.authorization || h.Authorization || h['authorization'] || h['Authorization'] || '';
  }
  // Express-like (req.headers objet simple)
  if (input && input.headers) {
    const h = input.headers;
    if (typeof h.get === 'function') {
      return h.get('authorization') || h.get('Authorization') || '';
    }
    return h.authorization || h.Authorization || '';
  }
  return '';
}

// Construit une réponse 401 au bon format (v1 object ou v2 Response)
function makeUnauthorized(input, message) {
  const payload = {
    ok: false,
    error: 'UNAUTHORIZED',
    message: message || 'Unauthorized',
  };
  const headers = {
    'content-type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'cache-control': 'no-store',
  };

  // v2: si on nous a passé un Request, renvoyer un Response
  if (input && input.headers && typeof input.headers.get === 'function') {
    return new Response(JSON.stringify(payload), { status: 401, headers });
  }

  // v1: objet { statusCode, headers, body }
  return {
    statusCode: 401,
    headers,
    body: JSON.stringify(payload),
  };
}

// ---------- cœur authent ----------
function authenticate(input) {
  const raw = getAuthorizationHeader(input);
  if (!raw) {
    return { authenticated: false, error: 'NO_TOKEN' };
  }

  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw.trim();
  const result = verifyJWT(token);
  if (!result.valid) {
    return { authenticated: false, error: result.error || 'INVALID_TOKEN' };
  }

  const p = result.payload || {};
  const uid =
    p.uid || p.sub || p.user_id || p.userId || p.id || '';

  if (!uid) {
    return { authenticated: false, error: 'NO_UID_IN_TOKEN' };
  }

  return { authenticated: true, uid, payload: p };
}

// API exportée (compatible avec ton code existant)

// requireAuth(input):
//  - si OK → { authenticated:true, uid, payload }
//  - si KO → objet 401 (v1) ou Response 401 (v2)
function requireAuth(input) {
  // Gérer le preflight rapidement
  const method =
    (input && input.method) ||
    (input && input.httpMethod) ||
    '';
  if (String(method).toUpperCase() === 'OPTIONS') {
    // Autoriser CORS
    const headers = {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    };
    if (input && input.headers && typeof input.headers.get === 'function') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const auth = authenticate(input);
  if (!auth.authenticated) {
    return makeUnauthorized(input, auth.error);
  }
  return auth;
}

// (facultatif) utilitaire pratique
function getAuthenticatedUID(input) {
  const auth = authenticate(input);
  return auth.authenticated ? auth.uid : '';
}

module.exports = { authenticate, requireAuth, getAuthenticatedUID };
