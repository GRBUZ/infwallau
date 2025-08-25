// cleanup-temp.js — Nettoyage des fichiers temporaires
const { requireAuth } = require('./auth-middleware');

const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: false, error })
  };
}

async function ghDeleteFile(path) {
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // 1. Récupérer le SHA du fichier
  const getUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`;
  const getRes = await fetch(getUrl, { headers });
  
  if (getRes.status === 404) {
    return { ok: true, message: 'File already deleted' };
  }
  
  if (!getRes.ok) {
    throw new Error(`GET_FAILED:${getRes.status}`);
  }
  
  const fileData = await getRes.json();
  
  // 2. Supprimer le fichier
  const delBody = {
    message: `chore: cleanup temp file ${path}`,
    sha: fileData.sha,
    branch: GH_BRANCH
  };
  
  const delRes = await fetch(getUrl, { 
    method: "DELETE", 
    headers, 
    body: JSON.stringify(delBody) 
  });
  
  if (!delRes.ok) {
    throw new Error(`DELETE_FAILED:${delRes.status}`);
  }
  
  return { ok: true, deleted: path };
}

exports.handler = async (event) => {
  try {
    // Auth optionnelle pour le nettoyage (peut être appelé en keepalive)
    const auth = requireAuth(event);
    if (auth.statusCode && auth.statusCode !== 401) return auth;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const body = JSON.parse(event.body || '{}');
    const tempPath = String(body.tempPath || '').trim();

    if (!tempPath) {
      return bad(400, "MISSING_TEMP_PATH");
    }

    // Sécurité: vérifier que c'est bien un fichier temp
    if (!tempPath.startsWith('assets/temp/')) {
      return bad(400, "INVALID_TEMP_PATH");
    }

    const result = await ghDeleteFile(tempPath);

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify(result)
    };

  } catch (error) {
    return bad(500, "CLEANUP_FAILED", { message: error.message });
  }
};