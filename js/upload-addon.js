// finalize-addon.js — Finalize flow patched to use CoreManager + UploadManager (+ LockManager) with robust error handling
// Responsibilities:
// - Re-reserve selection just before finalize
// - Call /finalize
// - Upload image for the returned regionId (optional)
// - Keep UI state in sync (sold/locks/regions), unlock on escape/blur
// - Emit 'finalize:success' event for other modules (e.g., upload-addon.js)
(function(){
  'use strict';

  // Hard deps
  if (!window.CoreManager) {
    console.error('[IW patch] CoreManager required. Load js/core-manager.js before this file.');
    return;
  }
  if (!window.UploadManager) {
    console.error('[IW patch] UploadManager required. Load js/upload-manager.js before this file.');
    return;
  }
  // LockManager strongly recommended
  if (!window.LockManager) {
    console.warn('[IW patch] LockManager not found. Reserve/unlock/merge will be degraded.');
  }
  if (!window.Errors) {
    console.warn('[IW patch] errors.js not found; falling back to alerts/console for user feedback.');
  }

  const { apiCall } = window.CoreManager;

  // DOM handles (we tolerate multiple possible IDs to be resilient)
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');

  // UI helpers
  function uiWarn(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.warn || 'warn', 4000);
    } else {
      alert(msg);
    }
  }
  function uiInfo(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.info || 'info', 2500);
    } else {
      console.log('[Info]', msg);
    }
  }
  function uiError(err, ctx){
    if (window.Errors && window.Errors.notifyError) {
      window.Errors.notifyError(err, ctx);
    } else {
      console.error(ctx ? `[${ctx}]` : '[Error]', err);
      alert((err && err.message) || 'Something went wrong');
    }
  }
  function btnBusy(busy){
    if (!confirmBtn) return;
    try {
      if (busy) {
        confirmBtn.dataset._origText = confirmBtn.dataset._origText || confirmBtn.textContent;
        confirmBtn.textContent = 'Processing…';
        confirmBtn.disabled = true;
      } else {
        if (confirmBtn.dataset._origText) {
          confirmBtn.textContent = confirmBtn.dataset._origText;
          delete confirmBtn.dataset._origText;
        }
        confirmBtn.disabled = false;
      }
    } catch {}
  }

  // Local helpers
  function normalizeUrl(u){
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }
  function getSelectedIndices(){
    const sel = window.selected instanceof Set ? Array.from(window.selected) : [];
    return sel && sel.length ? sel : (Array.isArray(window.currentLock) ? window.currentLock.slice() : []);
  }
  function hasUploadErrorsInDom(){
    return !!document.querySelector('[data-upload-error="true"], .dz-error, .upload-error, .toast-error, .uppy-StatusBar.is-error');
  }
  function isUploadingInDom(){
    return !!document.querySelector('[data-uploading="true"], .dz-processing, .dz-uploading, .uppy-StatusBar[aria-busy="true"]');
  }
  function getHiddenImageUrl(){
    // Priorité au champ hidden si présent, fallback sur #uploadedUrl (UI)
    const hidden = document.querySelector('#imageUrl, [name="imageUrl"]');
    const out    = document.getElementById('uploadedUrl');
    const v1 = hidden && hidden.value && hidden.value.trim();
    const v2 = out && out.value && out.value.trim();
    return v1 || v2 || '';
  }

  // Finalize flow
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // ENFORCE image presence and healthy upload before finalize
    if (isUploadingInDom()) {
      uiWarn('Image upload in progress. Please wait until it completes.');
      return;
    }
    if (hasUploadErrorsInDom()) {
      uiWarn('Image upload failed. Please fix the upload errors before confirming.');
      return;
    }

    // Accept either: a previously uploaded URL (hidden) OR a file selected that at least passes local validation
    let imageUrl = getHiddenImageUrl();
    const file = fileInput && fileInput.files && fileInput.files[0];

    if (!imageUrl && !file) {
      uiWarn('Please upload an image before confirming.');
      return;
    }
    // If a file is selected, pre-validate to catch obvious errors (size/type) before finalize
    if (file) {
      try {
        await window.UploadManager.validateFile(file);
      } catch (e) {
        uiError(e, 'Upload validation');
        return;
      }
    }

    btnBusy(true);

    // Re-reserve just before finalize (defensive)
    try {
      if (window.LockManager) {
        const jr = await window.LockManager.lock(blocks, 180000);
        if (!jr || !jr.ok) {
          await (window.refreshStatus ? window.refreshStatus() : Promise.resolve());
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          return;
        }
      } else {
        const jr = await apiCall('/reserve', { method:'POST', body: JSON.stringify({ blocks, ttl: 180000 }) });
        if (!jr || !jr.ok) {
          await (window.refreshStatus ? window.refreshStatus() : Promise.resolve());
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          return;
        }
      }
    } catch (e) {
      console.warn('[IW patch] pre-finalize reserve warning:', e);
    }

    // Finalize
    let out = null;
    try {
      out = await apiCall('/finalize', {
        method:'POST',
        body: JSON.stringify({ name, linkUrl, blocks, imageUrl })
      });
    } catch (e) {
      uiError(e, 'Finalize');
      btnBusy(false);
      return;
    }

    if (!out || !out.ok) {
      const message = (out && (out.error || out.message)) || 'Finalize failed';
      const err = window.Errors ? window.Errors.create('FINALIZE_FAILED', message, { status: out?.status || 0, retriable: false, details: out }) : new Error(message);
      uiError(err, 'Finalize');
      btnBusy(false);
      return;
    }

    // Save regionId for other modules and emit event
    try {
      const regionId = out.regionId || '';
      if (fileInput && regionId) {
        fileInput.dataset.regionId = regionId;
      }
      document.dispatchEvent(new CustomEvent('finalize:success', {
        detail: { regionId, blocks, name, linkUrl }
      }));
    } catch (e) {
      console.warn('[IW patch] finalize:success dispatch failed', e);
    }

    // Optional inline upload (back-compat): if a file is selected and no pre-upload URL was provided, upload now
    try {
      const regionId = out.regionId;
      if (file && regionId && !imageUrl) {
        const uploadResult = await window.UploadManager.uploadForRegion(file, regionId);
        const url = uploadResult?.imageUrl || uploadResult?.url || '';
        if (!url) uiWarn('Purchase completed but image URL is missing after upload.');
      }
    } catch (e) {
      uiError(e, 'Upload after finalize');
      // Note: purchase is done; we surface the error and let user retry upload
    }

    // Unlock and refresh UI (best-effort)
    try {
      const blocksToUnlock = blocks.slice();
      if (window.LockManager) {
        try { await window.LockManager.unlock(blocksToUnlock); } catch {}
        window.LockManager.heartbeat && window.LockManager.heartbeat.stop && window.LockManager.heartbeat.stop();
      }
    } catch {}
    try {
      if (window.loadStatus) await window.loadStatus();
      if (window.clearSelection) window.clearSelection();
      if (window.paintAll) window.paintAll();
      if (window.closeModal) window.closeModal();
      if (window.refreshTopbar) window.refreshTopbar();
    } catch {}

    btnBusy(false);
  }

  // Wire up
  if (confirmBtn) {
    confirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      doConfirm();
    });
  }
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      doConfirm();
    });
  }

  // Escape/unlock quality-of-life
  function unlockSelection(){
    try {
      const blocks = getSelectedIndices();
      if (window.LockManager && blocks && blocks.length) window.LockManager.unlock(blocks).catch(()=>{});
    } catch {}
  }
  function unlockKeepalive(){
    try { if (window.LockManager && window.LockManager.heartbeat) window.LockManager.heartbeat.stop(); } catch {}
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') unlockSelection(); }, { passive:true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') unlockKeepalive();
  });
})();