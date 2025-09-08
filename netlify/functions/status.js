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
  const baseHeaders = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "netlify-fn"
  };

  // 1) Récupérer le "contents" (donne size/encoding/content)
  const metaRes = await fetch(baseUrl, { headers: baseHeaders });
  if (metaRes.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!metaRes.ok) throw new Error(`GH_GET_FAILED:${metaRes.status}`);

  const meta = await metaRes.json();

  // 2) Si content base64 raisonnable, décodons directement
  if (typeof meta.content === 'string' && meta.encoding === 'base64' && Number(meta.size || 0) < 900000) {
    const buf = Buffer.from(meta.content, 'base64');
    return parseState(buf.toString('utf-8') || "{}");
  }

  // 3) Sinon, redemander en RAW (via l’API, pas le CDN)
  const rawHeaders = {
    ...baseHeaders,
    "Accept": "application/vnd.github.raw"
  };
  const rawRes = await fetch(baseUrl, { headers: rawHeaders });
  if (rawRes.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!rawRes.ok) throw new Error(`GH_GET_RAW_FAILED:${rawRes.status}`);

  const txt = await rawRes.text();
  return parseState(txt || "{}");
}

exports.handler = async (event) => {
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
};