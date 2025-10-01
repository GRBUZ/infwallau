// finalize-addon.js — OPTIMISATION: Upload en parallèle pendant que l'utilisateur remplit le formulaire
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[finalize] CoreManager required');
    return;
  }
  if (!window.UploadManager) {
    console.error('[finalize] UploadManager required');
    return;
  }

  const { uid, apiCall } = window.CoreManager;

  const modal = document.getElementById('modal');
  const confirmBtn = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');

  let __processing = false;
  
  // OPTIMISATION 1: Cache de l'upload terminé
  let uploadedImageCache = null; // { imageUrl, regionId, uploadedAt }

  // [PATCH] utilitaires
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  async function backgroundFinalize(regionId, payload) {
    try {
      const resp = await apiCall('/finalize', {
        method: 'POST',
        body: JSON.stringify({ regionId, ...payload })
      });
      return resp;
    } catch (e) {
      console.warn('[Finalize] backgroundFinalize failed', e);
      return { ok:false, error:e.message };
    }
  }

  function pauseHB(){ if (__processing) return; __processing = true; try { window.LockManager?.heartbeat?.stop?.(); } catch {} }
  function resumeHB(){ if (!__processing) return; __processing = false; try { const sel = (typeof getSelectedIndices === 'function') ? getSelectedIndices() : []; if (modal && !modal.classList.contains('hidden') && sel && sel.length) { window.LockManager?.heartbeat?.start?.(sel, 30000, 180000, { maxMs: 180000, autoUnlock: true, requireActivity: true }); } } catch {} }
  function uiWarn(msg){ if (window.Errors?.showToast) { window.Errors.showToast(msg, window.Errors.LEVEL?.warn||'warn',4000);} else alert(msg);}
  function uiError(err,ctx){ if(window.Errors?.notifyError){window.Errors.notifyError(err,ctx);} else{console.error(ctx?`[${ctx}]`:'[Error]',err);alert((err&&err.message)||'Something went wrong');}}
  function btnBusy(busy){ if (!confirmBtn) return; try{ if(busy){ confirmBtn.dataset._origText=confirmBtn.dataset._origText||confirmBtn.textContent; confirmBtn.textContent='Processing…'; confirmBtn.disabled=true;} else { if(confirmBtn.dataset._origText){confirmBtn.textContent=confirmBtn.dataset._origText;delete confirmBtn.dataset._origText;} confirmBtn.disabled=false; } }catch{} }
  function normalizeUrl(u){ u=String(u||'').trim(); if(!u) return ''; if(!/^https?:\/\//i.test(u)) u='https://'+u; try{const url=new URL(u);url.hash='';return url.toString();}catch{return '';} }
  function getSelectedIndices(){ if(typeof window.getSelectedIndices==='function'){try{const arr=window.getSelectedIndices();if(Array.isArray(arr))return arr;}catch{}} if(window.selected instanceof Set){return Array.from(window.selected);} const out=[]; document.querySelectorAll('.cell.sel').forEach(el=>{const idx=parseInt(el.dataset.idx,10);if(Number.isInteger(idx))out.push(idx);}); return out; }
  async function refreshStatus(){ try{const d=await apiCall('/status?ts='+Date.now()); if(!d||!d.ok)return; window.sold=d.sold||{}; window.locks=window.LockManager?window.LockManager.merge(d.locks||{}):(d.locks||{}); window.regions=d.regions||{}; if(typeof window.renderRegions==='function') window.renderRegions();}catch(e){console.warn('[finalize] refreshStatus failed',e);} }
  async function unlockSelection(){ try{const blocks=getSelectedIndices(); if(!blocks.length)return; if(window.LockManager){await window.LockManager.unlock(blocks);} else {await apiCall('/unlock',{method:'POST',body:JSON.stringify({blocks})});}}catch{} }

  // … compression + upload listener (inchangé, garde ton code existant) …

  // doConfirm optimisé
  async function doConfirm(){
    const name=(nameInput?.value||'').trim();
    const linkUrl=normalizeUrl(linkInput?.value);
    const blocks=getSelectedIndices();
    if(!blocks.length){uiWarn('Please select at least one block.');return;}
    if(!name||!linkUrl){uiWarn('Name and Profile URL are required.');return;}
    if(!uploadedImageCache){uiWarn('Please wait for image upload to complete or select an image.');return;}
    if(Date.now()-uploadedImageCache.uploadedAt>300000){uiWarn('Image upload expired, please reselect your image.');uploadedImageCache=null;return;}

    pauseHB(); btnBusy(true);

    try {
      if (!haveMyValidLocks(blocks,1000)) {
        await refreshStatus().catch(()=>{});
        uiWarn('Your reservation expired. Please reselect your pixels.');
        btnBusy(false); try{window.LockManager?.heartbeat?.stop?.();}catch{}; return;
      }
      try { if(window.LockManager){ await window.LockManager.lock(blocks,180000,{optimistic:false}); } } catch{}

      console.log('[Finalize] Creating order with pre-uploaded image');
      const start=await apiCall('/start-order',{method:'POST',body:JSON.stringify({
        name,linkUrl,blocks,
        imageUrl:uploadedImageCache.imageUrl,
        regionId:uploadedImageCache.regionId
      })});
      if(!start?.ok){ throw new Error(start?.error||'Start order failed'); }

      const { orderId, regionId, currency }=start;

      // [PATCH] lancer finalize en arrière-plan
      const finalizePromise = backgroundFinalize(regionId,{ name, linkUrl, blocks });

      if(window.LockManager){ try{ await window.LockManager.lock(blocks,180000,{optimistic:false}); }catch{} }

      // Afficher PayPal sans attendre finalize
      showPaypalButton(orderId, currency, finalizePromise);

    } catch(e){
      uiError(e,'Confirm');
      btnBusy(false);
      try{await unlockSelection();}catch{}
      try{window.LockManager?.heartbeat?.stop?.();}catch{}
      resumeHB();
    }
  }

  function haveMyValidLocks(blocks,graceMs=5000){ if(!window.LockManager) return true; const locks=window.LockManager.getLocalLocks?.()||{}; const t=Date.now()+graceMs; for(const i of blocks||[]){const l=locks[String(i)]; if(!l||l.uid!==uid||!(l.until>t)) return false;} return true; }
  function setPayPalHeaderState(state){const el=document.getElementById('paypal-button-container'); if(el) el.className=String(state||'').trim(); }

  // [PATCH] showPaypalButton prend finalizePromise
  function showPaypalButton(orderId,currency,finalizePromise){
    if(confirmBtn) confirmBtn.style.display='none';
    const existing=document.getElementById('paypal-button-container');
    if(existing?.parentNode) existing.parentNode.removeChild(existing);
    if(!window.PayPalIntegration||!window.PAYPAL_CLIENT_ID){ uiWarn('Payment: missing PayPal configuration'); return; }

    window.PayPalIntegration.initAndRender({
      orderId,
      currency:currency||'USD',
      onApproved: async (data,actions)=>{
        try{
          btnBusy(true); setPayPalHeaderState('processing');
          const res=await apiCall('/paypal-capture-finalize',{method:'POST',body:JSON.stringify({orderId,paypalOrderId:data.orderID})});
          if(!res?.ok) throw new Error(res?.error||'PayPal capture failed');
          // attendre finalize
          await finalizePromise;
          setPayPalHeaderState('completed');
          try{window.LockManager?.heartbeat?.stop?.();}catch{}
          try{await unlockSelection();}catch{}
          uploadedImageCache=null;
          await refreshStatus();
          if(modal&&!modal.classList.contains('hidden')) modal.classList.add('hidden');
        }catch(e){
          uiError(e,'PayPal'); setPayPalHeaderState('error');
          try{window.LockManager?.heartbeat?.stop?.();}catch{}
          try{await unlockSelection();}catch{}
        } finally { btnBusy(false); }
      },
      onCancel: async ()=>{ try{window.LockManager?.heartbeat?.stop?.();}catch{}; setPayPalHeaderState('cancelled'); try{await unlockSelection();}catch{}; btnBusy(false); },
      onError: async (err)=>{ uiError(err,'PayPal'); setPayPalHeaderState('error'); try{window.LockManager?.heartbeat?.stop?.();}catch{}; try{await unlockSelection();}catch{}; btnBusy(false); }
    });
  }

  async function waitForCompleted(orderId,maxSeconds=120){ /* inchangé */ }

  document.addEventListener('finalize:submit',(e)=>{ try{e.preventDefault&&e.preventDefault();}catch{} doConfirm(); });

  function resetModalState(){ uploadedImageCache=null; if(fileInput){fileInput.value='';delete fileInput._cachedFile;} const pi=document.querySelector('.upload-progress-mini'); if(pi) pi.remove(); }
  document.addEventListener('modal:opening',()=>{resetModalState();});
  document.addEventListener('modal:closing',()=>{resetModalState();});

  console.log('[Finalize] Upload optimization loaded - images upload in background');
})();
