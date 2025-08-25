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
      // Expecting { ok:true, url, path, ... }
      setUploaded(res.url || '', res.path || '', file.name);

      // Auto-link to region if requested
      const regionId = getRegionId();
      if (regionId) {
        // Prefer URL if provided, else fall back to path (link-image handles raw URL conversion server-side)
        await maybeLinkToRegion(regionId, res.url || res.path || '');
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
  // Ajoutez cette section dans upload-addon.js après les déclarations de variables

// Listen for finalize success to auto-upload
document.addEventListener('finalize:success', async (e) => {
  const { regionId } = e.detail || {};
  const file = input && input.files && input.files[0];
  
  if (!file || !regionId) {
    console.log('[upload-addon] finalize:success but no file or regionId', { file: !!file, regionId });
    return;
  }

  console.log('[upload-addon] Auto-uploading after finalize success');
  setStatus('Uploading image...');

  try {
    // Upload directly to the region
    const res = await window.UploadManager.uploadForRegion(file, regionId);
    setUploaded(res.imageUrl || res.url || '', res.path || '', file.name);
    
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast('Image uploaded successfully!', window.Errors.LEVEL?.success || 'success', 2500);
    }
    console.log('[upload-addon] Auto-upload successful:', res);
  } catch (err) {
    console.error('[upload-addon] Auto-upload failed:', err);
    setStatus('Upload failed: ' + (err?.message || err));
    
    if (window.Errors && window.Errors.notifyError) {
      window.Errors.notifyError(err, 'Auto-upload');
    }
  }
});
  // Back-compat: expose linkImageToRegion globally if other code expects it
  if (!window.linkImageToRegion) {
    window.linkImageToRegion = window.UploadManager.linkImageToRegion.bind(window.UploadManager);
  }
})();