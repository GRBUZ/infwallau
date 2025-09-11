// netlify/functions/link-image.js — Supabase version (plus de GitHub/state.json)
// POST JSON: { regionId, imageUrl } → { ok:true, regionId, imageUrl }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Compat legacy: si on nous envoie un chemin "assets/images/…", on fabrique l'URL RAW GitHub
const GH_REPO   = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function json(status, obj){
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:"link-image.supabase.v1" });
const ok  = (b)           => json(200,{ ok:true,  signature:"link-image.supabase.v1", ...b });

function toAbsoluteUrl(imageUrl){
  const u = String(imageUrl || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  // compat vieux front: "assets/images/..." -> RAW GitHub
  const p = u.replace(/^\/+/, "");
  if (p.startsWith("assets/images/") && GH_REPO) {
    return `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${p}`;
  }
  // sinon, refuse les chemins relatifs non supportés (évite d'écrire n'importe quoi en DB)
  return "";
}

function isUuid(v){
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try{
    // Auth
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    let body={}; try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "BAD_JSON"); }
    const regionId = String(body.regionId || "").trim();
    const rawUrl   = String(body.imageUrl || "").trim();
    const imageUrl = toAbsoluteUrl(rawUrl);

    if (!regionId || !isUuid(regionId)) return bad(400, "INVALID_REGION_ID");
    if (!imageUrl) return bad(400, "INVALID_IMAGE_URL");

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Vérifier que la région existe et appartient bien à l'utilisateur
    const { data: regionRows, error: regErr } = await supabase
      .from('regions')
      .select('id, uid')
      .eq('id', regionId)
      .limit(1);

    if (regErr) return bad(500, "DB_READ_FAILED", { message: regErr.message });
    const region = (regionRows && regionRows[0]) || null;
    if (!region) return bad(404, "REGION_NOT_FOUND");
    if (region.uid && region.uid !== uid) return bad(403, "FORBIDDEN");

    // 2) Mettre à jour l'image (simple, idempotent)
    const { error: updErr } = await supabase
      .from('regions')
      .update({ image_url: imageUrl })
      .eq('id', regionId);

    if (updErr) return bad(500, "DB_UPDATE_FAILED", { message: updErr.message });

    return ok({ regionId, imageUrl });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
