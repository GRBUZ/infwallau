// netlify/functions/status.js — returns sold, locks, regions (avec parseState identique au backend)
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error){
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: false, error })
  };
}

function ok(body){
  return {
    statusCode: 200,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: true, ...body })
  };
}

function pruneLocks(locks) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(locks || {})) {
    if (v && typeof v.until === 'number' && v.until > now) {
      out[k] = v;
    }
  }
  return out;
}

// === parseState calqué sur ton backend (reserve.js) ===
function parseState(raw) {
  if (!raw) return { sold:{}, locks:{}, regions:{} };
  try {
    const obj = JSON.parse(raw);

    // Back-compat: si ancien format { artCells: {...} } et pas de "sold"
    if (obj.artCells && !obj.sold) {
      const sold = {};
      for (const [k, v] of Object.entries(obj.artCells)) {
        sold[k] = {
          name:    v.name    || v.n  || '',
          linkUrl: v.linkUrl || v.u  || '',
          ts:      v.ts      || Date.now(),
          // si ton ancien format véhiculait d'autres champs:
          // regionId/imageUrl (optionnels, on les prend si présents)
          ...(v.regionId ? { regionId: v.regionId } : {}),
          ...(v.imageUrl ? { imageUrl: v.imageUrl } : {})
        };
      }
      return {
        sold,
        locks:   obj.locks   || {},
        regions: obj.regions || {}
      };
    }

    // Format déjà nouveau
    if (!obj.sold)    obj.sold    = {};
    if (!obj.locks)   obj.locks   = {};
    if (!obj.regions) obj.regions = {};
    return obj;
  } catch {
    return { sold:{}, locks:{}, regions:{} };
  }
}

async function ghGetStateJson() {
  const baseUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`;
  
  try {
    console.log('[STATUS] Fetching state.json...');
    
    // Essayer d'abord l'URL RAW directe (plus fiable pour gros fichiers)
    const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${STATE_PATH}`;
    const rawRes = await fetch(rawUrl, { 
      headers: { 'User-Agent': 'netlify-fn' },
      timeout: 30000 // 30s timeout
    });
    
    if (rawRes.ok) {
      const txt = await rawRes.text();
      const fileSize = txt.length;
      console.log(`[STATUS] Loaded via RAW: ${fileSize} chars`);
      
      if (fileSize > 500000) {
        console.warn(`[STATUS] Large file detected: ${Math.round(fileSize/1024)}KB`);
      }
      
      return parseState(txt || "{}");
    }
    
    if (rawRes.status === 404) {
      console.log('[STATUS] state.json not found, returning empty state');
      return { sold:{}, locks:{}, regions:{} };
    }

    // Fallback vers API si RAW échoue
    console.log('[STATUS] RAW failed, trying API method');
    const apiHeaders = {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "netlify-fn"
    };
    
    const apiRes = await fetch(baseUrl, { headers: apiHeaders });
    if (apiRes.ok) {
      const data = await apiRes.json();
      const fileSize = Number(data.size || 0);
      
      if (fileSize > 800000) {
        // Fichier trop gros pour l'API, essayer avec Accept: raw
        console.log(`[STATUS] File too large (${Math.round(fileSize/1024)}KB), using raw accept`);
        const rawAcceptRes = await fetch(baseUrl, {
          headers: { ...apiHeaders, "Accept": "application/vnd.github.raw" }
        });
        if (rawAcceptRes.ok) {
          const txt = await rawAcceptRes.text();
          return parseState(txt || "{}");
        }
      } else if (data.content && data.encoding === 'base64') {
        // Fichier normal
        const buf = Buffer.from(data.content, 'base64');
        return parseState(buf.toString('utf8') || "{}");
      }
    }

    throw new Error(`All methods failed: RAW=${rawRes.status}, API=${apiRes.status}`);

  } catch (e) {
    console.error('[STATUS] All loading methods failed:', e);
    
    // Ne pas planter le serveur, retourner un état vide
    // mais logger l'erreur pour investigation
    return { sold:{}, locks:{}, regions:{} };
  }
}

/*exports.handler = async (event) => {
  try {
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const state = await ghGetStateJson();

    const sold    = state.sold    || {};
    const locks   = pruneLocks(state.locks || {});
    const regions = state.regions || {};

    return ok({ sold, locks, regions });
  } catch (e) {
    return bad(500, "SERVER_ERROR");
  }
};*/
exports.handler = async (event) => {
  try {
    if (!GH_REPO || !GH_TOKEN) {
      console.error('[STATUS] Missing GitHub config');
      return bad(500, "GITHUB_CONFIG_MISSING");
    }

    console.log('[STATUS] Loading state...');
    const state = await ghGetStateJson();
    
    const sold = state.sold || {};
    const locks = pruneLocks(state.locks || {});
    const regions = state.regions || {};
    
    // Log pour diagnostiquer
    const soldCount = Object.keys(sold).length;
    const regionsCount = Object.keys(regions).length;
    console.log(`[STATUS] Returning: ${soldCount} sold, ${regionsCount} regions`);
    
    // Vérification de cohérence côté serveur
    if (soldCount === 0 && regionsCount > 0) {
      console.warn('[STATUS] WARNING: No sold blocks but regions exist');
    }
    
    // Assurer que sold n'est jamais undefined
    const response = {
      ok: true,
      sold: sold || {},
      locks: locks || {},
      regions: regions || {},
      meta: {
        soldCount,
        regionsCount,
        locksCount: Object.keys(locks).length,
        timestamp: new Date().toISOString()
      }
    };
    
    return {
      statusCode: 200,
      headers: { 
        "content-type": "application/json", 
        "cache-control": "no-store",
        "x-sold-count": soldCount.toString(),
        "x-regions-count": regionsCount.toString()
      },
      body: JSON.stringify(response)
    };
    
  } catch (e) {
    console.error('[STATUS] CRITICAL ERROR:', {
      error: e.message,
      stack: e.stack,
      timestamp: new Date().toISOString()
    });
    
    return bad(500, "SERVER_ERROR");
  }
};