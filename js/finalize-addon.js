// finalize-addon.js — Finalize flow patched to use CoreManager + UploadManager (+ LockManager) with robust error handling
// Responsibilities:
// - Call /start-order (serveur = vérité: validations + upload image + order JSON + prix serveur)
// - Render PayPal button; onApprove => webhook -> finalize via RPC; front poll /order-status jusqu'à completed
// - Keep UI state in sync (sold/locks/regions), unlock on escape/cancel/error
// - Renouvellement des locks aux étapes clés (Confirm + PayPal)

(function(){
  'use strict';

  // --- État interne (simple)
  let __watch = null; // watcher PayPal (banner expirations)

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
    // source de vérité côté front
    let map = {};
    try {
      // idéal: LockManager garde un cache local
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

  // DOM handles (we tolerate multiple possible IDs to be resilient)
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
  if (fileInput && !fileInput.getAttribute('accept')) {
    fileInput.setAttribute('accept', 'image/*');
  }

  // --- pause/reprise du heartbeat pour éviter /reserve pendant le processing
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
      // on NE relance pas si mes locks ne sont pas encore valides
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

  // --- reset / cleanup FINALIZE (évite la rétention d’état entre achats)
  function removePaypalContainer(){
    const c = document.getElementById('paypal-button-container');
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }

  function ensureMsgEl(){
    let msg = document.getElementById('payment-msg');
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'payment-msg';
      const after = confirmBtn || form || modal;
      (after ? after : document.body).insertAdjacentElement('afterend', msg);
    }
    // prêt à être ré-affiché
    msg.style.display = '';
    return msg;
  }

  function resetFinalizeState(){
    // 1) timers/watchers
    if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }

    // 2) PayPal container + badges/styles
    const container = document.getElementById('paypal-button-container');
    if (container) {
      const badge = container.querySelector('.pp-disabled-badge');
      if (badge) badge.remove();
      container.style.pointerEvents = '';
      container.style.opacity = '';
      container.setAttribute('aria-disabled', 'false');
      if (container.parentNode) container.parentNode.removeChild(container);
    }

    // 3) messages
    const msg = document.getElementById('payment-msg');
    if (msg) { msg.textContent = ''; msg.style.display = ''; }

    // 4) bouton confirm
    if (confirmBtn) {
      if (confirmBtn.dataset._origText) {
        confirmBtn.textContent = confirmBtn.dataset._origText;
        delete confirmBtn.dataset._origText;
      }
      confirmBtn.style.display = '';
      confirmBtn.disabled = false;
    }

    // 5) dataset.regionId (ne touche pas au file.value ici — app.js le reset déjà)
    const fi = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
    if (fi && fi.dataset.regionId) delete fi.dataset.regionId;
  }

  // Ces events sont émis par app.js dans openModal()/closeModal()
  document.addEventListener('modal:opening', resetFinalizeState);
  document.addEventListener('modal:closing', resetFinalizeState);

  function showPaypalButton(orderId, currency){
    const msg = ensureMsgEl();
    msg.textContent = 'Veuillez confirmer le paiement PayPal pour finaliser.';
    if (confirmBtn) confirmBtn.style.display = 'none';
    removePaypalContainer();

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Paiement: configuration PayPal manquante (PAYPAL_CLIENT_ID / PayPalIntegration).');
      return;
    }

    // Mini watcher pour l'expiration pendant PayPal
    function haveMyValidLocksLocal(indices, graceMs = 5000){
      if (!window.LockManager) return true;
      const locks = window.LockManager.getLocalLocks?.() || {};
      const t = Date.now() + graceMs;
      for (const i of indices || []) {
        const l = locks[String(i)];
        if (!l || l.uid !== uid || !(l.until > t)) return false;
      }
      return true;
    }

    function setupPayPalExpiryBanner(){
      const blocks = getSelectedIndices();
      // clear précédent
      if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }
      function tick(){
        if (modal && modal.classList.contains('hidden')) {
          if (__watch) { clearInterval(__watch); __watch = null; }
          return;
        }
        const ok = haveMyValidLocksLocal(blocks);
        msg.textContent = ok
          ? 'Veuillez confirmer le paiement PayPal pour finaliser.'
          : 'Reservation expired — reselect';

        const box = document.getElementById('paypal-button-container');
        if (box) {
          box.style.pointerEvents = ok ? 'auto' : 'none';
          box.style.opacity = ok ? '' : '0.45';
        }

        if (!ok && __watch) {
          clearInterval(__watch);
          __watch = null;
        }
      }
      __watch = setInterval(tick, 10000);
      tick();
    }
    setupPayPalExpiryBanner();

    window.PayPalIntegration.initAndRender({
      orderId,
      currency: currency || 'USD',

      onApproved: async (data, actions) => {
        // NE PAS arrêter le heartbeat ici - on en a besoin pour valider les locks
        try { if (__watch) { clearInterval(__watch); __watch = null; } } catch {}

        try {
          btnBusy(true);
          const msg = ensureMsgEl();
          msg.textContent = 'Paiement confirmé. Finalisation en cours…';

          // Garde-fou final : vérifier les locks AVANT d'arrêter le heartbeat
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
              msg.textContent = 'Reservation expired — reselect';
              try { await unlockSelection(); } catch {}
              btnBusy(false);
              return;
            }
          }

          // 1) capture côté serveur
          const res = await window.CoreManager.apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify({ orderId, paypalOrderId: data.orderID })
          });

          // 🔁 Cas PayPal "INSTRUMENT_DECLINED" → redémarrer le flux PayPal sans casser les locks
          if (!res?.ok) {
            const name   = res?.details?.name || '';
            const issues = Array.isArray(res?.details?.details) ? res.details.details.map(d => d.issue) : [];
            const isInstrDeclined = res?.error === 'INSTRUMENT_DECLINED'
                                 || (name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED'));

            if (isInstrDeclined) {
              const msgEl = ensureMsgEl();
              msgEl.textContent = 'Paiement refusé par la banque. Veuillez réessayer dans PayPal…';

              if (actions && typeof actions.restart === 'function') {
                btnBusy(false);
                await actions.restart();
                return; // ne pas poursuivre
              }

              // Fallback minimal si jamais actions.restart n’est pas dispo
              btnBusy(false);
              uiWarn('Impossible de relancer automatiquement le paiement. Merci de recliquer sur le bouton PayPal.');
              return;
            }

            // Autres erreurs → flux normal d’erreur
            throw new Error(res?.error || res?.message || 'FINALIZE_INIT_FAILED');
          }

          // 2) attendre la finalisation par le webhook
          const ok = await waitForCompleted(orderId, 60);
          if (!ok) {
            msg.textContent = 'Paiement enregistré, finalisation en attente… Vous pourrez vérifier plus tard.';
            // Garder le heartbeat actif
            btnBusy(false);
            return;
          }

          // 3) succès - MAINTENANT on peut arrêter le heartbeat
          msg.textContent = 'Commande finalisée ✅';
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          await refreshStatus();

          //new fix
          // ✅ Forcer le rendu immédiat (URL + blocage de sélection)
          try { if (typeof window.paintAll === 'function') window.paintAll(); } catch {}

          try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}

          // ✅ Filet de sécurité : recheck + repaint juste après la fermeture
          setTimeout(async () => {
            try { await refreshStatus(); if (typeof window.paintAll === 'function') window.paintAll(); } catch {}
          }, 200);
          //new fix
          //try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}

        } catch (e) {
          uiError(e, 'PayPal');
          const msg = ensureMsgEl();
          msg.textContent = 'Erreur pendant la finalisation.';
          // En cas d'erreur, libérer les locks
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
        } finally {
          btnBusy(false);
        }
      },

      onCancel: async () => {
        try { if (__watch) { clearInterval(__watch); __watch = null; } } catch {}
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        const msg = ensureMsgEl();
        msg.textContent = 'Paiement annulé.';
        await unlockSelection();
        btnBusy(false);
        resumeHB();
      },

      onError: async (err) => {
        try { if (__watch) { clearInterval(__watch); __watch = null; } } catch {}
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        uiError(err, 'PayPal');
        const msg = ensureMsgEl();
        msg.textContent = 'Erreur de paiement.';
        await unlockSelection();
        btnBusy(false);
        resumeHB();
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

    // ✅ Pré-validation du fichier sélectionné AVANT toute finalisation
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        await window.UploadManager.validateFile(file);
      } else {
        uiWarn("Veuillez sélectionner une image (PNG, JPG, GIF, WebP).");
        return;
      }
    } catch (preErr) {
      uiError(preErr, 'Upload');
      uiWarn('Veuillez sélectionner une image valide (PNG, JPG, GIF, WebP).');
      return;
    }

    pauseHB();
    btnBusy(true);

    // ÉTAPE CLÉ 1 : Renouvellement des locks au clic "Confirm" (+3 minutes)
    if (!haveMyValidLocks(blocks, 1000)) {
      await refreshStatus().catch(()=>{});
      uiWarn('Your reservation expired. Please reselect your pixels.');
      btnBusy(false);
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      return;
    }

    // Renouvellement explicite pour 3 minutes supplémentaires
    try {
      if (window.LockManager) {
        console.log('[Finalize] Renewing locks for confirm step');
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
      }
    } catch (e) {
      console.warn('[Finalize] Lock renewal failed:', e);
    }

    // === START-ORDER: le serveur prépare la commande et uploade l'image ===
    let start = null;
    try {
      const file = fileInput.files[0];
      const contentType = await window.UploadManager.validateFile(file);
      const { base64Data } = await window.UploadManager.toBase64(file);

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
      resumeHB();
      return;
    }
    if (!start || !start.ok) {
      const message = (start && (start.error || start.message)) || 'Start order failed';
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
      btnBusy(false);
      resumeHB();
      return;
    }

    // On a un orderId + regionId
    const { orderId, regionId, currency } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    uiInfo('Commande créée. Veuillez finaliser le paiement…');

    // BUMP +3min AVANT PayPal (recommandation)
    if (window.LockManager) {
      try {
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
        console.log('[Finalize] Extended locks before PayPal phase');
      } catch (e) {
        console.warn('[Finalize] Lock extension before PayPal failed:', e);
      }
    }
    // → Afficher le bouton PayPal (qui gère son propre renouvellement)
    showPaypalButton(orderId, currency);

    // on laisse le bouton gérer la suite (onApproved / onCancel / onError)
  }

  // Finalize déclenché UNIQUEMENT par app.js (après re-lock)
  document.addEventListener('finalize:submit', (e) => {
    try { e.preventDefault && e.preventDefault(); } catch {}
    doConfirm();
  });

  // Expose ces deux helpers si tu veux y accéder depuis l’extérieur
  window.__finalizeHelpers = { resetFinalizeState, ensureMsgEl, showPaypalButton };
  // Expose for debugging if needed
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();
