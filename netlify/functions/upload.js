// netlify/functions/upload.js (v2, converti en fonction classique)
const { requireAuth } = require('./auth-middleware');

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra, signature:"upload.v2" })
  };
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  
  // Nettoyer le nom de base
  const cleaned = base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 100);
  
  // Séparer nom et extension
  const nameWithoutExt = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  
  // Ajouter timestamp + random pour garantir l'unicité
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8); // 6 caractères aléatoires
  
  return `${nameWithoutExt}_${timestamp}_${random}${ext}`;
}

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha, message){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const body = {
    message: message || "chore: set region imageUrl",
    content: Buffer.from(pretty, "utf-8").toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha; // n'ajouter sha que s'il existe, sinon 422
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json(); // contient { commit:{ sha:... }, content:{ sha:... } }
}

// Version "upsert" pour les binaires
// Version "upsert" pour les binaires avec retry sur conflit
async function ghPutBinary(path, buffer, message){
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // Fonction pour tenter l'upload
  async function attemptUpload(retryCount = 0) {
    // 1) probe: existe-t-il déjà ? (pour récupérer le sha)
    let sha = null;
    const probe = await fetch(`${baseURL}?ref=${GH_BRANCH}`, { headers });
    if (probe.ok) {
      const j = await probe.json();
      sha = j.sha || null;
    } else if (probe.status !== 404) {
      // autre erreur (ex: 409 si branche), on lève
      throw new Error(`GH_GET_PROBE_FAILED:${probe.status}`);
    }

    // 2) PUT avec ou sans sha (update si sha présent, sinon create)
    const body = {
      message: message || `feat: upload ${path}`,
      content: Buffer.from(buffer).toString("base64"),
      branch: GH_BRANCH
    };
    if (sha) body.sha = sha;

    const put = await fetch(baseURL, { method: "PUT", headers, body: JSON.stringify(body) });
    
    // 3) Gestion du conflit 409
    if (put.status === 409 && retryCount === 0) {
      console.warn(`Upload: Binary conflict detected for ${path}, retrying once...`);
      await new Promise(resolve => setTimeout(resolve, 200)); // petit délai
      return attemptUpload(1); // retry une seule fois
    }
    
    if (!put.ok) throw new Error(`GH_PUT_BIN_FAILED:${put.status}`);
    return put.json();
  }

  return attemptUpload();
}

// Helper pour parser multipart/form-data dans Function classique
function parseMultipartFormData(body, boundary) {
  const parts = body.split(`--${boundary}`);
  const formData = {};
  
  for (const part of parts) {
    if (!part.trim() || part.trim() === '--') continue;
    
    const [headers, ...bodyParts] = part.split('\r\n\r\n');
    if (!headers || bodyParts.length === 0) continue;
    
    const disposition = headers.match(/Content-Disposition: form-data; name="([^"]+)"/);
    if (!disposition) continue;
    
    const fieldName = disposition[1];
    let content = bodyParts.join('\r\n\r\n').replace(/\r\n--$/, '');
    
    if (headers.includes('filename=')) {
      // C'est un fichier
      const filename = headers.match(/filename="([^"]+)"/)?.[1] || 'unknown';
      const contentType = headers.match(/Content-Type: ([^\r\n]+)/)?.[1] || 'application/octet-stream';
      
      formData[fieldName] = {
        name: filename,
        type: contentType,
        data: content
      };
    } else {
      // C'est un champ texte
      formData[fieldName] = content.trim();
    }
  }
  
  return formData;
}

exports.handler = async (event) => {
  try {
    // Authentification requise
    const auth = requireAuth(event);
    if (auth.statusCode) return auth; // Erreur d'auth
    
    const authenticatedUID = auth.uid;
    
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || "").toLowerCase();

    let regionId = "";
    let filename = "";
    let buffer   = null;

    if (ct.includes("multipart/form-data")) {
      // Parser multipart manuellement pour Function classique
      const boundary = ct.match(/boundary=([^;]+)/)?.[1];
      if (!boundary) return bad(400, "NO_BOUNDARY");
      
      const formData = parseMultipartFormData(event.body, boundary);
      
      const file = formData.file;
      regionId   = String(formData.regionId || "").trim();
      
      if (!file || !file.name) return bad(400, "NO_FILE");
      if (!file.type || !file.type.startsWith("image/")) return bad(400, "NOT_IMAGE");
      
      filename = safeFilename(file.name);
      // Le contenu est en base64 dans event.body pour les binaires
      buffer   = Buffer.from(file.data, 'binary');
    } else {
      // JSON format
      const body = JSON.parse(event.body || '{}');
      regionId = String(body.regionId || "").trim();
      filename = safeFilename(body.filename || "image.jpg");
      const b64 = String(body.contentBase64 || "");
      if (!b64) return bad(400, "NO_FILE_BASE64");
      buffer   = Buffer.from(b64, "base64");
    }

    if (!regionId) return bad(400, "MISSING_REGION_ID");

    // 1) commit du binaire
    const repoPath = `assets/images/${regionId}/${filename}`;
    const putBin   = await ghPutBinary(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);
    const binSha   = putBin?.commit?.sha;

    // 2) URL RAW
    const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${repoPath}`;

    // 3) mise à jour state.json → regions[regionId].imageUrl
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const state = state0 || { sold:{}, locks:{}, regions:{} };
    (state.regions ||= {});
    (state.regions[regionId] ||= { imageUrl:"", rect:{ x:0, y:0, w:1, h:1 } });
    state.regions[regionId].imageUrl = imageUrl;

    const putJson = await ghPutJson(STATE_PATH, state, sha, `chore: set imageUrl for ${regionId}`);
    const jsonSha = putJson?.commit?.sha;

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({
        ok: true,
        signature: "upload.v2",
        regionId,
        path: repoPath,
        imageUrl,
        GH_REPO,
        GH_BRANCH,
        binSha,
        jsonSha
      })
    };
    
  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e), signature:"upload.v2" });
  }
};