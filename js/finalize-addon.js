// finalize-addon.js — Finalize flow using CoreManager + UploadManager (+ LockManager) with robust error handling
// Responsibilities:
// - Call /start-order (server = source of truth: validations + image upload + order JSON + server price)
// - Render PayPal button; onApprove => webhook -> finalize via RPC; front polls /order-status until completed
// - Keep UI state in sync (sold/locks/regions), unlock on escape/cancel/error
// - Renew locks at key steps (Confirm + PayPal)

(function(){
  'use strict';

  // --- Internal state
  let __watch = null; // PayPal expiration watcher (for header state)

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

  const { uid, apiCall } = window.CoreManager;

  function haveMyValidLocks(blocks, graceMs = 2000){
    if (!Array.isArray(blocks) || !blocks.length) return false;
    const now = Date.now() + Math.max(0, graceMs|0);
    const myUid = uid;
    // front-side source of truth
    let map = {};
    try {
      map = window.LockManager?.getLocalLocks?.() || window.locks || {};
    } catch (_) {
      map = window.locks || {};
    }
    for (const i of blocks) {
      const l = map[String(i)];
      if (!l || l.uid !== myUid || !(Number(l.until) > now)) return false;
    }
    return true;
  }

  // DOM handles (be resilient to multiple possible IDs)
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
  if (fileInput && !fileInput.getAttribute('accept')) {
    fileInput.setAttribute('accept', 'image/*');
  }

  // Heartbeat pause/resume to avoid /reserve while processing
  let __processing = false;
  function pauseHB(){
    if (__processing) return;
    __processing = true;
    try { window.LockManager?.heartbeat?.stop?.(); } catch {}
  }
  
  function resumeHB(){
    if (!__processing) return;
    __processing = false;
    try {
      const sel = (typeof getSelectedIndices === 'function') ? getSelectedIndices() : [];
      // do NOT restart if my locks are not valid yet
      if (modal && !modal.classList.contains('hidden') && sel && sel.length && haveMyValidLocks(sel, 0)) {
        window.LockManager?.heartbeat?.start?.(sel, 30000, 180000, {
          maxMs: 180000,        // 3 minutes
          autoUnlock: true,
          requireActivity: true
        });
      } else {
        window.LockManager?.heartbeat?.stop?.();
      }
    } catch {
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
    }
  }

  // UI helpers (only for pre-PayPal validation / developer feedback)
  function uiWarn(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.warn || 'warn', 4000);
    } else {
      alert(msg);
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

  // small helpers
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
    if (typeof window.getSelectedIndices === 'function') {
      try { const arr = window.getSelectedIndices(); if (Array.isArray(arr)) return arr; } catch {}
    }
    if (window.selected && window.selected instanceof Set) {
      return Array.from(window.selected);
    }
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') unlockSelection();
  }, { passive:true });

  // ---- PayPal helpers (front)
  async function waitForCompleted(orderId, tries=30) {
    for (let i=0;i<tries;i++){
      const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
      if (st?.ok && String(st.status).toLowerCase() === 'completed') return true;
      if (st?.ok && String(st.status).toLowerCase() === 'failed') return false;
      await new Promise(rs=>setTimeout(rs, 2000));
    }
    return false;
  }

  // --- PayPal container helpers (single header system)
  function removePaypalContainer(){
    const c = document.getElementById('paypal-button-container');
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }
  function setPayPalHeaderState(state){
    const el = document.getElementById('paypal-button-container');
    if (!el) return;
    // states we use in CSS: 'active' | 'expired' | 'processing' | 'cancelled' | 'error' | 'completed' | 'pending'
    el.className = String(state || '').trim();
  }

  // --- Reset / cleanup FINALIZE
  function resetFinalizeState(){
    // 1) timers/watchers
    if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }

    // 2) PayPal container + header classes
    const container = document.getElementById('paypal-button-container');
    if (container) {
      container.style.pointerEvents = '';
      container.style.opacity = '';
      container.setAttribute('aria-disabled', 'false');
      if (container.parentNode) container.parentNode.removeChild(container);
    }

    // 3) confirm button
    if (confirmBtn) {
      if (confirmBtn.dataset._origText) {
        confirmBtn.textContent = confirmBtn.dataset._origText;
        delete confirmBtn.dataset._origText;
      }
      confirmBtn.style.display = '';
      confirmBtn.disabled = false;
    }

    // 4) dataset.regionId (do not touch file.value here — app.js resets it already)
    const fi = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
    if (fi && fi.dataset.regionId) delete fi.dataset.regionId;
  }

  // Events emitted by app.js in openModal()/closeModal()
  document.addEventListener('modal:opening', resetFinalizeState);
  document.addEventListener('modal:closing', resetFinalizeState);

  function showPaypalButton(orderId, currency){
    // hide confirm and mount PayPal container
    if (confirmBtn) confirmBtn.style.display = 'none';
    removePaypalContainer();

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Payment: missing PayPal configuration (PAYPAL_CLIENT_ID / PayPalIntegration).');
      return;
    }

    function haveMyValidLocksLocal(indices, graceMs = 5000) {
      if (!window.LockManager) return true;
      const locks = window.LockManager.getLocalLocks?.() || {};
      const t = Date.now() + graceMs;
      for (const i of indices || []) {
        const l = locks[String(i)];
        if (!l || l.uid !== uid || !(l.until > t)) return false;
      }
      return true;
    }

    function setupPayPalExpiryHeader() {
      const blocks = getSelectedIndices();
      if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }
      
      function tick() {
        if (modal && modal.classList.contains('hidden')) {
          if (__watch) { try { clearInterval(__watch); } catch {} }
          __watch = null;
          return;
        }
        
        const ok = haveMyValidLocksLocal(blocks);
        const container = document.getElementById('paypal-button-container');
        if (container) {
          container.style.pointerEvents = ok ? 'auto' : 'none';
          container.style.opacity = ok ? '' : '0.6';
          setPayPalHeaderState(ok ? 'active' : 'expired');
        }

        if (!ok && __watch) {
          clearInterval(__watch);
          __watch = null;
        }
      }
      
      __watch = setInterval(tick, 10000);
      tick();
    }

    setupPayPalExpiryHeader();

    window.PayPalIntegration.initAndRender({
      orderId,
      currency: currency || 'USD',

      onApproved: async (data, actions) => {
        // do NOT stop heartbeat here — needed to validate locks
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;

        try {
          btnBusy(true);
          setPayPalHeaderState('processing');

          // Final guard: verify locks BEFORE stopping heartbeat
          if (window.LockManager) {
            const me = window.CoreManager?.uid;
            const t = Date.now() + 1000;
            const loc = window.LockManager.getLocalLocks();
            const blocks = getSelectedIndices();
            const stillOk = blocks.length && blocks.every(i => {
              const l = loc[String(i)];
              return l && l.uid === me && l.until > t;
            });
            if (!stillOk) {
              setPayPalHeaderState('expired');
              try { await unlockSelection(); } catch {}
              btnBusy(false);
              return;
            }
          }
          console.log('UID before capture', window.CoreManager.uid);
          // 1) capture on server
          const res = await window.CoreManager.apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify({ orderId, paypalOrderId: data.orderID })
          });

          // PayPal "INSTRUMENT_DECLINED" → restart flow without breaking locks
          if (!res?.ok) {
            const name   = res?.details?.name || '';
            const issues = Array.isArray(res?.details?.details) ? res.details.details.map(d => d.issue) : [];
            const isInstrDeclined = res?.error === 'INSTRUMENT_DECLINED'
                                 || (name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED'));

            if (isInstrDeclined) {
              setPayPalHeaderState('error'); // bank declined
              if (actions && typeof actions.restart === 'function') {
                btnBusy(false);
                await actions.restart();
                return;
              }
              btnBusy(false);
              uiWarn('Payment was declined. Please try again.');
              return;
            }

            throw new Error(res?.error || res?.message || 'FINALIZE_INIT_FAILED');
          }

          // 2) wait for webhook finalize
          const ok = await waitForCompleted(orderId, 60);
          if (!ok) {
            setPayPalHeaderState('pending'); // recorded but waiting for finalize
            btnBusy(false);
            return;
          }

          // 3) success — NOW we can stop heartbeat and unlock
          setPayPalHeaderState('completed');
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          await refreshStatus();
          try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}

        } catch (e) {
          uiError(e, 'PayPal');
          setPayPalHeaderState('error');
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
        } finally {
          btnBusy(false);
        }
      },

      onCancel: async () => {
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}

        setPayPalHeaderState('cancelled');
        try { await unlockKeepalive(); } catch {}

        btnBusy(false);
        // no resumeHB() — we intentionally release and stop HB here
      },

      onError: async (err) => {
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;
        uiError(err, 'PayPal');

        setPayPalHeaderState('error');
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        try { await unlockKeepalive(); } catch {}

        btnBusy(false);
        // no resumeHB()
      }
    });
  }

  // Finalize flow
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // File pre-validation BEFORE finalize
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        await window.UploadManager.validateFile(file);
      } else {
        uiWarn('Please select an image (PNG, JPG, GIF, WebP).');
        return;
      }
    } catch (preErr) {
      uiError(preErr, 'Upload');
      uiWarn('Please select a valid image (PNG, JPG, GIF, WebP).');
      return;
    }

    pauseHB();
    btnBusy(true);

    // Key step 1: renew locks on Confirm (+3 minutes)
    if (!haveMyValidLocks(blocks, 1000)) {
      await refreshStatus().catch(()=>{});
      uiWarn('Your reservation expired. Please reselect your pixels.');
      btnBusy(false);
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      return;
    }

    // Explicit renewal for +3 minutes
    try {
      if (window.LockManager) {
        console.log('[Finalize] Renewing locks for confirm step');
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
      }
    } catch (e) {
      console.warn('[Finalize] Lock renewal failed:', e);
    }

    // === START-ORDER: server prepares order and uploads the image ===
    let start = null;
    try {
      const file = fileInput.files[0];
      const contentType = await window.UploadManager.validateFile(file);
      const { base64Data } = await window.UploadManager.toBase64(file);

      console.log('UID before start-order', window.CoreManager.uid);
      start = await apiCall('/start-order', {
        method: 'POST',
        body: JSON.stringify({
          name, linkUrl, blocks,
          filename: file.name,
          contentType,
          contentBase64: base64Data
        })
      });
    } catch (e) {
      uiError(e, 'Start order');
      btnBusy(false);
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }
    if (!start || !start.ok) {
      const message = (start && (start.error || start.message)) || 'Start order failed';
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
      btnBusy(false);
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }

    // orderId + regionId
    const { orderId, regionId, currency } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    // Extend +3min BEFORE PayPal
    if (window.LockManager) {
      try {
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
        console.log('[Finalize] Extended locks before PayPal phase');
      } catch (e) {
        console.warn('[Finalize] Lock extension before PayPal failed:', e);
      }
    }

    // Render PayPal (header-only messaging via classes)
    showPaypalButton(orderId, currency);
    // PayPal handlers will take over (onApproved / onCancel / onError)
  }

  // Triggered ONLY by app.js (after re-lock)
  document.addEventListener('finalize:submit', (e) => {
    try { e.preventDefault && e.preventDefault(); } catch {}
    doConfirm();
  });

  // Expose helpers if needed
  window.__finalizeHelpers = { resetFinalizeState, showPaypalButton };
  // Debug exports
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();
