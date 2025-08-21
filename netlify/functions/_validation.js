// _validation.js — drop-in guards for finalize()
// Place this file at: netlify/functions/_validation.js
// Usage in finalize.js:
//   const { guardFinalizeInput } = require('./_validation.js');
//   const { name, linkUrl, blocks } = await guardFinalizeInput(event);

const GRID_CELLS = 100 * 100;          // 100x100 blocks
const MAX_BLOCKS_PER_ORDER = 3000;     // safety cap (30% of grid) — adjust to your needs
const NAME_MAX = 40;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// If you want to restrict to your production origin, set env ALLOWED_ORIGIN
// Example: https://warm-malabi-05bff8.netlify.app
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function bad(status, error) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ok: false, error })
  };
}

function sanitizeName(name) {
  if (!name) return '';
  name = String(name).trim();
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
  // remove angle brackets and hard control chars
  name = name.replace(/[<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, '');
  return name;
}

function validateUrlOrThrow(urlStr) {
  if (!urlStr) throw new Error('MISSING_URL');
  let u;
  try { u = new URL(String(urlStr)); } catch { throw new Error('INVALID_URL'); }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) throw new Error('INVALID_URL_SCHEME');
  // Simple normalization (strip fragments)
  u.hash = '';
  return u.toString();
}

function validateBlocksOrThrow(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('NO_BLOCKS');
  if (blocks.length > MAX_BLOCKS_PER_ORDER) throw new Error('TOO_MANY_BLOCKS');
  const seen = new Set();
  for (const v of blocks) {
    if (!Number.isInteger(v)) throw new Error('BLOCKS_NOT_INTEGERS');
    if (v < 0 || v >= GRID_CELLS) throw new Error('BLOCK_OUT_OF_RANGE');
    if (seen.has(v)) throw new Error('BLOCKS_DUPLICATED');
    seen.add(v);
  }
  return blocks;
}

function checkOriginOrThrow(event) {
  if (!ALLOWED_ORIGIN) return; // skip if not configured
  
  // Dans les Functions classiques, les headers sont dans event.headers
  const origin = event.headers.origin || event.headers.referer || 
                 event.headers.Origin || event.headers.Referer || '';
                 
  if (!origin) throw new Error('ORIGIN_MISSING');
  try {
    const allowed = new URL(ALLOWED_ORIGIN).origin;
    const seen = new URL(origin).origin;
    if (allowed !== seen) throw new Error('ORIGIN_FORBIDDEN');
  } catch {
    throw new Error('ORIGIN_FORBIDDEN');
  }
}

async function guardFinalizeInput(event) {
  // 1) Origin check (optional but recommended)
  try { 
    checkOriginOrThrow(event); 
  } catch (e) { 
    throw bad(403, e.message); 
  }

  // 2) Parse JSON body safely (limit size ~100KB via Netlify defaults, still validate)
  let payload;
  try { 
    payload = JSON.parse(event.body || '{}'); 
  } catch { 
    throw bad(400, 'BAD_JSON'); 
  }

  // 3) Extract + validate
  const name = sanitizeName(payload?.name || '');
  const linkUrl = validateUrlOrThrow(payload?.linkUrl);
  const blocks = validateBlocksOrThrow(payload?.blocks);

  // 4) Optional: tiny anti-abuse token (nonce) check
  //    If you decide to send a per-session nonce header, verify it here.

  return { name, linkUrl, blocks };
}

// Export pour Functions classiques (CommonJS)
module.exports = {
  guardFinalizeInput,
  sanitizeName,
  validateUrlOrThrow,
  validateBlocksOrThrow
};