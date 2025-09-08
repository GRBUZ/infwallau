// netlify/functions/finalize.js — regions-aware finalize (patch)
// Garde la compatibilité de l’API de réponse actuelle.

const { requireAuth } = require('./auth-middleware');
const { guardFinalizeInput } = require('./_validation');
const crypto = require('crypto');

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

const N = 100;

function bad(status, error, extra = {}){
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra })
  };
}

function ok(payload = {}){
  return {
    statusCode: 200,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:true, ...payload })
  };
}

function idxToXY(idx){ return { x: idx % N, y: (idx / N) | 0 }; }

function boundsFromIndices(indices){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const i of indices){
    const p = idxToXY(i);
    if (p.x<x0) x0=p.x; if (p.x>x1) x1=p.x;
    if (p.y<y0) y0=p.y; if (p.y>y1) y1=p.y;
  }
  return { x:x0, y:y0, w:(x1-x0+1), h:(y1-y0+1) };
}

function genRegionId(uid, blocks){
  const arr = Array.from(new Set(blocks)).sort((a,b)=>a-b);
  const seed = `${uid}|${arr.join(',')}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

async function ghGetJson(path){
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`, {
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha, message = "chore: update state (pretty JSON)"){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const content = Buffer.from(pretty, "utf-8").toString("base64");
  const body = { message, content, branch: GH_BRANCH, sha };
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

function pruneLocks(locks){
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(locks || {})){
    if (v && typeof v.until === 'number' && v.until > now) out[k] = v;
  }
  return out;
}

exports.handler = async (event) => {
  try {
    // Auth obligatoire
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const authenticatedUID = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    // Validation via _validation (renvoie { name, linkUrl, blocks })
    const { name: validatedName, linkUrl: validatedLinkUrl, blocks: validatedBlocks } = await guardFinalizeInput(event);
    if (!Array.isArray(validatedBlocks) || validatedBlocks.length === 0) {
      return bad(400, "NO_BLOCKS");
    }

    // Charger l'état
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const state = state0 || { sold:{}, locks:{}, regions:{} };
    state.locks   = pruneLocks(state.locks || {});
    state.regions = state.regions || {};

    const now = Date.now();

    // 1) Vérifier que chaque bloc est encore locké par cet utilisateur et non expiré
    const regionIdsSeen = new Set();
    for (const idx of validatedBlocks){
      if (state.sold[idx]) return bad(409, "ALREADY_SOLD", { idx });
      const lk = state.locks[idx];
      if (!lk || lk.uid !== authenticatedUID || !(lk.until > now)) {
        return bad(409, "LOCK_MISSING_OR_EXPIRED", { idx });
      }
      if (lk.regionId) regionIdsSeen.add(lk.regionId);
    }

    // 2) Déterminer le regionId à utiliser (depuis les locks si présent, sinon hash stable)
    let regionId = null;
    if (regionIdsSeen.size === 1) {
      regionId = Array.from(regionIdsSeen)[0];
    } else {
      // soit absent (anciennes réservations), soit multiple → on reconstitue un ID stable
      regionId = genRegionId(authenticatedUID, validatedBlocks);
    }

    // 3) Vérifier la région + expiration côté région (si disponible)
    const rect = boundsFromIndices(validatedBlocks);
    const reg0 = state.regions[regionId];
    if (reg0 && reg0.reservedUntil && reg0.reservedUntil <= now) {
      return bad(409, "RESERVATION_EXPIRED", { regionId });
    }

    // Créer/mettre à jour la région sans écraser imageUrl si elle existe déjà
    const prevImage = (reg0 && reg0.imageUrl) || "";
    state.regions[regionId] = {
      imageUrl: prevImage,              // NE PAS ECRASER une image déjà téléversée
      rect,
      uid: authenticatedUID,
      // On peut garder reservedUntil à titre informatif, mais la vente confirme, donc plus pertinent
      // reservedUntil: undefined,
      blocks: Array.from(new Set(validatedBlocks)).sort((a,b)=>a-b)
    };

    // 4) Marquer les blocs vendus + supprimer les locks correspondants
    const ts = now;
    for (const idx of validatedBlocks){
      state.sold[idx] = { name: validatedName, linkUrl: validatedLinkUrl, ts, regionId };
      if (state.locks) delete state.locks[idx];
    }

    // 5) Commit (avec retry 409)
    try {
            // juste avant d’écrire newState
      const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
      const oldSoldCount = Object.keys(oldState.sold || {}).length;
      const newSoldCount = Object.keys(newState.sold || {}).length;
      if (newSoldCount < oldSoldCount) {
        // on n’écrit pas → quelque chose aurait écrasé l’historique
        return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
      }

      await ghPutJson(STATE_PATH, state, sha, `finalize ${validatedBlocks.length} -> ${regionId}`);
    } catch (error) {
      if (String(error.message || error).includes('409')) {
        const { json: freshState, sha: freshSha } = await ghGetJson(STATE_PATH);
        const merged = freshState || { sold:{}, locks:{}, regions:{} };
        merged.locks   = pruneLocks(merged.locks || {});
        merged.regions = merged.regions || {};

        // Re-valider côté merged avant d’appliquer (toujours même règles)
        for (const idx of validatedBlocks){
          if (merged.sold[idx]) return bad(409, "ALREADY_SOLD", { idx });
          const lk = merged.locks[idx];
          if (!lk || lk.uid !== authenticatedUID || !(lk.until > Date.now())) {
            return bad(409, "LOCK_MISSING_OR_EXPIRED", { idx });
          }
        }

        // Préserver imageUrl s’il existe
        const existingImg = (merged.regions[regionId] && merged.regions[regionId].imageUrl) || (state.regions[regionId] && state.regions[regionId].imageUrl) || "";
        merged.regions[regionId] = {
          imageUrl: existingImg,
          rect,
          uid: authenticatedUID,
          blocks: Array.from(new Set(validatedBlocks)).sort((a,b)=>a-b)
        };

        // Appliquer sold + purge locks
        const ts2 = Date.now();
        for (const idx of validatedBlocks){
          merged.sold[idx] = { name: validatedName, linkUrl: validatedLinkUrl, ts: ts2, regionId };
          if (merged.locks) delete merged.locks[idx];
        }
        // juste avant d’écrire newState
        const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
        const oldSoldCount = Object.keys(oldState.sold || {}).length;
        const newSoldCount = Object.keys(newState.sold || {}).length;
        if (newSoldCount < oldSoldCount) {
          // on n’écrit pas → quelque chose aurait écrasé l’historique
          return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
        }

        await ghPutJson(STATE_PATH, merged, freshSha, `finalize(retry) ${validatedBlocks.length} -> ${regionId}`);
      } else {
        throw error;
      }
    }

    return ok({ regionId, rect, soldCount: validatedBlocks.length });

  } catch (err) {
    if (err && err.statusCode) return err; // erreurs formatées (ex: guardFinalizeInput)
    return bad(500, "FINALIZE_FAILED", { message: String(err && err.message || err) });
  }
};