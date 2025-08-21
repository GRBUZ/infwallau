// netlify/functions/status.mjs — returns sold, locks, regions
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error){
  return new Response(JSON.stringify({ ok:false, error }), {
    status, headers: { "content-type":"application/json", "cache-control":"no-store" }
  });
}

export default async () => {
  try {
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`, {
      headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" }
    });
    if (r.status === 404){
      return new Response(JSON.stringify({ ok:true, sold:{}, locks:{}, regions:{} }), {
        headers: { "content-type":"application/json", "cache-control":"no-store" }
      });
    }
    if (!r.ok) return bad(r.status, "GH_GET_FAILED");
    const data = await r.json();
    const content = Buffer.from(data.content || "", "base64").toString("utf-8");
    const state = JSON.parse(content || "{}");
    const sold = state.sold || {};
    const locks = state.locks || {};
    const regions = state.regions || {};
    return new Response(JSON.stringify({ ok:true, sold, locks, regions }), {
      headers: { "content-type":"application/json", "cache-control":"no-store" }
    });
  } catch (e) {
    return bad(500, "SERVER_ERROR");
  }
};
