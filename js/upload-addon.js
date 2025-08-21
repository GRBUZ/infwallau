// upload-addon.js — handles profile photo upload to assets/images via Netlify Function (JWT-secured via apiCall)
/* Global assumptions:
   - window.apiCall(endpoint, options) exists (from app.js) and attaches Authorization automatically.
   - On 401, apiCall clears auth via clearAuth(). If apiCall is missing, we fall back with a secure fetch.
*/
(function(){
  const input = document.getElementById('avatar');
  const out   = document.getElementById('uploadedUrl');
  const btn   = document.getElementById('copyUrl');

  if (!input || !out) return;

  // Align token storage with app.js
  function getAuthToken(){
    try { return localStorage.getItem('authToken'); } catch { return null; }
  }

  // Unified JSON caller: prefers app.js apiCall, else secure fetch with Authorization
  async function callJson(endpoint, options = {}){
    if (typeof window.apiCall === 'function') {
      return window.apiCall(endpoint, options);
    }
    const token = getAuthToken();
    const config = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...(options.headers || {})
      }
    };
    try{
      const res = await fetch('/.netlify/functions' + endpoint, config);
      const json = await res.json().catch(()=>null);
      if (res.status === 401 && typeof window.clearAuth === 'function') {
        window.clearAuth();
        return null;
      }
      return json;
    }catch(e){
      console.error('[upload-addon] API error:', e);
      return null;
    }
  }

  function toBase64(file){
    return new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Read failed'));
      fr.onload  = () => resolve(fr.result);
      fr.readAsDataURL(file);
    });
  }

  input.addEventListener('change', async ()=>{
    const file = input.files && input.files[0];
    if (!file) return;
    out.value = 'Uploading… please wait';
    try{
      if (file.size > 1.5 * 1024 * 1024) {
        throw new Error('File too large. Please keep under ~1.5 MB.');
      }
      const dataUrl = await toBase64(file); // "data:image/png;base64,xxxx"
      const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
      if (!m) throw new Error('Unsupported image format.');
      const contentType = m[1];
      const b64 = m[2];

      // SECURED: use apiCall (or secure fallback) instead of direct fetch
      const res = await callJson('/upload', {
        method:'POST',
        body: JSON.stringify({ filename: file.name, contentType, data: b64 })
      });

      if (!res || !res.ok) {
        const msg = (res && (res.message || res.error)) || 'Unknown error';
        throw new Error(msg);
      }

      // Populate output fields
      out.value = res.url || '';
      out.dataset.path = res.path || '';
      // Optionally expose filename for later linking convenience
      out.dataset.filename = file.name;
    }catch(err){
      console.error('[upload-addon] Upload failed:', err);
      out.value = 'Upload failed: ' + (err?.message || err);
    }
  });

  if (btn && out){
    btn.addEventListener('click', ()=>{
      if (!out.value) return;
      out.select();
      try { document.execCommand('copy'); } catch {}
    });
  }

  // Optional helper to link an image to a region after finalize (secured)
  // Call like: window.linkImageToRegion(regionId, out.dataset.path || out.value)
  window.linkImageToRegion = async function(regionId, imageUrlOrPath){
    if (!regionId || !imageUrlOrPath) {
      console.warn('[upload-addon] linkImageToRegion: missing regionId or imageUrl');
      return null;
    }
    const resp = await callJson('/link-image', {
      method: 'POST',
      body: JSON.stringify({ regionId, imageUrl: imageUrlOrPath })
    });
    if (!resp || !resp.ok) {
      console.warn('[upload-addon] link-image failed:', resp);
    } else {
      console.log('[upload-addon] image linked', resp.imageUrl || imageUrlOrPath);
    }
    // Optional: refresh UI immediately if available
    if (typeof window.refreshStatus === 'function') {
      try { await window.refreshStatus(); } catch {}
    }
    return resp;
  };
})();