// app.js — Optimisé pour performance avec compatibilité 100%
(function(){
  'use strict';

  // Hard requirements (inchangé)
  if (!window.CoreManager) {
    console.error('[app.js] CoreManager is required. Please load js/core-manager.js before this file.');
    return;
  }
  if (!window.LockManager) {
    console.error('[app.js] LockManager is required. Please load js/locks.js before this file.');
    return;
  }

  const { uid, apiCall } = window.CoreManager;

  // Grid constants
  const N = 100;
  const TOTAL_PIXELS = 1_000_000;

  // DOM
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

  // OPTIMISATION 1: État centralisé avec tracking des changements
  let sold = {};
  let locks = {};
  let selected = new Set();
  let currentLock = [];

  // Track des changements pour éviter les repaints inutiles
  let lastSoldKeys = new Set();
  let lastLocksKeys = new Set();
  let lastSelectedKeys = new Set();
  let lastGlobalPrice = null;
  
  // Pool de cellules pour réutilisation DOM
  let cellPool = [];
  let cellsInUse = new Map(); // idx -> element

  // OPTIMISATION 2: Variables existantes préservées
  let modalLockTimer = null;
  let globalPrice = null;
  let reservedPrice = null;
  let reservedTotal = null;
  let reservedTotalAmount = null;
  let hasUserDragged = false;
  let isMouseOverGrid = false;
  let modalOpened = false;

  // OPTIMISATION 3: Debouncing et throttling
  let paintScheduled = false;
  let topbarScheduled = false;

  // Preserve API publique (inchangé)
  window.getSelectedIndices = () => Array.from(selected);

  // Helpers (inchangés)
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }
  function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
  function rowColToIdx(r,c){ return r*N + c; }

  function setPayPalHeaderState(state){
    const el = document.getElementById('paypal-button-container');
    if (el) el.className = String(state || '').trim();
  }

  // OPTIMISATION 4: Build grid avec pool de réutilisation
  function createCellElement(idx) {
    let cell = cellPool.pop();
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'cell';
    }
    cell.dataset.idx = idx;
    return cell;
  }

  function recycleCellElement(cell) {
    cell.className = 'cell';
    cell.style.cssText = '';
    cell.innerHTML = '';
    cell.title = '';
    delete cell.dataset.idx;
    cellPool.push(cell);
  }

  // OPTIMISATION 5: Build grid avec DocumentFragment
  (function build(){
    const frag = document.createDocumentFragment();
    
    // Créer toutes les cellules en batch
    const cells = [];
    for (let i = 0; i < N * N; i++) {
      const cell = createCellElement(i);
      cells.push(cell);
      cellsInUse.set(i, cell);
    }
    
    // Ajouter au fragment (plus rapide qu'appendChild individuels)
    cells.forEach(cell => frag.appendChild(cell));
    grid.appendChild(frag);
    
    const cs = getComputedStyle(grid);
    if (cs.position === 'static') grid.style.position = 'relative';
    
    console.log(`[Grid] Built ${N*N} cells with pool optimization`);
  })();

  // Invalid selection overlay (inchangé)
  const invalidEl = document.createElement('div');
  invalidEl.id = 'invalidRect';
  Object.assign(invalidEl.style, { position:'absolute', border:'2px solid #ef4444', background:'rgba(239,68,68,0.08)', pointerEvents:'none', display:'none', zIndex:'999' });
  const invalidIcon = document.createElement('div');
  Object.assign(invalidIcon.style, { position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:'1000' });
  invalidIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.95)"></circle><circle cx="12" cy="12" r="9" fill="none" stroke="#ef4444" stroke-width="2"></circle><line x1="8" y1="8" x2="16" y2="16" stroke="#ef4444" stroke-width="2"></line><line x1="16" y1="8" x2="8" y2="16" stroke="#ef4444" stroke-width="2"></line></svg>`;
  invalidEl.appendChild(invalidIcon);
  grid.appendChild(invalidEl);

  // Helpers unchanged
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

  // OPTIMISATION 6: paintCell optimisé avec mise en cache
  const cellStateCache = new Map(); // idx -> 'sold'|'pending'|'selected'|''

  function paintCell(idx){
    const d = cellsInUse.get(idx);
    if (!d) return;

    const s = sold[idx];
    const l = locks[idx];
    const reserved = l && l.until > Date.now() && !s;
    const reservedByOther = reserved && l.uid !== uid;
    const isSelected = selected.has(idx);

    // Calculer le nouvel état
    let newState = '';
    if (s) newState = 'sold';
    else if (reservedByOther) newState = 'pending';
    else if (isSelected) newState = 'selected';

    // Comparer avec le cache
    const cachedState = cellStateCache.get(idx);
    if (cachedState === newState) return; // Pas de changement
    
    cellStateCache.set(idx, newState);

    // Appliquer les changements uniquement si nécessaire
    d.classList.toggle('sold', !!s);
    d.classList.toggle('pending', !!reservedByOther);
    d.classList.toggle('sel', isSelected);

    // Per-cell background reset
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

  // OPTIMISATION 7: paintAll remplacé par paintChanged
  function detectChanges() {
    const changes = new Set();
    
    // Détecter changements dans sold
    const currentSoldKeys = new Set(Object.keys(sold));
    const soldDiff = new Set([...currentSoldKeys].filter(k => !lastSoldKeys.has(k)));
    const soldRemoved = new Set([...lastSoldKeys].filter(k => !currentSoldKeys.has(k)));
    soldDiff.forEach(k => changes.add(parseInt(k)));
    soldRemoved.forEach(k => changes.add(parseInt(k)));
    lastSoldKeys = currentSoldKeys;
    
    // Détecter changements dans locks
    const currentLocksKeys = new Set(Object.keys(locks));
    const locksDiff = new Set([...currentLocksKeys].filter(k => !lastLocksKeys.has(k)));
    const locksRemoved = new Set([...lastLocksKeys].filter(k => !currentLocksKeys.has(k)));
    locksDiff.forEach(k => changes.add(parseInt(k)));
    locksRemoved.forEach(k => changes.add(parseInt(k)));
    lastLocksKeys = currentLocksKeys;
    
    // Détecter changements dans selected
    const currentSelectedKeys = new Set(Array.from(selected).map(String));
    const selDiff = new Set([...currentSelectedKeys].filter(k => !lastSelectedKeys.has(k)));
    const selRemoved = new Set([...lastSelectedKeys].filter(k => !currentSelectedKeys.has(k)));
    selDiff.forEach(k => changes.add(parseInt(k)));
    selRemoved.forEach(k => changes.add(parseInt(k)));
    lastSelectedKeys = currentSelectedKeys;

    return Array.from(changes);
  }

  function paintAll(){
    if (paintScheduled) return;
    paintScheduled = true;
    
    requestAnimationFrame(() => {
      const changedIndices = detectChanges();
      
      if (changedIndices.length === 0) {
        paintScheduled = false;
        return;
      }
      
      console.log(`[Paint] Updating ${changedIndices.length} cells instead of ${N*N}`);
      
      // Paint seulement les cellules qui ont changé
      changedIndices.forEach(idx => paintCell(idx));
      
      paintScheduled = false;
      refreshTopbar();
    });
  }

  // OPTIMISATION 8: updateSelectionInfo avec throttling
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

    // Cache le calcul si le prix et la sélection n'ont pas changé
    const currentPrice = Number.isFinite(+globalPrice) ? +globalPrice : 1;
    const selectionKey = `${selectedPixels}_${currentPrice}`;
    
    if (updateSelectionInfo._lastKey === selectionKey) return;
    updateSelectionInfo._lastKey = selectionKey;

    // Pricing curve parameters
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

  // OPTIMISATION 9: refreshTopbar avec throttling
  function refreshTopbar(){
    if (topbarScheduled) return;
    topbarScheduled = true;
    
    requestAnimationFrame(() => {
      const currentPrice = Number.isFinite(globalPrice) ? globalPrice : 1;
      
      // Cache si le prix n'a pas changé
      if (lastGlobalPrice === currentPrice) {
        topbarScheduled = false;
        return;
      }
      lastGlobalPrice = currentPrice;
      
      priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;
      pixelsLeftEl.textContent = `${TOTAL_PIXELS.toLocaleString('en-US')} pixels`;

      buyBtn.textContent = `💎 Claim your spot`;
      buyBtn.disabled = false;

      if (selected.size > 150) {
        document.body.classList.add('heavy-selection');
      } else {
        document.body.classList.remove('heavy-selection');
      }
      
      updateSelectionInfo();
      topbarScheduled = false;
    });
  }

  // OPTIMISATION 10: clearSelection optimisé
  function clearSelection(){
    if (selected.size === 0) return;
    
    const toUpdate = Array.from(selected);
    selected.clear();
    
    // Batch update des classes
    toUpdate.forEach(idx => {
      const cell = cellsInUse.get(idx);
      if (cell) cell.classList.remove('sel');
    });
    
    if (selectionGuide) {
      selectionGuide.classList.remove('hidden');
    }
    
    modalOpened = false;
    refreshTopbar();
    resetGuideState();
  }

  // Variables pour drag (inchangées)
  let isDragging=false, dragStartIdx=-1, movedDuringDrag=false, lastDragIdx=-1, suppressNextClick=false;
  let blockedDuringDrag = false;

  // OPTIMISATION 11: selectRect avec batch processing
  function selectRect(aIdx,bIdx){
    const [ar,ac]=idxToRowCol(aIdx), [br,bc]=idxToRowCol(bIdx);
    const r0=Math.min(ar,br), r1=Math.max(ar,br), c0=Math.min(ac,bc), c1=Math.max(ac,bc);
    
    blockedDuringDrag = false;
    
    // Check blocking en batch
    const cellsToCheck = [];
    for(let r=r0;r<=r1;r++){
      for(let c=c0;c<=c1;c++){
        const idx=rowColToIdx(r,c);
        cellsToCheck.push(idx);
      }
    }
    
    for(const idx of cellsToCheck) {
      if (isBlockedCell(idx)) {
        blockedDuringDrag = true;
        break;
      }
    }

    if (blockedDuringDrag){ 
      clearSelection(); 
      showInvalidRect(r0,c0,r1,c1,900); 
      return; 
    }
    
    hideInvalidRect();
    clearSelection();
    
    // Batch add to selection
    for(const idx of cellsToCheck) {
      selected.add(idx);
    }
    
    // Batch update classes
    cellsToCheck.forEach(idx => {
      const cell = cellsInUse.get(idx);
      if (cell) cell.classList.add('sel');
    });

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

  // OPTIMISATION 12: toggleCell optimisé
  function toggleCell(idx){
    if (isBlockedCell(idx)) return;
    
    const cell = cellsInUse.get(idx);
    if (!cell) return;
    
    if (selected.has(idx)) { 
      selected.delete(idx); 
      cell.classList.remove('sel');
    } else { 
      selected.add(idx); 
      cell.classList.add('sel');
    }

    if (selectionGuide) {
      if (selected.size === 0) {
        selectionGuide.classList.remove('hidden');
        showGuideIfNeeded();
      } else {
        selectionGuide.classList.add('hidden');
      }
    }

    modalOpened = false;
    
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(refreshTopbar);
    } else {
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

  // Guide functions (inchangées)
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

  // OPTIMISATION 13: Event listeners avec delegation
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

  // OPTIMISATION 14: Throttled mouse events
  let mouseMoveThrottled = false;
  
  grid.addEventListener('mousedown', (e) => {
    const idx = idxFromClientXY(e.clientX, e.clientY); 
    if (idx < 0) return;
    
    isDragging = true; 
    dragStartIdx = idx; 
    lastDragIdx = idx; 
    movedDuringDrag = false; 
    suppressNextClick = false;
    selectRect(idx, idx); 
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    if (mouseMoveThrottled) return;
    mouseMoveThrottled = true;
    
    requestAnimationFrame(() => {
      const idx = idxFromClientXY(e.clientX, e.clientY); 
      if (idx < 0) {
        mouseMoveThrottled = false;
        return;
      }
      
      if (idx !== lastDragIdx) { 
        movedDuringDrag = true; 
        lastDragIdx = idx; 
        
        if (!hasUserDragged && movedDuringDrag) {
          dismissGuide();
        }
      }
      
      selectRect(dragStartIdx, idx);
      mouseMoveThrottled = false;
    });
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) { 
      suppressNextClick = movedDuringDrag; 
    }
    isDragging = false; 
    dragStartIdx = -1; 
    movedDuringDrag = false; 
    lastDragIdx = -1;
  });

  // OPTIMISATION 15: Click avec delegation
  grid.addEventListener('click', (e) => {
    if (suppressNextClick) { 
      suppressNextClick = false; 
      return; 
    }
    if (isDragging) return;
    
    const idx = idxFromClientXY(e.clientX, e.clientY); 
    if (idx < 0) return;
    
    toggleCell(idx);
  });

  // Modal functions (inchangées sauf optimisations mineures)
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

  // Lock management helpers (inchangés)
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

    if (Number.isFinite(total)) {
      modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;
      confirmBtn.disabled = false;
    } else {
      modalStats.textContent = `${formatInt(selectedPixels)} px — price pending…`;
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
  }

  // Event listeners pour modal (inchangés)
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

  // ESC handler (inchangé)
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

  // Buy flow (inchangé sauf logs)
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
      console.log(`[Buy] Requesting lock for ${want.length} blocks`);
      
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
      for(const i of currentLock){ selected.add(i); }
      
      // Batch update selected classes
      currentLock.forEach(idx => {
        const cell = cellsInUse.get(idx);
        if (cell) cell.classList.add('sel');
      });
      
      openModal();
      paintAll();
    }catch(e){
      console.error('[Buy] Reservation failed:', e);
      alert('Reservation failed: ' + (e?.message || e));
    }
  });

  // Form submission (inchangé)
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

  // OPTIMISATION 16: loadStatus avec cache intelligent
  let statusCache = { sold: {}, locks: {}, regions: {}, currentPrice: null, timestamp: 0 };
  let statusRequestInProgress = false;
  const STATUS_CACHE_TTL = 2000; // 2 secondes de cache

  async function loadStatus(){
    // Éviter les requêtes parallèles
    if (statusRequestInProgress) return;
    
    // Cache intelligent
    const now = Date.now();
    if (now - statusCache.timestamp < STATUS_CACHE_TTL && 
        Object.keys(statusCache.sold).length > 0) {
      console.log('[Status] Using cache');
      return;
    }

    statusRequestInProgress = true;

    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      statusCache.timestamp = now;

      // Détecter les changements avant de les appliquer
      const soldChanged = JSON.stringify(sold) !== JSON.stringify(s.sold || {});
      const locksChanged = JSON.stringify(locks) !== JSON.stringify(s.locks || {});

      if (s && s.sold && typeof s.sold === 'object') {
        const isEmpty = Object.keys(s.sold).length === 0;
        const hasRegions = s.regions && Object.keys(s.regions).length > 0;
        if (!isEmpty || !hasRegions) {
          sold = s.sold;
          statusCache.sold = s.sold;
        }
      }

      window.sold = sold;

      const merged = window.LockManager.merge(s.locks || {});
      locks = merged;
      statusCache.locks = merged;

      window.regions = s.regions || {};
      statusCache.regions = s.regions || {};
      
      if (typeof window.renderRegions === 'function') window.renderRegions();

      if (typeof s.currentPrice === 'number') {
        globalPrice = s.currentPrice;
        statusCache.currentPrice = s.currentPrice;
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

      // Ne repeindre que si nécessaire
      if (soldChanged || locksChanged) {
        console.log(`[Status] Changes detected - sold: ${soldChanged}, locks: ${locksChanged}`);
        paintAll();
      }

    } catch (e) {
      console.warn('[Status] Failed:', e);
    } finally {
      statusRequestInProgress = false;
    }
  }

  // OPTIMISATION 17: Polling adaptatif
  let pollInterval = 2500;
  let consecutiveEmptyResponses = 0;
  let isTabVisible = true;

  // Visibilité de l'onglet pour économiser les ressources
  document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden;
    console.log(`[Polling] Tab visibility: ${isTabVisible}`);
  });

  function adaptivePoll() {
    // Réduire la fréquence si l'onglet n'est pas visible
    const interval = isTabVisible ? pollInterval : pollInterval * 3;
    
    setTimeout(async () => {
      await loadStatus();
      
      // Adapter la fréquence selon l'activité
      if (consecutiveEmptyResponses > 10) {
        pollInterval = Math.min(pollInterval * 1.1, 10000); // Max 10s
      } else if (consecutiveEmptyResponses < 3) {
        pollInterval = Math.max(pollInterval * 0.9, 1000); // Min 1s
      }
      
      adaptivePoll();
    }, interval);
  }

  // Initial boot + polling optimisé
  (async function init(){
    console.log('[App] Initializing optimized version...');
    
    await loadStatus();
    paintAll();
    
    // Démarrer le polling adaptatif
    adaptivePoll();
    
    console.log('[App] Optimization summary:');
    console.log(`- Grid cells: ${N*N} (with reuse pool: ${cellPool.length} cached)`);
    console.log(`- Differential rendering enabled`);
    console.log(`- Adaptive polling: ${pollInterval}ms`);
    console.log(`- Event throttling enabled`);
  })();

  // OPTIMISATION 18: renderRegions optimisé
  window.regions = window.regions || {};
  
  function renderRegions() {
    const gridEl = document.getElementById('grid');
    if (!gridEl) return;
    
    // Réutiliser les overlays existants au lieu de les recréer
    const existingOverlays = new Map();
    gridEl.querySelectorAll('.region-overlay').forEach(overlay => {
      const regionId = overlay.dataset.regionId;
      if (regionId) existingOverlays.set(regionId, overlay);
    });

    const firstCell = gridEl.querySelector('.cell');
    const size = firstCell ? firstCell.offsetWidth : 10;

    const regionLink = {};
  
    // Cache des links pour éviter les recalculs
    for (const [idx, s] of Object.entries(window.sold || {})) {
      const regionId = s.regionId || s.region_id;
      const linkUrl = s.linkUrl || s.link_url;
      if (s && regionId && !regionLink[regionId] && linkUrl) {
        regionLink[regionId] = linkUrl;
      }
    }

    const usedRegions = new Set();

    for (const [rid, reg] of Object.entries(window.regions || {})) {
      if (!reg || !reg.rect || !reg.imageUrl) continue;
      
      usedRegions.add(rid);
      
      const { x, y, w, h } = reg.rect;
      const idxTL = y * 100 + x;
      const tl = gridEl.querySelector(`.cell[data-idx="${idxTL}"]`);
      if (!tl) continue;

      let overlay = existingOverlays.get(rid);
      
      if (!overlay) {
        overlay = document.createElement('a');
        overlay.className = 'region-overlay';
        overlay.dataset.regionId = rid;
        gridEl.appendChild(overlay);
      }

      // Mettre à jour les propriétés
      if (regionLink[rid]) { 
        overlay.href = regionLink[rid]; 
        overlay.target = '_blank'; 
        overlay.rel = 'noopener nofollow'; 
      } else {
        overlay.removeAttribute('href');
      }

      Object.assign(overlay.style, {
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
    }

    // Supprimer les overlays obsolètes
    existingOverlays.forEach((overlay, regionId) => {
      if (!usedRegions.has(regionId)) {
        overlay.remove();
      }
    });

    gridEl.style.position = 'relative';
    gridEl.style.zIndex = 2;
  }

  // Redéfinir window.renderRegions avec la version optimisée
  window.renderRegions = renderRegions;

  // OPTIMISATION 19: Memory management
  window.addEventListener('beforeunload', () => {
    // Nettoyage avant déchargement
    cellStateCache.clear();
    cellPool.length = 0;
    cellsInUse.clear();
    
    // Arrêter les timers
    stopModalMonitor();
    window.LockManager?.heartbeat?.stop?.();
    
    console.log('[App] Cleanup completed');
  });

  // OPTIMISATION 20: Performance monitoring
  if (typeof performance !== 'undefined') {
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) { // Seuil de 50ms
          console.warn(`[Perf] Slow operation: ${entry.name} took ${entry.duration}ms`);
        }
      }
    });
    
    try {
      perfObserver.observe({ entryTypes: ['measure'] });
    } catch (e) {
      // Performance API pas disponible
    }
  }

  // Debug helpers (inchangés)
  window.__debugGetLocks = () => ({ 
    fromManager: window.LockManager.getLocalLocks(), 
    localVar: locks, 
    uid,
    cellsInCache: cellStateCache.size,
    cellsInPool: cellPool.length,
    pollInterval: pollInterval
  });

  console.log('[App] Optimized version loaded successfully');
})();