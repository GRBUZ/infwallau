// app.js — UI + FlowManager (finalize + upload intégrés) — utilise CoreManager (apiCall) et LockManager
(function(){
  'use strict';

  // ==== Pré-requis =====
  if (!window.CoreManager) {
    console.error('[app.js] CoreManager is required. Please load js/core-manager.js before this file.');
    return;
  }
  if (!window.LockManager) {
    console.error('[app.js] LockManager is required. Please load js/locks.js before this file.');
    return;
  }

  const { uid, apiCall } = window.CoreManager;

  // ==== Grille / DOM ====
  const N = 100; // 100x100
  const TOTAL_PIXELS = 1_000_000;

  const grid = document.getElementById('grid');
  const buyBtn = document.getElementById('buyBtn');
  const priceLine = document.getElementById('priceLine');
  const pixelsLeftEl = document.getElementById('pixelsLeft');

  const modal = document.getElementById('modal');
  const form = document.getElementById('form');
  const linkInput = document.getElementById('link');
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');
  const confirmBtn = document.getElementById('confirm');
  const modalStats = document.getElementById('modalStats');
  const fileInput = document.getElementById('image') || document.getElementById('avatar'); // tolérant aux deux ids

  // ==== État ====
  let sold = {};
  let locks = {};
  let selected = new Set();
  let currentLock = [];          // indices actuellement lockés lors de l’ouverture de la modale
  let currentRegionId = null;    // si le backend renvoie un regionId au lock, on le stocke ici

  // ==== Helpers ====
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }
  function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
  function rowColToIdx(r,c){ return r*N + c; }
  function normalizeUrl(u){ u=String(u||'').trim(); if(!u) return ''; if(!/^https?:\/\//i.test(u)) u='https://'+u; return u; }

  // ==== Build grid ====
  (function build(){
    const frag=document.createDocumentFragment();
    for(let i=0;i<N*N;i++){ const d=document.createElement('div'); d.className='cell'; d.dataset.idx=i; frag.appendChild(d); }
    grid.appendChild(frag);
    const cs = getComputedStyle(grid);
    if (cs.position === 'static') grid.style.position = 'relative';
  })();

  // ---- Invalid selection overlay ----
  const invalidEl = document.createElement('div');
  invalidEl.id = 'invalidRect';
  Object.assign(invalidEl.style, { position:'absolute', border:'2px solid #ef4444', background:'rgba(239,68,68,0.08)', pointerEvents:'none', display:'none', zIndex:'999' });
  const invalidIcon = document.createElement('div');
  Object.assign(invalidIcon.style, { position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:'1000' });
  invalidIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.95)"></circle><circle cx="12" cy="12" r="9" fill="none" stroke="#ef4444" stroke-width="2"></circle><line x1="8" y1="8" x2="16" y2="16" stroke="#ef4444" stroke-width="2"></line><line x1="16" y1="8" x2="8" y2="16" stroke="#ef4444" stroke-width="2"></line></svg>`;
  invalidEl.appendChild(invalidIcon);
  grid.appendChild(invalidEl);

  function getCellSize(){
    const cell = grid.children[0];
    if(!cell) return { w:10, h:10 };
    const r = cell.getBoundingClientRect();
    return { w:Math.max(1,Math.round(r.width)), h:Math.max(1,Math.round(r.height)) };
  }
  function showInvalidRect(r0,c0,r1,c1, ttl=900){
    const { w:CW, h:CH } = getCellSize();
    const left=c0*CW, top=r0*CH, w=(c1-c0+1)*CW, h=(r1-r0+1)*CH;
    Object.assign(invalidEl.style,{ left:left+'px', top:top+'px', width:w+'px', height:h+'px', display:'block' });
    const size = Math.max(16, Math.min(64, Math.floor(Math.min(w, h) * 0.7)));
    const svg = invalidIcon.querySelector('svg'); svg.style.width=size+'px'; svg.style.height=size+'px';
    if (ttl>0) setTimeout(()=>{ invalidEl.style.display='none'; }, ttl);
  }
  function hideInvalidRect(){ invalidEl.style.display='none'; }

  function isBlockedCell(idx){
    if (sold[idx]) return true;
    const l = locks[idx];
    return !!(l && l.until > Date.now() && l.uid !== uid);
  }

  function paintCell(idx){
    const d = grid.children[idx];
    const s = sold[idx];
    const l = locks[idx];
    const reserved = l && l.until > Date.now() && !s;
    const reservedByOther = reserved && l.uid !== uid;

    d.classList.toggle('sold', !!s);
    d.classList.toggle('pending', !!reservedByOther);
    d.classList.toggle('sel', selected.has(idx));

    // fond par overlay (regions) → pas de background par cellule
    d.style.backgroundImage = '';
    d.style.backgroundSize = '';
    d.style.backgroundPosition = '';

    if (s){
      d.title=(s.name?s.name+' · ':'')+(s.linkUrl||'');
      if(!d.firstChild){ const a=document.createElement('a'); a.className='region-link'; a.target='_blank'; d.appendChild(a); }
      d.firstChild.href = s.linkUrl || '#';
    } else {
      d.title=''; if (d.firstChild) d.firstChild.remove();
    }
  }
  function paintAll(){ for(let i=0;i<N*N;i++) paintCell(i); refreshTopbar(); }

  function refreshTopbar(){
    const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;
    pixelsLeftEl.textContent = `${TOTAL_PIXELS.toLocaleString('en-US')} pixels`;

    const selectedPixels = selected.size * 100;
    if (selectedPixels > 0) {
      const total = selectedPixels * currentPrice;
      buyBtn.textContent = `Buy Pixels — ${formatInt(selectedPixels)} px (${formatMoney(total)})`;
      buyBtn.disabled = false;
    } else { buyBtn.textContent = `Buy Pixels`; buyBtn.disabled = true; }
  }

  function clearSelection(){
    for(const i of selected) grid.children[i].classList.remove('sel');
    selected.clear();
    refreshTopbar();
  }

  // ==== Sélection / drag ====
  let isDragging=false, dragStartIdx=-1, movedDuringDrag=false, lastDragIdx=-1, suppressNextClick=false;
  let blockedDuringDrag = false;

  function selectRect(aIdx,bIdx){
    const [ar,ac]=idxToRowCol(aIdx), [br,bc]=idxToRowCol(bIdx);
    const r0=Math.min(ar,br), r1=Math.max(ar,br), c0=Math.min(ac,bc), c1=Math.max(ac,bc);
    blockedDuringDrag = false;
    for(let r=r0;r<=r1;r++){
      for(let c=c0;c<=c1;c++){
        const idx=rowColToIdx(r,c);
        if (isBlockedCell(idx)) { blockedDuringDrag = true; break; }
      }
      if (blockedDuringDrag) break;
    }
    if (blockedDuringDrag){ clearSelection(); showInvalidRect(r0,c0,r1,c1,900); return; }
    hideInvalidRect(); clearSelection();
    for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){ const idx=rowColToIdx(r,c); selected.add(idx); }
    for(const i of selected) grid.children[i].classList.add('sel');
    refreshTopbar();
  }

  function toggleCell(idx){
    if (isBlockedCell(idx)) return;
    if (selected.has(idx)) { selected.delete(idx); } else { selected.add(idx); }
    paintCell(idx);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshTopbar);
    else refreshTopbar();
  }

  function idxFromClientXY(x,y){
    const rect=grid.getBoundingClientRect();
    const { w:CW, h:CH } = getCellSize();
    const gx=Math.floor((x-rect.left)/CW), gy=Math.floor((y-rect.top)/CH);
    if (gx<0||gy<0||gx>=N||gy>=N) return -1;
    return gy*N + gx;
  }

  grid.addEventListener('mousedown',(e)=>{ const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    isDragging=true; dragStartIdx=idx; lastDragIdx=idx; movedDuringDrag=false; suppressNextClick=false; selectRect(idx, idx); e.preventDefault(); });
  window.addEventListener('mousemove',(e)=>{ if(!isDragging) return; const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    if(idx!==lastDragIdx){ movedDuringDrag=true; lastDragIdx=idx; } selectRect(dragStartIdx, idx); });
  window.addEventListener('mouseup',()=>{ if (isDragging){ suppressNextClick=movedDuringDrag; }
    isDragging=false; dragStartIdx=-1; movedDuringDrag=false; lastDragIdx=-1; });
  grid.addEventListener('click',(e)=>{ if(suppressNextClick){ suppressNextClick=false; return; } if(isDragging) return;
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return; toggleCell(idx); });

  function openModal(){
    modal.classList.remove('hidden');
    const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    const selectedPixels = selected.size * 100;
    const total = selectedPixels * currentPrice;
    modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;

    if (currentLock.length) window.LockManager.heartbeat.start(currentLock);
  }
  function closeModal(){ modal.classList.add('hidden'); window.LockManager.heartbeat.stop(); }

  // ==== Fermer modale (boutons + ESC) avec unlock ====
  async function unifiedClose(){
    const toRelease = (currentLock && currentLock.length) ? currentLock.slice() : Array.from(selected);
    currentLock = []; currentRegionId = null;
    window.LockManager.heartbeat.stop();
    if (toRelease.length) {
      try { await window.LockManager.unlock(toRelease); } catch {}
      locks = window.LockManager.getLocalLocks();
    }
    closeModal(); clearSelection();
    setTimeout(async () => { await loadStatus(); paintAll(); }, 150);
  }
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', unifiedClose));
  window.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !modal.classList.contains('hidden')) unifiedClose(); });

  // ==== FlowManager (upload + finalize orchestrés) ====
  const FlowManager = (function(){
    async function validateImage(file){
      if (!file) return { ok:true, skip:true };
      // Si UploadManager existe, on lui délègue (sinon checks simples)
      if (window.UploadManager && typeof window.UploadManager.validate === 'function') {
        const vr = await window.UploadManager.validate(file);
        if (!vr || !vr.ok) return { ok:false, error: vr?.error || 'Invalid image' };
        return { ok:true, skip:false };
      }
      if (!file.type || !/^image\//i.test(file.type)) return { ok:false, error:'Please upload an image file.' };
      if (file.size > 5*1024*1024) return { ok:false, error:'Max 5 MB.' };
      return { ok:true, skip:false };
    }

    async function uploadImage(regionId, file){
      if (!regionId || !file) return { ok:true, skip:true };
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('regionId', regionId);
      const res = await apiCall('/upload', { method:'POST', body: fd, raw:true }); // apiCall gère auth; raw => ne force pas JSON
      if (!res || !res.ok) return { ok:false, error: res?.error || 'UPLOAD_FAILED' };
      return { ok:true, imageUrl: res.imageUrl, regionId: res.regionId };
    }

    /*async function linkImage(regionId, imageUrl){
      if (!regionId || !imageUrl) return { ok:true, skip:true };
      const res = await apiCall('/link-image', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ regionId, imageUrl })
      });
      if (!res || !res.ok) return { ok:false, error: res?.error || 'LINK_IMAGE_FAILED' };
      return { ok:true };
    }*/
   // Déprécié : /link-image n'est plus utilisé car /upload écrit déjà imageUrl dans state.json
  async function linkImage(regionId, imageUrl){
  if (!regionId || !imageUrl) return { ok:true, skip:true };
  // No-op pour compat ascendante : on log et on renvoie ok=true
  console.debug('[linkImage] noop: image déjà liée via /upload', { regionId, imageUrl });
  return { ok:true, noop:true };
  }


    return {
      // Le cœur : essaie upload AVANT finalize si regionId dispo; sinon finalize d’abord puis upload + link-image.
      async run({ name, linkUrl, blocks, file, preRegionId }){
        // 1) Validation basique
        const vImg = await validateImage(file);
        if (!vImg.ok) return { ok:false, error: vImg.error };

        // 2) Option A — regionId dispo (backend reserve moderne)
        if (preRegionId) {
          // upload d’abord
          if (!vImg.skip){
            const up = await uploadImage(preRegionId, file);
            if (!up.ok) return { ok:false, error: up.error };
          }
          // finalize
          const fin = await apiCall('/finalize', {
            method:'POST',
            headers:{ 'content-type':'application/json' },
            body: JSON.stringify({ name, linkUrl, blocks, regionId: preRegionId })
          });
          if (!fin || !fin.ok) return { ok:false, error: fin?.error || 'FINALIZE_FAILED' };
          return { ok:true, regionId: preRegionId };
        }

        // 3) Option B — pas de regionId au lock: finalize d’abord
        const fin = await apiCall('/finalize', {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body: JSON.stringify({ name, linkUrl, blocks })
        });
        if (!fin || !fin.ok) return { ok:false, error: fin?.error || 'FINALIZE_FAILED' };

        const regionId = fin.regionId || null;

        // si pas d’image ou pas de regionId → terminé
        if (!regionId || vImg.skip) return { ok:true, regionId };

        // upload après finalize (fallback)
        const up = await uploadImage(regionId, file);
        if (!up.ok) {
          // On n’échoue pas la vente, mais on remonte l’erreur d’upload pour info
          return { ok:true, regionId, uploadError: up.error };
        }

        // link-image si nécessaire (notre /upload met normalement déjà imageUrl dans state.json)
        if (!up.imageUrl){
          const lk = await linkImage(regionId, up.imageUrl);
          if (!lk.ok) return { ok:true, regionId, uploadError: lk.error };
        }

        return { ok:true, regionId };
      }
    };
  })();

  // ==== Buy flow ====
  buyBtn.addEventListener('click', async ()=>{
    if(!selected.size) return;
    const want = Array.from(selected);
    try{
      const lr = await window.LockManager.lock(want, 180000);
      locks = window.LockManager.getLocalLocks();

      if (!lr || !lr.ok || (lr.conflicts && lr.conflicts.length>0) || (lr.locked && lr.locked.length !== want.length)){
        const rect = rectFromIndices(want);
        if (rect) showInvalidRect(rect.r0, rect.c0, rect.r1, rect.c1, 1200);
        clearSelection(); paintAll();
        return;
      }

      currentLock = (lr.locked || []).slice();
      currentRegionId = lr.regionId || null; // SI ton backend renvoie regionId à reserve()
      clearSelection();
      for(const i of currentLock){ selected.add(i); grid.children[i].classList.add('sel'); }
      openModal();
      paintAll();
    }catch(e){
      alert('Reservation failed: ' + (e?.message || e));
    }
  });

  // ==== Finalize + Upload (submit) ====
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const name  = (nameInput.value || '').trim();
    let linkUrl = normalizeUrl(linkInput.value);
    if(!name || !linkUrl){ return; }

    // quelle image ?
    const file = (fileInput && fileInput.files && fileInput.files[0]) ? fileInput.files[0] : null;

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing…';

    try{
      const blocks = currentLock.length ? currentLock.slice() : Array.from(selected);

      // Re-lock juste avant (défensif, même uid)
      const lr = await window.LockManager.lock(blocks, 180000);
      locks = window.LockManager.getLocalLocks();
      if (!lr || !lr.ok) {
        await loadStatus().catch(()=>{});
        alert((lr && lr.error) || 'Some blocks are already locked/sold. Please reselect.');
        confirmBtn.disabled=false; confirmBtn.textContent='Confirm';
        return;
      }
      // Si reserve réactualise un regionId, prends-le
      if (lr.regionId) currentRegionId = lr.regionId;

      // Orchestration
      const out = await FlowManager.run({
        name, linkUrl, blocks, file, preRegionId: currentRegionId
      });

      if (!out.ok){
        alert(out.error || 'Unexpected error');
        return;
      }
      if (out.uploadError){
        // La vente est OK, mais on informe que l’upload n’a pas accroché
        console.warn('[upload] post-finalize issue:', out.uploadError);
        alert('Your pixels are confirmed, but image upload failed. You can retry the upload from the form.');
      }

      // Release + refresh
      try { await window.LockManager.unlock(blocks); } catch {}
      locks = window.LockManager.getLocalLocks();
      currentLock = []; currentRegionId = null;
      window.LockManager.heartbeat.stop();

      await loadStatus();
      clearSelection();
      paintAll();
      closeModal();
      refreshTopbar();
    }catch(err){
      alert('Finalize failed: '+(err?.message||err));
    }finally{
      confirmBtn.disabled=false; confirmBtn.textContent='Confirm';
    }
  });

  function rectFromIndices(arr){
    if (!arr || !arr.length) return null;
    let r0=999, c0=999, r1=-1, c1=-1;
    for (const idx of arr){
      const r=Math.floor(idx/N), c=idx%N;
      if (r<r0) r0=r; if (c<c0) c0=c; if (r>r1) r1=r; if (c>c1) c1=c;
    }
    return { r0,c0,r1,c1 };
  }

  // ==== Poll status (via CoreManager.apiCall) + merge locks via LockManager ====
  async function loadStatus(){
    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      sold = s.sold || {};
      window.sold = sold;

      const merged = window.LockManager.merge(s.locks || {});
      locks = merged;

      window.regions = s.regions || {};
      if (typeof window.renderRegions === 'function') window.renderRegions();

      paintAll();
    } catch (e) {
      console.warn('[status] failed', e);
    }
  }

  // ==== Boot + polling ====
  (async function init(){
    await loadStatus();
    paintAll();
    setInterval(async ()=>{ await loadStatus(); }, 2500);
  })();

  // ==== Regions overlay (inchangé) ====
  window.regions = window.regions || {};
  function renderRegions() {
    const gridEl = document.getElementById('grid');
    if (!gridEl) return;
    gridEl.querySelectorAll('.region-overlay').forEach(n => n.remove());
    const firstCell = gridEl.querySelector('.cell');
    const size = firstCell ? firstCell.offsetWidth : 10;

    const regionLink = {};
    for (const [idx, s] of Object.entries(window.sold || {})) {
      if (s && s.regionId && !regionLink[s.regionId] && s.linkUrl) regionLink[s.regionId] = s.linkUrl;
    }

    for (const [rid, reg] of Object.entries(window.regions || {})) {
      if (!reg || !reg.rect || !reg.imageUrl) continue;
      const { x, y, w, h } = reg.rect;
      const idxTL = y * 100 + x;
      const tl = gridEl.querySelector(`.cell[data-idx="${idxTL}"]`);
      if (!tl) continue;
      const a = document.createElement('a');
      a.className = 'region-overlay';
      if (regionLink[rid]) { a.href = regionLink[rid]; a.target = '_blank'; a.rel = 'noopener nofollow'; }
      Object.assign(a.style, {
        position: 'absolute',
        left: tl.offsetLeft + 'px',
        top:  tl.offsetTop  + 'px',
        width:  (w * size) + 'px',
        height: (h * size) + 'px',
        backgroundImage: `url("${reg.imageUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        zIndex: 999
      });
      gridEl.appendChild(a);
    }
    gridEl.style.position = 'relative';
    gridEl.style.zIndex = 2;
  }
  window.renderRegions = renderRegions;

  // ==== Debug helper ====
  window.__debugGetLocks = () => ({ fromManager: window.LockManager.getLocalLocks(), localVar: locks, uid });
})();
