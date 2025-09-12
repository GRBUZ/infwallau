// netlify/functions/auth-middleware.js — middleware JWT (robuste)
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';

// --- utils ---
function base64UrlDecode(str) {
  str += '==='.slice(0, (4 - str.length % 4) % 4);
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function toLowerKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
  return out;
}

function headersFrom(input) {
  // Gère Netlify (event.headers), Express (req.headers) et rawHeaders (Array)
  if (!input) return {};
  if (input.headers) return toLowerKeys(input.headers);
  if (input.req && input.req.headers) return toLowerKeys(input.req.headers);
  if (Array.isArray(input.rawHeaders)) {
    const map = {};
    for (let i = 0; i < input.rawHeaders.length; i += 2) {
      map[String(input.rawHeaders[i]).toLowerCase()] = input.rawHeaders[i + 1];
    }
    return map;
  }
  return {};
}

// --- JWT ---
function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');
    
    const [headerB64, payloadB64, signatureB64] = parts;
    const data = `${headerB64}.${payloadB64}`;
    
    // Vérifier la signature
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    if (signatureB64 !== expectedSignature) {
      throw new Error('Invalid signature');
    }
    
    // Décoder le payload
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    
    // Vérifier l'expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error('Token expired');
    }
    
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// --- Auth ---
function authenticate(eventOrReq) {
  const headers = headersFrom(eventOrReq);
  const authHeader = headers['authorization'] || ''; // insensible à la casse grâce à toLowerKeys

  if (!authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'NO_TOKEN' };
  }

  const token = authHeader.slice(7).trim();
  const result = verifyJWT(token);

  if (!result.valid) {
    return { authenticated: false, error: result.error };
  }

  return {
    authenticated: true,
    uid: result.payload.uid,
    payload: result.payload
  };
}

function requireAuth(event) {
  const auth = authenticate(event);
  if (!auth.authenticated) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: 'UNAUTHORIZED',
        message: auth.error
      })
    };
  }
  return auth;
}

module.exports = { authenticate, requireAuth, verifyJWT };
