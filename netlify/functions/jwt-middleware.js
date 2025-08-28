// netlify/functions/auth-middleware.js — middleware JWT
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';

function base64UrlDecode(str) {
  str += '==='.slice(0, (4 - str.length % 4) % 4);
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

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

function authenticate(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'NO_TOKEN' };
  }
  
  const token = authHeader.slice(7);
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        ok: false, 
        error: 'UNAUTHORIZED',
        message: auth.error 
      })
    };
  }
  return auth;
}

module.exports = { authenticate, requireAuth };