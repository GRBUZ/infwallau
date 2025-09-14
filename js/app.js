// app.js — client UI using CoreManager (uid + api calls) and LockManager (locks + heartbeat)
(function(){
  'use strict';

  // Hard requirements
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
  const N = 100;                 // 100 x 100 grid
  const TOTAL_PIXELS = 1_000_000;

  // DOM
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

  // State
  let sold = {};
  let locks = {};               // local cached view (synced from LockManager)
  let selected = new Set();
  let currentLock = [];         // blocks locked when opening the modal

  // Surveillance d’expiration pendant le modal
  let modalLockTimer = null;

  // Expose la sélection au besoin (pour d'autres modules)
  window.getSelectedIndices = () => Array.from(selected);

  // Helpers
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }
  function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
  function rowColToIdx(r,c){ return r*N + c; }

  // Build grid
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

  // Invalid selection overlay
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

    // Per-cell background is handled by regions overlay below; keep cell bg clean
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

  // Optimisé: ne repeint que la cellule cliquée (plus topbar), pas tout le grid
  function toggleCell(idx){
    if (isBlockedCell(idx)) return;
    if (selected.has(idx)) { selected.delete(idx); }
    else { selected.add(idx); }
    paintCell(idx);
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

  grid.addEventListener('mousedown',(e)=>{
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    isDragging=true; dragStartIdx=idx; lastDragIdx=idx; movedDuringDrag=false; suppressNextClick=false;
    selectRect(idx, idx); e.preventDefault();
  });
  window.addEventListener('mousemove',(e)=>{
    if(!isDragging) return;
    const idx=idxFromClientXY(e.clientX,e.clientY); if(idx<0) return;
    if(idx!==lastDragIdx){ movedDuringDrag=true; lastDragIdx=idx; }
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

  // === Garde-fous d’expiration côté client ===
  function haveMyValidLocks(arr, graceMs = 500){
    if (!arr || !arr.length) return false;
    const now = Date.now() + Math.max(0, graceMs|0);
    for (const i of arr){
      const l = locks[String(i)];
      if (!l || l.uid !== uid || !(l.until > now)) return false;
    }
    return true;
  }
  function startModalMonitor(){
    stopModalMonitor();
    modalLockTimer = setInterval(() => {
  // 👉 Don't touch while finalize flow is running
      if (confirmBtn.textContent === 'Processing…') return;

      const blocks = currentLock.length ? currentLock : Array.from(selected);
      
      //const ok = haveMyValidLocks(blocks);
      // Only update when not processing
      //confirmBtn.disabled = !ok;
      //confirmBtn.textContent = ok ? 'Confirm' : 'Reservation expired — reselect';
      const ok = haveMyValidLocks(blocks);

      confirmBtn.disabled = !ok;
      confirmBtn.textContent = ok ? 'Confirm' : 'Reservation expired — reselect';

      // ⛔️ Si expiré, on coupe le “keepalive” pour éviter tout relock
      if (!ok) {
        window.LockManager.heartbeat.stop();
      }


    }, 1500);

    /*modalLockTimer = setInterval(()=>{
      const blocks = currentLock.length ? currentLock : Array.from(selected);
      const ok = haveMyValidLocks(blocks);
      confirmBtn.disabled = !ok;
      if (!ok) confirmBtn.textContent = 'Reservation expired — reselect';
      else     confirmBtn.textContent = 'Confirm';
    }, 1500);*/
  }
  function stopModalMonitor(){
    if (modalLockTimer){ clearInterval(modalLockTimer); modalLockTimer = null; }
  }

  function openModal(){
    modal.classList.remove('hidden');

    // Stats
    const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    const selectedPixels = selected.size * 100;
    const total = selectedPixels * currentPrice;
    modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;

    // Heartbeat for the current lock
    //if (currentLock.length) {
      //window.LockManager.heartbeat.start(currentLock);
    //}
    // Heartbeat ONLY if my locks are still valid now
    //if (currentLock.length && haveMyValidLocks(currentLock, 0)) {
      //window.LockManager.heartbeat.start(currentLock);
    //}
    if (currentLock.length) {
     window.LockManager.heartbeat.start(currentLock, 4000, 180000, {
       maxMs: 300000,          // fenêtre totale max de keepalive: 5 min
       autoUnlock: true,       // libère proprement si on stoppe
       requireActivity: true   // coupe si l’utilisateur est inactif 3 min (IDLE_LIMIT_MS)
     });
   } 
    else {
      window.LockManager.heartbeat.stop(); // do not try to “keepalive” an expired lock
    }

    // Surveiller l'expiration
    startModalMonitor();
  }
  function closeModal(){
    modal.classList.add('hidden');
    window.LockManager.heartbeat.stop();
    stopModalMonitor();
    // reset bouton si besoin
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';
  }

  // Modal close buttons
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

  // ESC to close modal and unlock
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

  // Buy flow
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
      clearSelection();
      for(const i of currentLock){ selected.add(i); grid.children[i].classList.add('sel'); }
      openModal();
      paintAll();
    }catch(e){
      alert('Reservation failed: ' + (e?.message || e));
    }
  });

  // Finalize form — on garde la délégation à finalize-addon.js,
  // mais on ajoute un re-lock défensif si les locks ont expiré.
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const blocks = currentLock.length ? currentLock.slice() : Array.from(selected);

    // Si ma resa a expiré, tenter un re-lock avant de laisser finalize-addon agir
    /*if (!haveMyValidLocks(blocks)) {
      try {
        const lr = await window.LockManager.lock(blocks, 180000);
        locks = window.LockManager.getLocalLocks();
        if (!lr || !lr.ok || !lr.locked || lr.locked.length !== blocks.length) {
          await loadStatus().catch(()=>{});
          closeModal();
          clearSelection();
          paintAll();
          alert('Your reservation expired. Please reselect your pixels.');
          return;
        }
        currentLock = lr.locked.slice();
      } catch {
        await loadStatus().catch(()=>{});
        closeModal();
        clearSelection();
        paintAll();
        alert('Your reservation expired. Please reselect your pixels.');
        return;
      }
    }*/

      //new
      // Si ma resa a expiré → on NE re-lock PAS. On ferme et on force une nouvelle sélection.
if (!haveMyValidLocks(blocks)) {
  window.LockManager.heartbeat.stop();
  await loadStatus().catch(()=>{});
  closeModal();
  clearSelection();
  paintAll();
  alert('Your reservation expired. Please reselect your pixels.');
  return;
}

      //new

    // Tout est bon → laisser finalize-addon.js faire le reste
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

  // Poll status and merge locks via LockManager
  async function loadStatus(){
    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      //sold = s.sold || {};
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

      // Si le modal est ouvert et que mes locks ont sauté → désactiver confirm
      /*if (!modal.classList.contains('hidden')) {
        const blocks = currentLock.length ? currentLock : Array.from(selected);
        const ok = haveMyValidLocks(blocks);
        confirmBtn.disabled = !ok;
        if (!ok) confirmBtn.textContent = 'Reservation expired — reselect';
      }*/
      // If the modal is open and my locks expired, disable confirm
      if (!modal.classList.contains('hidden')) {
        // 👉 Don't touch while finalize flow is running
        if (confirmBtn.textContent !== 'Processing…') {
          const blocks = currentLock.length ? currentLock : Array.from(selected);
          const ok = haveMyValidLocks(blocks);
          confirmBtn.disabled = !ok;
          //if (!ok) confirmBtn.textContent = 'Reservation expired — reselect';
          //new
          
          confirmBtn.textContent = ok ? 'Confirm' : 'Reservation expired — reselect';

          // ⛔️ Si expiré, on coupe le “keepalive” pour éviter tout relock
          if (!ok) {
            window.LockManager.heartbeat.stop();
          }

          //new
          //else     confirmBtn.textContent = 'Confirm';
        }
      }


      paintAll();
    } catch (e) {
      console.warn('[status] failed', e);
    }
  }

  // Initial boot + polling
  (async function init(){
    await loadStatus();
    paintAll();
    setInterval(async ()=>{ await loadStatus(); }, 2500);
  })();

  // Regions overlay (unchanged)
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

  // Expose small debug helper if needed
  window.__debugGetLocks = () => ({ fromManager: window.LockManager.getLocalLocks(), localVar: locks, uid });
})();