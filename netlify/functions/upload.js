// netlify/functions/upload.js — Supabase Storage drop-in (contrat /upload inchangé)
// Auth JWT via requireAuth. Accepte multipart/form-data OU JSON { regionId, filename, contentType, contentBase64 }.
// Retour: { ok:true, regionId, path, imageUrl, signature:"upload.v2" }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET  = process.env.SUPABASE_BUCKET || 'images';

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok:false, error, ...extra, signature:"upload.v2" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok:true, signature:"upload.v2", ...body })
  };
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  const cleaned = base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 100);
  const stem = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext  = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  const ts   = Date.now();
  const rnd  = Math.random().toString(36).slice(2, 8);
  return `${stem}_${ts}_${rnd}${ext}`;
}

// Parser multipart simple (même esprit que ton ancien fichier)
function parseMultipartFormData(bodyStr, boundary) {
  const parts = bodyStr.split(`--${boundary}`);
  const formData = {};
  for (const part of parts) {
    if (!part.trim() || part.trim() === '--') continue;
    const [headers, ...bodyParts] = part.split('\r\n\r\n');
    if (!headers || bodyParts.length === 0) continue;
    const disp = headers.match(/Content-Disposition: form-data; name="([^"]+)"/);
    if (!disp) continue;
    const fieldName = disp[1];
    let content = bodyParts.join('\r\n\r\n').replace(/\r\n--$/, '');
    if (headers.includes('filename=')) {
      const filename = headers.match(/filename="([^"]+)"/)?.[1] || 'unknown';
      const contentType = headers.match(/Content-Type: ([^\r\n]+)/)?.[1] || 'application/octet-stream';
      formData[fieldName] = { name: filename, type: contentType, data: content };
    } else {
      formData[fieldName] = content.trim();
    }
  }
  return formData;
}

exports.handler = async (event) => {
  try {
    // Auth
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Import dynamique (ESM)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    const ctHeader = (event.headers['content-type'] || event.headers['Content-Type'] || "").toLowerCase();
    let regionId = ""; let filename = ""; let buffer = null; let contentType = "";

    if (ctHeader.includes("multipart/form-data")) {
      // Netlify envoie souvent body en base64 pour multipart
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", 'base64').toString('binary')
        : (event.body || "");
      const boundary = ctHeader.match(/boundary=([^;]+)/)?.[1];
      if (!boundary) return bad(400, "NO_BOUNDARY");

      const form = parseMultipartFormData(rawBody, boundary);
      const file = form.file;
      regionId = String(form.regionId || "").trim();

      if (!file || !file.name) return bad(400, "NO_FILE");
if (!file.type || !file.type.startsWith("image/")) return bad(400, "NOT_IMAGE");

// Liste blanche stricte
const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
if (!allowedTypes.includes(file.type)) {
  return bad(400, "UNSUPPORTED_IMAGE_TYPE", { allowed: allowedTypes });
}

contentType = file.type;
filename = safeFilename(file.name);
buffer = Buffer.from(file.data || "", 'binary'); // binaire

    } else {
      // JSON { regionId, filename, contentType, contentBase64 }
      let body = {};
      try { body = event.body ? JSON.parse(event.body) : {}; } catch { return bad(400, "BAD_JSON"); }
      regionId = String(body.regionId || "").trim();
      filename = safeFilename(body.filename || "image.jpg");
      //contentType = String(body.contentType || "image/jpeg");
      //if (!contentType.startsWith("image/")) return bad(400, "NOT_IMAGE");

      contentType = String(body.contentType || "image/jpeg");

// Liste blanche stricte
const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
if (!allowedTypes.includes(contentType)) {
  return bad(400, "UNSUPPORTED_IMAGE_TYPE", { allowed: allowedTypes });
}


      let b64 = String(body.contentBase64 || body.data || "");
      const m = b64.match(/^data:[^;]+;base64,(.*)$/i); if (m) b64 = m[1];
      if (!b64) return bad(400, "NO_FILE_BASE64");
      buffer = Buffer.from(b64, "base64");
    }

    if (!regionId) return bad(400, "MISSING_REGION_ID");

    // Chemin final et stable dans le bucket
    const objectPath = `regions/${regionId}/${filename}`;

    // Upload (upsert pour tolérer les retries)
    const { error: upErr } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(objectPath, buffer, { contentType, upsert: true });

    if (upErr) return bad(500, "STORAGE_UPLOAD_FAILED", { message: upErr.message });

    // URL publique (absolue) — c’est ce que consommera /link-image sans toucher GitHub
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const imageUrl = pub?.publicUrl
      || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;

    return ok({
      regionId,
      path: `${SUPABASE_BUCKET}/${objectPath}`, // informatif
      imageUrl
    });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
