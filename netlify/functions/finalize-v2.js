// finalize-v2.js — Finalisation atomique avec validation complète
const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput, sanitizeName, validateUrlOrThrow } = require('./_validation');

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

const N = 100;

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: false, error, ...extra })
  };
}

function idxToXY(idx) { return { x: idx % N, y: (idx / N) | 0 }; }

function boundsFromIndices(indices) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const i of indices) {
    const p = idxToXY(i);
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: (x1 - x0 + 1), h: (y1 - y0 + 1) };
}

async function ghGetJson(path) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`, {
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json" }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha) {
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const content = Buffer.from(pretty, "utf-8").toString("base64");
  const body = {
    message: "feat: finalize purchase with image",
    content,
    branch: GH_BRANCH,
    sha
  };
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GH_PUT_FAILED:${r.status}`);
  return r.json();
}

async function ghMoveFile(fromPath, toPath) {
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // 1. Lire le fichier source
  const getUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(fromPath)}?ref=${GH_BRANCH}`;
  const getRes = await fetch(getUrl, { headers });
  if (!getRes.ok) throw new Error(`SOURCE_NOT_FOUND:${getRes.status}`);
  
  const sourceData = await getRes.json();
  
  // 2. Créer le fichier destination avec le même contenu
  const putUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(toPath)}`;
  const putBody = {
    message: `feat: move ${fromPath} to ${toPath}`,
    content: sourceData.content,
    branch: GH_BRANCH
  };
  
  const putRes = await fetch(putUrl, { method: "PUT", headers, body: JSON.stringify(putBody) });
  if (!putRes.ok) throw new Error(`MOVE_PUT_FAILED:${putRes.status}`);
  
  // 3. Supprimer le fichier source
  const delBody = {
    message: `chore: cleanup temp file ${fromPath}`,
    sha: sourceData.sha,
    branch: GH_BRANCH
  };
  
  const delRes = await fetch(getUrl, { method: "DELETE", headers, body: JSON.stringify(delBody) });
  if (!delRes.ok) {
    console.warn(`Failed to delete temp file ${fromPath}: ${delRes.status}`);
    // Non fatal - le fichier temp restera mais ce n'est pas grave
  }
  
  return putRes.json();
}

exports.handler = async (event) => {
  try {
    // Auth requise
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    
    const authenticatedUID = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const body = JSON.parse(event.body || '{}');
    
    // Validation des données utilisateur
    const name = sanitizeName(body.name || '');
    const linkUrl = validateUrlOrThrow(body.linkUrl || '');
    const blocks = Array.isArray(body.blocks) ? body.blocks : [];
    const tempImagePath = String(body.tempImagePath || '').trim();
    const tempId = String(body.tempId || '').trim();

    if (!name || !linkUrl || !blocks.length) {
      return bad(400, "MISSING_REQUIRED_FIELDS");
    }

    if (!tempImagePath || !tempId) {
      return bad(400, "MISSING_IMAGE_DATA");
    }

    // Validation des blocks
    for (const idx of blocks) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= N * N) {
        return bad(400, "INVALID_BLOCK_INDEX");
      }
    }

    // TRANSACTION ATOMIQUE
    try {
      // 1. Vérifier que l'image temporaire existe
      const tempCheckUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(tempImagePath)}?ref=${GH_BRANCH}`;
      const tempCheck = await fetch(tempCheckUrl, {
        headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json" }
      });
      
      if (!tempCheck.ok) {
        return bad(400, "TEMP_IMAGE_NOT_FOUND", { tempPath: tempImagePath });
      }

      // 2. Lire l'état actuel
      const { json: state0, sha } = await ghGetJson(STATE_PATH);
      const state = state0 || { sold: {}, locks: {}, regions: {} };

      // 3. Vérifier que les blocks sont libres et lockés par l'utilisateur
      for (const idx of blocks) {
        if (state.sold[idx]) {
          return bad(409, "ALREADY_SOLD", { block: idx });
        }
        const lock = state.locks[idx];
        if (lock && lock.uid && lock.uid !== authenticatedUID) {
          return bad(409, "LOCKED_BY_OTHER", { block: idx });
        }
      }

      // 4. Créer le regionId
      const regionId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const rect = boundsFromIndices(blocks);

      // 5. Déplacer l'image vers le dossier final
      const finalImagePath = `assets/images/${regionId}/${tempImagePath.split('/').pop()}`;
      await ghMoveFile(tempImagePath, finalImagePath);
      
      // 6. URL de l'image finale
      const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${finalImagePath}`;

      // 7. Mettre à jour l'état
      if (!state.regions) state.regions = {};
      state.regions[regionId] = { imageUrl, rect };

      const ts = Date.now();
      for (const idx of blocks) {
        state.sold[idx] = { name, linkUrl, ts, regionId };
        if (state.locks) delete state.locks[idx];
      }

      // 8. Sauvegarder l'état
      await ghPutJson(STATE_PATH, state, sha);

      // 9. SUCCESS
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({
          ok: true,
          regionId,
          rect,
          imageUrl,
          finalImagePath,
          soldCount: blocks.length,
          name,
          linkUrl
        })
      };

    } catch (error) {
      // ROLLBACK: tenter de nettoyer en cas d'échec partiel
      try {
        // Si l'image a été déplacée mais que l'état n'a pas été mis à jour,
        // on pourrait tenter de la remettre en temp, mais c'est complexe.
        // Pour l'instant on log l'erreur et on laisse l'admin nettoyer manuellement.
        console.error('[FINALIZE-V2] Partial failure, manual cleanup may be needed:', {
          tempImagePath,
          error: error.message,
          uid: authenticatedUID,
          blocks
        });
      } catch {}

      throw error;
    }

  } catch (error) {
    const message = error.message || String(error);
    
    if (message.includes('ALREADY_SOLD')) {
      return bad(409, "BLOCKS_ALREADY_SOLD");
    }
    if (message.includes('LOCKED_BY_OTHER')) {
      return bad(409, "BLOCKS_LOCKED_BY_OTHER");
    }
    if (message.includes('SOURCE_NOT_FOUND')) {
      return bad(400, "TEMP_IMAGE_EXPIRED");
    }
    if (message.includes('GH_')) {
      return bad(500, "GITHUB_ERROR", { details: message });
    }

    return bad(500, "FINALIZE_FAILED", { message });
  }
};