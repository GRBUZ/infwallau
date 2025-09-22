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

  // =========================
  //  WebWorker base64 (off-thread) + downscale optionnel
  // =========================
  let __imgWorkerUrl = null;
  function ensureImgWorkerUrl(){
    if (__imgWorkerUrl) return __imgWorkerUrl;
    const workerSrc = `
      self.onmessage = async (e) => {
        try {
          const { file, maxEdge, quality } = e.data;
          // Try downscale with OffscreenCanvas + createImageBitmap
          let outBlob = file;
          try {
            if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
              const bmp = await createImageBitmap(file);
              const w = bmp.width, h = bmp.height;
              const ratio = Math.min(1, (maxEdge / Math.max(w, h)));
              const nw = Math.max(1, Math.round(w * ratio));
              const nh = Math.max(1, Math.round(h * ratio));
              const canvas = new OffscreenCanvas(nw, nh);
              const ctx = canvas.getContext('2d', {alpha:false, desynchronized:true});
              ctx.drawImage(bmp, 0, 0, nw, nh);
              // jpeg if possible, else keep original type
              const type = file.type && file.type.includes('png') ? 'image/png' : 'image/jpeg';
              outBlob = await canvas.convertToBlob({ type, quality });
            }
          } catch (_) { /* fallback: keep original blob */ }

          // base64 encode in worker
          const buf = await outBlob.arrayBuffer();
          // chunked conversion to binary string to avoid stack/memory spikes
          const CHUNK = 0x8000;
          let binary = '';
          const bytes = new Uint8Array(buf);
          for (let i=0; i<bytes.length; i+=CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
          }
          const b64 = btoa(binary);

          // Use data URL convention like UploadManager.toBase64 likely returns
          const contentType = outBlob.type || file.type || 'application/octet-stream';
          const base64Data = 'data:' + contentType + ';base64,' + b64;

          self.postMessage({ ok:true, contentType, base64Data, filename: file.name });
        } catch (err) {
          self.postMessage({ ok:false, error: String(err && err.message || err) });
        }
      };
    `;
    const blob = new Blob([workerSrc], { type: 'text/javascript' });
    __imgWorkerUrl = URL.createObjectURL(blob);
    return __imgWorkerUrl;
  }

  function toBase64OffThread(file, { maxEdge = 1600, quality = 0.82 } = {}){
    return new Promise((resolve, reject) => {
      try {
        const url = ensureImgWorkerUrl();
        const w = new Worker(url);
        w.onmessage = (e) => {
          const d = e.data || {};
          if (d.ok) resolve(d);
          else reject(new Error(d.error || 'WORKER_FAILED'));
          try { w.terminate(); } catch {}
        };
        w.onerror = (err) => { try { w.terminate(); } catch {}; reject(err); };
        w.postMessage({ file, maxEdge, quality });
      } catch (e) {
        reject(e);
      }
    });
  }

  // --- Préparation image en amont (cache)
  let __imgPrep = { promise: null, contentType: null, base64Data: null, filename: null };
  function resetImgPrep(){ __imgPrep = { promise: null, contentType: null, base64Data: null, filename: null }; }

  function prepImageEarly(file) {
    if (!file) { resetImgPrep(); return null; }
    if (__imgPrep.promise) return __imgPrep.promise; // déjà en cours/prêt
    __imgPrep.filename = file.name;

    __imgPrep.promise = (async () => {
      // Validation via UploadManager (léger)
      const ct = await window.UploadManager.validateFile(file);
      // Encodage base64 off-thread (downscale 1600px max, qualité 0.82)
      let contentType, base64Data, filename;
      try {
        const r = await toBase64OffThread(file, { maxEdge: 1600, quality: 0.82 });
        contentType = r.contentType || ct;
        base64Data  = r.base64Data;
        filename    = r.filename || file.name;
      } catch (e) {
        // Fallback: si worker pas supporté, on retombe sur l’implémentation existante
        const r2 = await window.UploadManager.toBase64(file);
        contentType = ct;
        base64Data  = r2.base64Data;
        filename    = file.name;
      }
      __imgPrep.contentType = contentType;
      __imgPrep.base64Data  = base64Data;
      __imgPrep.filename    = filename;
      return true;
    })().catch(err => { resetImgPrep(); throw err; });

    return __imgPrep.promise;
  }

  // Démarrer la préparation dès la sélection de fichier
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      try {
        const f = fileInput.files && fileInput.files[0];
        prepImageEarly(f); // fire & forget
      } catch {}
    }, { passive: true });
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
    
    msg.style.display = '';
    return msg;
  }

  // Ajoutez cette fonction pour nettoyer le statut lors de la fermeture :
  function resetPaymentStatus() {
    const statusEl = document.getElementById('payment-status');
    if (statusEl && statusEl.parentNode) {
      statusEl.parentNode.removeChild(statusEl);
    }
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

    // reset cache image
    resetImgPrep();

    resetPaymentStatus();
  }

  // Ces events sont émis par app.js dans openModal()/closeModal()
  document.addEventListener('modal:opening', resetFinalizeState);
  document.addEventListener('modal:closing', resetFinalizeState);

  function showPaypalButton(orderId, currency){
    if (confirmBtn) confirmBtn.style.display = 'none';
    removePaypalContainer();

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Paiement: configuration PayPal manquante (PAYPAL_CLIENT_ID / PayPalIntegration).');
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

    function setupPayPalExpiryBanner() {
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
          container.className = ok ? 'active' : 'expired';
          container.style.pointerEvents = ok ? 'auto' : 'none';
          container.style.opacity = ok ? '' : '0.6';
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
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;

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
              msg.textContent = '⏰ Reservation expired — reselect';
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

              btnBusy(false);
              uiWarn('Impossible de relancer automatiquement le paiement. Merci de recliquer sur le bouton PayPal.');
              return;
            }

            throw new Error(res?.error || res?.message || 'FINALIZE_INIT_FAILED');
          }

          // 2) attendre la finalisation par le webhook
          const ok = await waitForCompleted(orderId, 60);
          if (!ok) {
            msg.textContent = 'Paiement enregistré, finalisation en attente… Vous pourrez vérifier plus tard.';
            btnBusy(false);
            return;
          }

          // 3) succès - MAINTENANT on peut arrêter le heartbeat
          msg.textContent = 'Commande finalisée ✅';
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          await refreshStatus();
          try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}

        } catch (e) {
          uiError(e, 'PayPal');
          const msg = ensureMsgEl();
          msg.textContent = 'Erreur pendant la finalisation.';
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
        //const msg = ensureMsgEl();
        //msg.textContent = 'Paiement annulé.';

        //new paypal style
        // PAR : utiliser le header PayPal intégré
        const container = document.getElementById('paypal-button-container');
        if (container) {
        container.className = 'cancelled'; // Nouvel état
        }
        //new paypal style
        await unlockSelection();
        btnBusy(false);
        resumeHB();
      },

      onError: async (err) => {
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;
        uiError(err, 'PayPal');
        //const msg = ensureMsgEl();
        //msg.textContent = 'Erreur de paiement.';
        //new paypal style
        const container = document.getElementById('paypal-button-container');
        if (container) {
        container.className = 'error';
        }
        //new paypal style 
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
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

    // ✅ Pré-validation + préparation (cache off-thread si possible)
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { uiWarn("Veuillez sélectionner une image (PNG, JPG, GIF, WebP)."); return; }
    try {
      await prepImageEarly(file); // si déjà lancé, attend; sinon lance maintenant
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
      const contentType = __imgPrep.contentType;
      const base64Data  = __imgPrep.base64Data;

      start = await apiCall('/start-order', {
        method: 'POST',
        body: JSON.stringify({
          name, linkUrl, blocks,
          filename: __imgPrep.filename || (file && file.name) || 'image',
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

    // ⚡ Afficher PayPal immédiatement, puis prolonger les locks après peinture
    showPaypalButton(orderId, currency);

    Promise.resolve()
      .then(() => new Promise(requestAnimationFrame)) // laisse le navigateur peindre PayPal
      .then(async () => {
        if (window.LockManager) {
          try {
            await window.LockManager.lock(blocks, 180000, { optimistic: false });
            console.log('[Finalize] Extended locks after PayPal render');
          } catch (e) {
            console.warn('[Finalize] Lock extension after PayPal failed:', e);
          }
        }
      });

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
