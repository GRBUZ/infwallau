// app.js — Version originale avec 3 optimisations ciblées UNIQUEMENT
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[app.js] CoreManager is required. Please load js/core-manager.js before this file.');
    return;
  }
  if (!window.LockManager) {
    console.error('[app.js] LockManager is required. Please load js/locks.js before this file.');
    return;
  }

  const { uid, apiCall } = window.CoreManager;

  const N = 100;
  const TOTAL_PIXELS = 1_000_000;

  const grid = document.getElementById('grid');
  const buyBtn = document.getElementById('buyBtn');
  const priceLine = document.getElementById('priceLine');
  const pixelsLeftEl = document.getElementById('pixelsLeft');
  const selectionInfo = document.getElementById('selectionInfo');

  const modal = document.getElementById('modal');
  const form = document.getElementById('form');
  const linkInput = document.getElementById('link');
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');
  const confirmBtn = document.getElementById('confirm');
  const modalStats = document.getElementById('modalStats');
  const selectionGuide = document.getElementById('selectionGuide');

  let sold = {};
  let locks = {};
  let selected = new Set();
  let currentLock = [];

  let modalLockTimer = null;
  let globalPrice = null;
  let reservedPrice = null;
  let reservedTotal = null;
  let reservedTotalAmount = null;
  let hasUserDragged = false;
  let isMouseOverGrid = false;
  let modalOpened = false;
  // en haut, ajouter
  let lastStatusTs = 0;

  window.getSelectedIndices = () => Array.from(selected);

  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }
  function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
  function rowColToIdx(r,c){ return r*N + c; }

  function setPayPalHeaderState(state){
    const el = document.getElementById('paypal-button-container');
    if (el) el.className = String(state || '').trim();
  }

  // OPTIMISATION 1: Build grid avec DocumentFragment (plus rapide)
  (function build(){
    const frag = document.createDocumentFragment();
    for (let i=0;i<N*N;i++){
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.idx = i;
      frag.appendChild(d);
    }
    grid.appendChild(frag);
    const cs = getComputedStyle(grid);
    if (cs.position === 'static') grid.style.position = 'relative';
  })();

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
  
  function paintAll(){
    for(let i=0;i<N*N;i++) paintCell(i);
    refreshTopbar();
  }

  function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    if (!selectionInfo) return;

    if (modal && !modal.classList.contains('hidden')) {
      selectionInfo.classList.remove('show');
      return;
    }

    const selectedPixels = selected.size * 100;
    if (selectedPixels <= 0) {
      selectionInfo.classList.remove('show');
      return;
    }

    const currentPrice = Number.isFinite(+globalPrice) ? +globalPrice : 1;

    const STEP_PX = 1000;
    const STEP_INCREMENT = 0.01;

    let remaining = selectedPixels;
    let tierIndex = 0;
    let total = 0;

    const fullSteps = Math.floor(remaining / STEP_PX);
    for (let k = 0; k < fullSteps; k++) {
      const pricePerPixel = currentPrice + (STEP_INCREMENT * tierIndex);
      total += pricePerPixel * STEP_PX;
      tierIndex++;
    }

    const rest = remaining % STEP_PX;
    if (rest > 0) {
      const pricePerPixel = currentPrice + (STEP_INCREMENT * tierIndex);
      total += pricePerPixel * rest;
    }

    const totalRounded = Math.round(total * 100) / 100;

    selectionInfo.innerHTML =
      `<span class="count">${selectedPixels.toLocaleString()}</span> pixels selected • ~$${totalRounded.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    selectionInfo.classList.add('show');
  }

  function refreshTopbar(){
    const currentPrice = Number.isFinite(globalPrice) ? globalPrice : 1;
    priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;
    pixelsLeftEl.textContent = `${TOTAL_PIXELS.toLocaleString('en-US')} pixels`;

    buyBtn.textContent = `💎 Claim your spot`; buyBtn.disabled = false;

    if (selected.size > 150) {
      document.body.classList.add('heavy-selection');
    } else {
      document.body.classList.remove('heavy-selection');
    }
    updateSelectionInfo();
  }

  function clearSelection(){
    for(const i of selected) grid.children[i].classList.remove('sel');
    selected.clear();
    if (selectionGuide) {
      selectionGuide.classList.remove('hidden');
    }
    modalOpened = false;
    refreshTopbar();
    resetGuideState();
  }

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
    if (blockedDuringDrag){ 
      clearSelection(); 
      showInvalidRect(r0,c0,r1,c1,900); 
      return; 
    }
    hideInvalidRect(); 
    clearSelection();
    for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){ 
      const idx=rowColToIdx(r,c); 
      selected.add(idx); 
    }
    for(const i of selected) grid.children[i].classList.add('sel');
    
    if (selectionGuide) {
      if (selected.size === 0) {
        selectionGuide.classList.remove('hidden');
      } else {
        selectionGuide.classList.add('hidden');
      }
    }
    modalOpened = false;
    refreshTopbar();
  }

  function toggleCell(idx){
    if (isBlockedCell(idx)) return;
    if (selected.has(idx)) { selected.delete(idx); }
    else { selected.add(idx); }
    paintCell(idx);
    
    if (selectionGuide) {
      if (selected.size === 0) {
        selectionGuide.classList.remove('hidden');
        showGuideIfNeeded();
      } else {
        selectionGuide.classList.add('hidden');
      }
    }
    
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(refreshTopbar);
    } else {
      modalOpened = false;
      refreshTopbar();
    }
  }

  function idxFromClientXY(x,y){
    const rect=grid.getBoundingClientRect();
    const { w:CW, h:CH } = getCellSize();
    const gx=Math.floor((x-rect.left)/CW), gy=Math.floor((y-rect.top)/CH);
    if (gx<0||gy<0||gx>=N||gy>=N) return -1;
    return gy*N + gx;
  }

  function updateGuidePosition(e) {
    if (hasUserDragged || !isMouseOverGrid) return;
    
    if (selectionGuide) {
      selectionGuide.style.left = e.clientX + 'px';
      selectionGuide.style.top = e.clientY + 'px';
    }
  }

  function dismissGuide() {
    hasUserDragged = true;
    if (selectionGuide) {
      selectionGuide.classList.add('dismissed');
    }
  }

  function showGuideIfNeeded() {
    if (!hasUserDragged && selected.size === 0) {
      if (selectionGuide) {
        selectionGuide.classList.remove('dismissed');
        if (isMouseOverGrid) {
          selectionGuide.classList.add('show');
        }
      }
    }
  }
  
  function resetGuideState() {
    if (!hasUserDragged && selected.size === 0) {
      if (selectionGuide) {
        selectionGuide.classList.remove('dismissed');
        if (isMouseOverGrid) {
          selectionGuide.classList.add('show');
        }
      }
    }
  }

  grid.addEventListener('mouseenter', (e) => {
    if (hasUserDragged) return;
    isMouseOverGrid = true;
    if (selectionGuide && selected.size === 0) {
      selectionGuide.classList.add('show');
      updateGuidePosition(e);
    }
  });

  grid.addEventListener('mouseleave', () => {
    isMouseOverGrid = false;
    if (selectionGuide && !hasUserDragged) {
      selectionGuide.classList.remove('show');
    }
  });

  grid.addEventListener('mousemove', updateGuidePosition);

  grid.addEventListener('mousedown',(e)=>{
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    isDragging=true; dragStartIdx=idx; lastDragIdx=idx; movedDuringDrag=false; suppressNextClick=false;
    selectRect(idx, idx); e.preventDefault();
  });
 
  window.addEventListener('mousemove',(e)=>{
    if(!isDragging) return;
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    if(idx!==lastDragIdx){ movedDuringDrag=true; lastDragIdx=idx; }
    if (!hasUserDragged && movedDuringDrag) {
      dismissGuide();
    }
    selectRect(dragStartIdx, idx);
  });
  
  window.addEventListener('mouseup',()=>{
    if (isDragging){ suppressNextClick=movedDuringDrag; }
    isDragging=false; dragStartIdx=-1; movedDuringDrag=false; lastDragIdx=-1;
  });
  
  grid.addEventListener('click',(e)=>{
    if(suppressNextClick){ suppressNextClick=false; return; }
    if(isDragging) return;
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    toggleCell(idx);
  });

  function resetModalAppState() {
    if (linkInput)  linkInput.value  = '';
    if (nameInput)  nameInput.value  = '';
    if (emailInput) emailInput.value = '';

    const fileInput =
      document.getElementById('avatar') ||
      document.getElementById('file')   ||
      document.querySelector('input[type="file"]');

    if (fileInput) {
      fileInput.value = '';
    }
  }
 
  function setPayPalEnabled(enabled){
    const c = document.getElementById('paypal-button-container');
    if (!c) return;
    c.style.pointerEvents = enabled ? '' : 'none';
    c.style.opacity = enabled ? '' : '0.45';
    c.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    setPayPalHeaderState(enabled ? 'active' : 'expired');
  }
 //new

 //new

  function haveMyValidLocks(arr, graceMs = 2000){
    if (!arr || !arr.length) return false;
    const now = Date.now() + Math.max(0, graceMs|0);
    for (const i of arr){
      const l = locks[String(i)];
      if (!l || l.uid !== uid || !(l.until > now)) return false;
    }
    return true;
  }
  
  function startModalMonitor(warmupMs = 1200){
    stopModalMonitor();

    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';
    setPayPalEnabled(true);
    setPayPalHeaderState('active');
    
    const tick = () => {
      if (confirmBtn.textContent === 'Processing…') return;

      const blocks = currentLock.length ? currentLock : Array.from(selected);
      const ok = haveMyValidLocks(blocks, 5000);

      confirmBtn.disabled = !ok;
      confirmBtn.textContent = ok ? 'Confirm' : '⏰ Reservation expired — reselect';
      setPayPalEnabled(ok);

      if (!ok && blocks && blocks.length) {
        window.LockManager.heartbeat.stop();
      }
    };

    const start = () => {
      tick();
      modalLockTimer = setInterval(tick, 5000);
    };

    modalLockTimer = setTimeout(start, Math.max(0, warmupMs|0));
  }

  function stopModalMonitor(){
    if (modalLockTimer){
      try { clearTimeout(modalLockTimer); } catch {}
      try { clearInterval(modalLockTimer); } catch {}
      modalLockTimer = null;
    }
  }
  
  function openModal(){
    resetModalAppState();

    document.dispatchEvent(new CustomEvent('modal:opening'));
    modal.classList.remove('hidden');

    modalOpened = true;
    const selectionInfo = document.getElementById('selectionInfo');
    if (selectionInfo) selectionInfo.classList.remove('show');

    const selectedPixels = selected.size * 100;

    let total = null;
    if (Number.isFinite(reservedTotal)) {
      total = reservedTotal;
    } else if (Number.isFinite(reservedPrice)) {
      total = selectedPixels * reservedPrice;
    }

    /*if (Number.isFinite(total)) {
      modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;
      confirmBtn.disabled = false;
    } else {
      modalStats.textContent = `${formatInt(selectedPixels)} px — price pending…`;
      confirmBtn.disabled = true;
    }*/
   if (Number.isFinite(total)) {
  modalStats.innerHTML = `<span class="pixels">${formatInt(selectedPixels)} px - </span><span class="amount">${formatMoney(total)}</span>`;
  confirmBtn.disabled = false;
} else {
  modalStats.innerHTML = `<span class="pixels">${formatInt(selectedPixels)} px</span><span class="amount">price pending…</span>`;
  confirmBtn.disabled = true;
}

    if (currentLock.length) {
      window.LockManager.heartbeat.start(currentLock, 30000, 180000, {
        maxMs: 180000,
        autoUnlock: true,
        requireActivity: true
      });
    } else {
      window.LockManager.heartbeat.stop();
    }

    startModalMonitor();
  }

  function closeModal(){
    document.dispatchEvent(new CustomEvent('modal:closing'));
    modal.classList.add('hidden');
    window.LockManager.heartbeat.stop();
    stopModalMonitor();
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';
    reservedPrice = null;
    reservedTotalAmount = null; 
    reservedTotal = null;
    modalOpened = false;
  }

  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', async () => {
    const toRelease = (currentLock && currentLock.length) ? currentLock.slice() : Array.from(selected);
    currentLock = [];
    window.LockManager.heartbeat.stop();
    stopModalMonitor();
    if (toRelease.length) {
      try { await window.LockManager.unlock(toRelease); } catch {}
      locks = window.LockManager.getLocalLocks();
    }
    closeModal();
    clearSelection();
    setTimeout(async () => { await loadStatus(); paintAll(); }, 150);
  }));

  window.addEventListener('keydown', async (e)=>{
    if(e.key==='Escape' && !modal.classList.contains('hidden')){
      const toRelease = (currentLock && currentLock.length) ? currentLock.slice() : Array.from(selected);
      currentLock = [];
      window.LockManager.heartbeat.stop();
      stopModalMonitor();
      if (toRelease.length) {
        try { await window.LockManager.unlock(toRelease); } catch {}
        locks = window.LockManager.getLocalLocks();
      }
      closeModal();
      clearSelection();
      setTimeout(async () => { await loadStatus(); paintAll(); }, 150);
    }
  });

  buyBtn.addEventListener('click', async ()=>{
    if(!selected.size) {
      const warningMessage = document.getElementById('warningMessage');
      if (warningMessage) {
        warningMessage.classList.add('show');
        warningMessage.classList.add('shake');
        
        setTimeout(() => {
          warningMessage.classList.remove('show');
        }, 2000);
        
        setTimeout(() => {
          warningMessage.classList.remove('shake');
        }, 500);
      }
      return;
    }

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
	  
      if (typeof lr.totalAmount === 'number' && isFinite(lr.totalAmount)) {
        reservedTotal = lr.totalAmount; 
      }

      if (lr.unitPrice != null && isFinite(lr.unitPrice)) {
        reservedPrice = lr.unitPrice;
      }
	  
      clearSelection();
      for(const i of currentLock){ selected.add(i); grid.children[i].classList.add('sel'); }
      openModal();
      paintAll();
    }catch(e){
      alert('Reservation failed: ' + (e?.message || e));
    }
  });

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const blocks = currentLock.length ? currentLock.slice() : Array.from(selected);

    if (!haveMyValidLocks(blocks, 1000)) {
      window.LockManager.heartbeat.stop();
      await loadStatus().catch(()=>{});
      closeModal();
      clearSelection();
      paintAll();
      return;
    }

    document.dispatchEvent(new CustomEvent('finalize:submit'));
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

  // OPTIMISATION 2: Polling moins agressif (3.5s au lieu de 2.5s)
  /*async function loadStatus(){
    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      if (s && s.sold && typeof s.sold === 'object') {
        const isEmpty = Object.keys(s.sold).length === 0;
        const hasRegions = s.regions && Object.keys(s.regions).length > 0;
        if (!isEmpty || !hasRegions) {
          sold = s.sold;
        }
      }

      window.sold = sold;

      const merged = window.LockManager.merge(s.locks || {});
      locks = merged;

      window.regions = s.regions || {};
      if (typeof window.renderRegions === 'function') window.renderRegions();

      if (typeof s.currentPrice === 'number') {
        globalPrice = s.currentPrice;
      }

      if (!modal.classList.contains('hidden')) {
        if (confirmBtn.textContent !== 'Processing…') {
          const blocks = currentLock.length ? currentLock : Array.from(selected);
          const ok = haveMyValidLocks(blocks, 5000);
          confirmBtn.disabled = !ok;

          if (ok) {
            confirmBtn.textContent = 'Confirm';
          } else {
            confirmBtn.textContent = '⏰ Reservation expired — reselect';
            window.LockManager.heartbeat.stop();
          }
          setPayPalEnabled(ok);
        }
      }

      paintAll();
    } catch (e) {
      console.warn('[status] failed', e);
    }
  }*/

    async function loadStatus(){
  try{
    // use since param if server supports it
    const sinceParam = lastStatusTs ? '?since=' + encodeURIComponent(lastStatusTs) : '?ts=' + Date.now();
    const s = await apiCall('/status' + sinceParam);

    if (!s || !s.ok) return;

    // update price & regions quickly
    if (typeof s.currentPrice === 'number') globalPrice = s.currentPrice;
    window.regions = s.regions || window.regions || {};

    // compute diffs between old & new sold/locks to avoid full repaint
    const newSold = s.sold || {};
    const newLocks = s.locks || {};
    const changed = new Set();

    // union of keys touched
    for (const k of Object.keys(sold || {})) changed.add(k);
    for (const k of Object.keys(newSold)) changed.add(k);
    for (const k of Object.keys(locks || {})) changed.add(k);
    for (const k of Object.keys(newLocks)) changed.add(k);

    // update local sold and locks (merge locks with manager)
    sold = newSold;
    const merged = window.LockManager.merge(newLocks || {});
    locks = merged;

    // paint only changed indices
    for (const k of changed) {
      const idx = parseInt(k, 10);
      if (!Number.isNaN(idx) && grid.children[idx]) paintCell(idx);
    }

    // update regions visuals and topbar
    if (typeof window.renderRegions === 'function') window.renderRegions();
    refreshTopbar();

    // update last status timestamp if server provides it (helpful for since)
    if (typeof s.ts === 'number') lastStatusTs = Number(s.ts) || lastStatusTs;

  } catch (e) {
    console.warn('[status] failed', e);
  }
}
  (async function init(){
    await loadStatus();
    paintAll();
    setInterval(async ()=>{ await loadStatus(); }, 3500); // OPTIMISATION: 3.5s au lieu de 2.5s
  })();

  window.regions = window.regions || {};
  
  function renderRegions() {
    const gridEl = document.getElementById('grid');
    if (!gridEl) return;
    gridEl.querySelectorAll('.region-overlay').forEach(n => n.remove());
    const firstCell = gridEl.querySelector('.cell');
    const size = firstCell ? firstCell.offsetWidth : 10;

    const regionLink = {};
  
    for (const [idx, s] of Object.entries(window.sold || {})) {
      const regionId = s.regionId || s.region_id;
      const linkUrl = s.linkUrl || s.link_url;
      if (s && regionId && !regionLink[regionId] && linkUrl) {
        regionLink[regionId] = linkUrl;
      }
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
  //new
  // Exposer globalement pour finalize-addon
window.startModalMonitor = startModalMonitor;
// Exposer globalement
window.stopModalMonitor = stopModalMonitor;
  //new
  window.__debugGetLocks = () => ({ fromManager: window.LockManager.getLocalLocks(), localVar: locks, uid });
})();