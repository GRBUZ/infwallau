// upload-addon.js — Simple UI helper to upload a profile image using CoreManager + UploadManager
// - Select file from #avatar
// - Upload via UploadManager.uploadGeneric
// - Show uploaded URL into #uploadedUrl
// - Optional: copy button #copyUrl
// - Optional: preview <img id="avatarPreview">
// - Optional: auto-link to a region if data-region-id is present on #avatar or #uploadedUrl
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[upload-addon] CoreManager required. Load js/core-manager.js first.');
    return;
  }
  if (!window.UploadManager) {
    console.error('[upload-addon] UploadManager required. Load js/upload-manager.js first.');
    return;
  }

  const input   = document.getElementById('avatar');
  const out     = document.getElementById('uploadedUrl');
  const copyBtn = document.getElementById('copyUrl');
  const preview = document.getElementById('avatarPreview'); // optional <img> for preview

  // Not a hard error if absent; just no-op
  if (!input || !out) return;

  function setStatus(msg){
    try { out.value = msg; } catch {}
  }

  function setUploaded(url, path, fileName){
    if (out) {
      out.value = url || path || '';
      if (path) out.dataset.path = path;
      if (fileName) out.dataset.filename = fileName;
    }
    if (preview && url) {
      try {
        preview.src = url;
        preview.classList.remove('hidden');
      } catch {}
    }
  }

  function getRegionId(){
    // If you want to auto-link the image to a region after upload,
    // add data-region-id="r_..." on #avatar or #uploadedUrl
    const fromOut  = (out && out.dataset && out.dataset.regionId) || '';
    const fromIn   = (input && input.dataset && input.dataset.regionId) || '';
    return (fromOut || fromIn || '').trim();
  }

  async function maybeLinkToRegion(regionId, imageUrlOrPath){
    if (!regionId || !imageUrlOrPath) return;
    try {
      const r = await window.UploadManager.linkImageToRegion(regionId, imageUrlOrPath);
      if (!r || !r.ok) {
        console.warn('[upload-addon] link-image failed', r);
      }
    } catch (e) {
      console.warn('[upload-addon] link-image threw', e);
    }
  }

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    setStatus('Uploading… please wait');

    try {
      // Upload via unified manager (validates size/type and throws on failure)
      const res = await window.UploadManager.uploadGeneric(file);
      // Expecting { ok:true, imageUrl, path, ... }
      const bestUrl = res.imageUrl || res.url || '';
      setUploaded(bestUrl, res.path || '', file.name);

      const regionId = getRegionId();
      if (regionId) {
        await maybeLinkToRegion(regionId, bestUrl || res.path || '');
      }
    } catch (err) {
      console.error('[upload-addon] Upload failed:', err);
      setStatus('Upload failed: ' + (err?.message || err));
    }
  });

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!out || !out.value) return;
      const text = out.value;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          out.select();
          document.execCommand('copy');
        }
      } catch {
        // ignore
      }
    });
  }

  // Back-compat: expose linkImageToRegion globally if other code expects it
  if (!window.linkImageToRegion) {
    window.linkImageToRegion = window.UploadManager.linkImageToRegion.bind(window.UploadManager);
  }
})();