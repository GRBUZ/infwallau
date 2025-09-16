// finalize-addon.js — Finalize flow (snapshot + server re-lock before capture)
// - Snapshot des blocs au Confirm (ordre figé)
// - Start-order (serveur = vérité)
// - PayPal button; onApproved => re-lock (60s, non-optimiste) => /paypal-capture-finalize
// - Heartbeat laissé actif jusqu’au succès, puis stop + unlock

(function(){
  'use strict';

  if (!window.CoreManager) { console.error('[Finalize] CoreManager required'); return; }
  if (!window.UploadManager) { console.error('[Finalize] UploadManager required'); return; }
  if (!window.LockManager) { console.warn('[Finalize] LockManager missing'); }
  const { uid, apiCall } = window.CoreManager;

  // ===== Helpers UI =====
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
  if (fileInput && !fileInput.getAttribute('accept')) fileInput.setAttribute('accept', 'image/*');

  function uiWarn(msg){ try{ window.Errors?.showToast?.(msg, window.Errors.LEVEL?.warn || 'warn', 4000); }catch{ alert(msg); } }
  function uiInfo(msg){ try{ window.Errors?.showToast?.(msg, window.Errors.LEVEL?.info || 'info', 2500); }catch{ console.log('[Info]', msg); } }
  function uiError(err, ctx){ try{ window.Errors?.notifyError?.(err, ctx); }catch{ console.error(ctx?`[${ctx}]`:'[Error]', err); alert(err?.message||'Something went wrong'); } }
  function btnBusy(b){ if(!confirmBtn) return; try{ if(b){ confirmBtn.dataset._origText = confirmBtn.dataset._origText || confirmBtn.textContent; confirmBtn.textContent='Processing…'; confirmBtn.disabled=true; } else { if(confirmBtn.dataset._origText){ confirmBtn.textContent=confirmBtn.dataset._origText; delete confirmBtn.dataset._origText; } confirmBtn.disabled=false; } }catch{} }
  function normalizeUrl(u){ u=String(u||'').trim(); if(!u) return ''; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{ const url=new URL(u); url.hash=''; return url.toString(); }catch{ return ''; } }

  function ensureMsgEl(){
    let msg = document.getElementById('payment-msg');
    if (!msg) {
      msg = document.createElement('div'); msg.id='payment-msg';
      (confirmBtn || form || modal || document.body).insertAdjacentElement('afterend', msg);
    }
    return msg;
  }
  function removePaypalContainer(){ const c=document.getElementById('paypal-button-container'); if(c&&c.parentNode) c.parentNode.removeChild(c); }

  // Lis la sélection courante si nécessaire (secours)
  function getSelectedIndices(){
    if (typeof window.getSelectedIndices === 'function') { try{ const arr=window.getSelectedIndices(); if(Array.isArray(arr)) return arr; }catch{} }
    if (window.selected instanceof Set) return Array.from(window.selected);
    const out=[]; document.querySelectorAll('.cell.sel').forEach(el=>{ const i=parseInt(el.dataset.idx,10); if(Number.isInteger(i)) out.push(i); }); return out;
  }

  // Vérif locale de mes locks (tolérance skew)
  function haveMyValidLocks(blocks, graceMs=2000){
    if (!window.LockManager) return true;
    const map = window.LockManager.getLocalLocks?.() || window.locks || {};
    const t = Date.now() + Math.max(0, graceMs|0);
    for (const i of blocks||[]) { const l=map[String(i)]; if (!l || l.uid!==uid || !(Number(l.until)>t)) return false; }
    return true;
  }

  // ===== Contexte commande courant (snapshot figé) =====
  let currentOrder = null; // { orderId, regionId, currency, blocks: number[] }

  // ===== PayPal =====
  function showPaypalButton(orderId, currency, orderBlocks){
    const msg = ensureMsgEl();
    msg.textContent = 'Veuillez confirmer le paiement PayPal pour finaliser.';
    if (confirmBtn) confirmBtn.style.display='none';
    removePaypalContainer();

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Paiement: configuration PayPal manquante (PAYPAL_CLIENT_ID / PayPalIntegration).');
      return;
    }

    // Renouvelle côté serveur (5 min) sans stopper le heartbeat existant
    try{
      if (window.LockManager && Array.isArray(orderBlocks) && orderBlocks.length && haveMyValidLocks(orderBlocks, 1000)) {
        // non-optimiste -> vérité serveur
        window.LockManager.lock(orderBlocks, 300000, { optimistic:false }).catch(e=>console.warn('[PayPal] Lock renewal failed:', e));
      }
    }catch(e){ console.warn('[PayPal] Lock renewal exception:', e); }

    // Bandeau d’expiration local pendant PayPal
    let __watch;
    (function setupPayPalExpiryBanner(){
      function tick(){
        if (modal && modal.classList.contains('hidden')) { clearInterval(__watch); return; }
        const ok = haveMyValidLocks(orderBlocks, 5000);
        msg.textContent = ok ? 'Veuillez confirmer le paiement PayPal pour finaliser.' : 'Reservation expired — reselect';
        const box=document.getElementById('paypal-button-container');
        if (box){ box.style.pointerEvents = ok ? 'auto' : 'none'; box.style.opacity = ok ? '' : '0.45'; }
        if (!ok) clearInterval(__watch);
      }
      clearInterval(__watch); __watch=setInterval(tick, 10000); tick();
    })();

    window.PayPalIntegration.initAndRender({
      orderId,
      currency: currency || 'USD',

      onApproved: async (data) => {
        try { /* pas d’arrêt du HB ici */ } catch {}
        try {
          btnBusy(true);
          const msg = ensureMsgEl();
          msg.textContent = 'Paiement confirmé. Finalisation en cours…';

          // === RE-LOCK SERVEUR (60s) SUR LE SNAPSHOT EXACT ===
          // Évite toute dérive “HB ok mais API 409”
          if (window.LockManager && Array.isArray(orderBlocks) && orderBlocks.length){
            const re = await window.LockManager.lock(orderBlocks, 60000, { optimistic:false });
            const me = window.CoreManager?.uid;
            const okSrv = re?.ok && orderBlocks.every(i => re.locks?.[String(i)]?.uid === me);
            if (!okSrv){
              msg.textContent = 'Reservation expired — reselect';
              btnBusy(false);
              return;
            }
          }

          // 1) Finalisation côté serveur (on envoie aussi regionId)
          const body = { orderId, paypalOrderId: data.orderID };
          if (currentOrder?.regionId) body.regionId = currentOrder.regionId;
          const res = await window.CoreManager.apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify(body)
          });
          if (!res?.ok) throw new Error(res?.error || res?.message || 'FINALIZE_INIT_FAILED');

          // 2) Attendre le webhook
          const done = await waitForCompleted(orderId, 60);
          if (!done){
            msg.textContent = 'Paiement enregistré, finalisation en attente… Vous pourrez vérifier plus tard.';
            return; // garder le heartbeat actif
          }

          // 3) Succès → stop HB + unlock
          msg.textContent = 'Commande finalisée ✅';
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          await refreshStatus();
          try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}
        } catch (e) {
          // Ne force pas l’unlock si 409: laisse l’utilisateur réessayer
          uiError(e, 'PayPal');
          const msg = ensureMsgEl();
          msg.textContent = (e?.message||'').includes('LOCK_MISSING_OR_EXPIRED')
            ? 'Reservation expired — reselect'
            : 'Erreur pendant la finalisation.';
        } finally {
          btnBusy(false);
        }
      },

      onCancel: async () => {
        const msg = ensureMsgEl(); msg.textContent = 'Paiement annulé.';
        // On laisse le HB vivre; app.js gère fermeture/cleanup
        btnBusy(false);
      },

      onError: async (err) => {
        uiError(err, 'PayPal');
        const msg = ensureMsgEl(); msg.textContent = 'Erreur de paiement.';
        btnBusy(false);
      }
    });
  }

  // ==== API helpers (statut + unlock) ====
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
      console.warn('[Finalize] refreshStatus failed', e);
    }
  }
  async function unlockSelection(){
    try{
      const blocks = getSelectedIndices();
      if (!blocks.length) return;
      if (window.LockManager) await window.LockManager.unlock(blocks);
      else await apiCall('/unlock',{method:'POST',body:JSON.stringify({blocks})});
    }catch(_){}
  }
  async function waitForCompleted(orderId, tries=30){
    for (let i=0;i<tries;i++){
      const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
      if (st?.ok && String(st.status).toLowerCase()==='completed') return true;
      if (st?.ok && String(st.status).toLowerCase()==='failed') return false;
      await new Promise(rs=>setTimeout(rs, 2000));
    }
    return false;
  }

  // ===== Flow Confirm =====
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocksNow = getSelectedIndices();

    if (!blocksNow.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // Pré-validation fichier
    try{
      const file = fileInput?.files?.[0];
      if (!file){ uiWarn('Veuillez sélectionner une image (PNG, JPG, GIF, WebP).'); return; }
      await window.UploadManager.validateFile(file);
    }catch(e){ uiError(e, 'Upload'); uiWarn('Veuillez sélectionner une image valide.'); return; }

    // Snapshot figé des blocs (trié pour stabilité côté serveur)
    const blocks = Array.from(new Set(blocksNow)).sort((a,b)=>a-b);

    // Vérification rapide des locks locaux
    if (!haveMyValidLocks(blocks, 1000)) {
      await refreshStatus().catch(()=>{});
      uiWarn('Your reservation expired. Please reselect your pixels.');
      return;
    }

    btnBusy(true);

    // START-ORDER: upload + création commande
    let start=null;
    try{
      const file = fileInput.files[0];
      const contentType = await window.UploadManager.validateFile(file);
      const { base64Data } = await window.UploadManager.toBase64(file);

      start = await apiCall('/start-order', {
        method:'POST',
        body: JSON.stringify({
          name, linkUrl, blocks,
          filename: file.name,
          contentType,
          contentBase64: base64Data
        })
      });
    }catch(e){ uiError(e, 'Start order'); btnBusy(false); return; }

    if (!start || !start.ok){
      const message=(start && (start.error||start.message)) || 'Start order failed';
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details:start }) : new Error(message), 'Start order');
      btnBusy(false);
      return;
    }

    const { orderId, regionId, currency } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    // Stocke le contexte exact de la commande
    currentOrder = { orderId, regionId, currency, blocks };

    uiInfo('Commande créée. Veuillez finaliser le paiement…');
    btnBusy(false);

    // Affiche PayPal et passe le SNAPSHOT
    showPaypalButton(orderId, currency, blocks);
  }

  // Déclenché par app.js (après ses propres checks)
  document.addEventListener('finalize:submit', (e)=>{ try{ e.preventDefault&&e.preventDefault(); }catch{} doConfirm(); });

  // Expose debug
  window.__iwPatch = { doConfirm, uid };
})();
