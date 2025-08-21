// netlify/functions/auth-token.js — génère des JWT anonymes
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRY_HOURS = 24;

function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  
  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${data}.${signature}`;
}

function isValidUID(uid) {
  const uidStr = String(uid || '').trim();
  return uidStr.length >= 8 && uidStr.length <= 128 && /^[a-zA-Z0-9\-_]+$/.test(uidStr);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' })
      };
    }
    
    const body = JSON.parse(event.body || '{}');
    if (!body.uid) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'MISSING_UID' })
      };
    }
    
    if (!isValidUID(body.uid)) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'INVALID_UID' })
      };
    }
    
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      uid: body.uid,
      anonymous: true,
      iat: now,
      exp: now + (JWT_EXPIRY_HOURS * 3600)
    };
    
    const token = signJWT(payload);
    
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        ok: true, 
        token,
        expiresIn: JWT_EXPIRY_HOURS * 3600
      })
    };
    
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        ok: false, 
        error: 'SERVER_ERROR',
        message: String(e.message || e)
      })
    };
  }
};