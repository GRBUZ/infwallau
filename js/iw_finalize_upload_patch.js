// iw_finalize_upload_patch.js — Finalize flow patched to use CoreManager + UploadManager (+ LockManager)
// Responsibilities:
// - Re-reserve selection just before finalize
// - Call /finalize
// - Upload image for the returned regionId
// - Keep UI state in sync (sold/locks/regions), unlock on escape/blur
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

  const { uid, apiCall } = window.CoreManager;

  // DOM handles (we tolerate multiple possible IDs to be resilient)
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');

  // Local helpers
  function normalizeUrl(u){
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      url.hash = ''; // drop fragment
      return url.toString();
    } catch {
      return '';
    }
  }

  function getSelectedIndices(){
    // 1) If app.js exposed a helper
    if (typeof window.getSelectedIndices === 'function') {
      try { const arr = window.getSelectedIndices(); if (Array.isArray(arr)) return arr; } catch {}
    }
    // 2) If a global Set "selected" exists
    if (window.selected && window.selected instanceof Set) {
      return Array.from(window.selected);
    }
    // 3) Infer from DOM
    const out = [];
    document.querySelectorAll('.cell.sel').forEach(el=>{
      const idx = parseInt(el.dataset.idx, 10);
      if (Number.isInteger(idx)) out.push(idx);
    });
    return out;
  }

  async function refreshStatus(){
    try {
      const d = await apiCall('/status?ts=' + Date.now());
      if (!d || !d.ok) return;
      window.sold = d.sold || {};
      if (window.LockManager) {
        const merged = window.LockManager.merge(d.locks || {});
        window.locks = merged;
      } else {
        window.locks = d.locks || {};
      }
      window.regions = d.regions || {};
      if (typeof window.renderRegions === 'function') window.renderRegions();
    } catch (e) {
      console.warn('[IW patch] refreshStatus failed', e);
    }
  }

  // Unlock helpers
  async function unlockSelection(){
    try{
      const blocks = getSelectedIndices();
      if (!blocks.length) return;
      if (window.LockManager) {
        await window.LockManager.unlock(blocks);
      } else {
        await apiCall('/unlock', { method:'POST', body: JSON.stringify({ blocks }) });
      }
    }catch(_){}
  }

  async function unlockKeepalive(){
    try{
      const blocks = getSelectedIndices();
      if (!blocks.length) return;
      if (window.LockManager) {
        await window.LockManager.unlock(blocks);
      } else {
        await apiCall('/unlock', {
          method:'POST',
          body: JSON.stringify({ blocks }),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true
        });
      }
    }catch(_){}
  }

  // Global listeners to avoid "lost locks"
  document.addEventListener('keydown', e => { if (e.key === 'Escape') unlockSelection(); }, { passive:true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') unlockKeepalive();
  });

  // Finalize flow
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ alert('Please select at least one block.'); return; }
    if (!name || !linkUrl){ alert('Name and Profile URL are required.'); return; }

    if (confirmBtn) confirmBtn.disabled = true;

    // Re-reserve just before finalize (defensive)
    try {
      if (window.LockManager) {
        const jr = await window.LockManager.lock(blocks, 180000);
        if (!jr || !jr.ok) {
          await refreshStatus();
          alert((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          if (confirmBtn) confirmBtn.disabled = false;
          return;
        }
      } else {
        const jr = await apiCall('/reserve', { method:'POST', body: JSON.stringify({ blocks, ttl: 180000 }) });
        if (!jr || !jr.ok) {
          await refreshStatus();
          alert((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          if (confirmBtn) confirmBtn.disabled = false;
          return;
        }
      }
    } catch {
      // Non fatal; server will re-check on finalize
    }

    // Finalize
    const out = await apiCall('/finalize', {
      method:'POST',
      body: JSON.stringify({ name, linkUrl, blocks })
    });

    if (!out || !out.ok) {
      alert((out && out.error) || 'Finalize failed');
      if (confirmBtn) confirmBtn.disabled = false;
      return;
    }

    // Upload (optional) with UploadManager
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        if (!out.regionId) {
          console.warn('[IW patch] finalize returned no regionId, skipping upload');
        } else {
          const uploadResult = await window.UploadManager.uploadForRegion(file, out.regionId);
          console.log('[IW patch] image linked:', uploadResult?.imageUrl || '(no url returned)');
        }
      }
    } catch (e) {
      console.error('[IW patch] upload failed:', e);
    }

    // After finalize: refresh + unlock selection
    try { 
      await unlockSelection(); 
    } catch {}

    await refreshStatus();

    // Close modal if exists
    try {
      if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
      }
    } catch {}

    if (confirmBtn) confirmBtn.disabled = false;
  }

  // Wire up UI
  if (confirmBtn) confirmBtn.addEventListener('click', (e)=>{ e.preventDefault(); doConfirm(); });
  if (form) form.addEventListener('submit', (e)=>{ e.preventDefault(); doConfirm(); });

  // Expose for debugging if needed
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();