// upload-temp.js — Upload et validation temporaire d'images
const { requireAuth } = require('./auth-middleware');

const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra })
  };
}

function safeFilename(name, tempId) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base = parts[parts.length - 1];
  const cleaned = base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 50);
  const nameWithoutExt = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  return `temp_${tempId}_${nameWithoutExt}${ext}`;
}

async function validateImageBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('EMPTY_FILE');
  }

  // Taille max
  if (buffer.length > 1.5 * 1024 * 1024) {
    throw new Error('FILE_TOO_LARGE');
  }

  // Magic bytes validation
  const bytes = new Uint8Array(buffer.slice(0, 12));
  
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  
  // PNG
  if (bytes.length >= 8 && 
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }
  
  // GIF
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }

  throw new Error('INVALID_IMAGE_FORMAT');
}

async function ghPutBinary(path, buffer) {
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // Vérifier si le fichier existe déjà
  let sha = null;
  const probe = await fetch(`${baseURL}?ref=${GH_BRANCH}`, { headers });
  if (probe.ok) {
    const j = await probe.json();
    sha = j.sha || null;
  } else if (probe.status !== 404) {
    throw new Error(`GH_PROBE_FAILED:${probe.status}`);
  }

  // Upload
  const body = {
    message: `temp: upload temp image ${path}`,
    content: Buffer.from(buffer).toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;

  const put = await fetch(baseURL, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GH_PUT_FAILED:${put.status}`);
  return put.json();
}

// Parser multipart simple
function parseMultipart(body, boundary) {
  const parts = body.split(`--${boundary}`);
  const result = {};
  
  for (const part of parts) {
    if (!part.trim() || part.trim() === '--') continue;
    
    const [headers, ...bodyParts] = part.split('\r\n\r\n');
    if (!headers || bodyParts.length === 0) continue;
    
    const disposition = headers.match(/Content-Disposition: form-data; name="([^"]+)"/);
    if (!disposition) continue;
    
    const fieldName = disposition[1];
    let content = bodyParts.join('\r\n\r\n').replace(/\r\n--$/, '');
    
    if (headers.includes('filename=')) {
      const filename = headers.match(/filename="([^"]+)"/)?.[1] || 'unknown';
      result[fieldName] = {
        name: filename,
        data: Buffer.from(content, 'binary')
      };
    } else {
      result[fieldName] = content.trim();
    }
  }
  
  return result;
}

exports.handler = async (event) => {
  try {
    // Auth requise
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const contentType = (event.headers['content-type'] || '').toLowerCase();
    
    if (!contentType.includes('multipart/form-data')) {
      return bad(400, "MULTIPART_REQUIRED");
    }

    const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
    if (!boundary) return bad(400, "NO_BOUNDARY");

    const formData = parseMultipart(event.body, boundary);
    
    const file = formData.file;
    const tempId = formData.tempId?.trim();
    const action = formData.action?.trim();

    if (!file?.data || !tempId) {
      return bad(400, "MISSING_FILE_OR_TEMP_ID");
    }

    // Validation
    const imageType = await validateImageBuffer(file.data);
    const filename = safeFilename(file.name, tempId);
    
    // Upload vers dossier temporaire
    const tempPath = `assets/temp/${filename}`;
    await ghPutBinary(tempPath, file.data);

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({
        ok: true,
        tempPath,
        filename,
        imageType,
        size: file.data.length,
        tempId
      })
    };

  } catch (error) {
    const message = error.message || String(error);
    
    // Erreurs spécifiques
    if (message.includes('FILE_TOO_LARGE')) {
      return bad(400, "FILE_TOO_LARGE", { maxSize: "1.5 MB" });
    }
    if (message.includes('INVALID_IMAGE_FORMAT')) {
      return bad(400, "INVALID_IMAGE_FORMAT", { allowed: ["JPEG", "PNG", "GIF"] });
    }
    if (message.includes('EMPTY_FILE')) {
      return bad(400, "EMPTY_FILE");
    }

    return bad(500, "UPLOAD_TEMP_FAILED", { message });
  }
};