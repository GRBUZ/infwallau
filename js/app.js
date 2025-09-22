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
  const selectionGuide = document.getElementById('selectionGuide');

  // State
  let sold = {};
  let locks = {};               // local cached view (synced from LockManager)
  let selected = new Set();
  let currentLock = [];         // blocks locked when opening the modal

  // Surveillance d'expiration pendant le modal (simplifié)
  let modalLockTimer = null;
  
  // PATCH: deux sources de prix
  let globalPrice = 1;      // vient de /price.js (toolbar, sélection)
  let reservedPrice = null; // vient de reserve.js (modal)

  

  // Expose la sélection au besoin (pour d'autres modules)
  window.getSelectedIndices = () => Array.from(selected);

  // Helpers
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }
  function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
  function rowColToIdx(r,c){ return r*N + c; }

  function setPayPalHeaderState(state){
  const el = document.getElementById('paypal-button-container');
  if (el) el.className = String(state || '').trim(); // 'active' | 'expired' | ...
  }


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

  //new modern style
  // ====== MISE À JOUR INFO SÉLECTION ======
/*function updateSelectionInfo() {
  const selectionInfo = document.getElementById('selectionInfo');
  if (!selectionInfo) return;
  
  const blocksSold = Object.keys(sold).length;
  const pixelsSold = blocksSold * 100;
  const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
  const selectedPixels = selected.size * 100;
  const total = (selectedPixels * currentPrice).toFixed(2);
  
  if (selectedPixels > 0) {
    selectionInfo.innerHTML = `<span class="count">${selectedPixels.toLocaleString()}</span> pixels sélectionnés • $${total}`;
    selectionInfo.classList.add('show');
  } else {
    selectionInfo.classList.remove('show');
  }
}*/

function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    if (!selectionInfo) return;

    // PATCH: ne plus recalculer depuis sold — utiliser le prix global fourni par le back
    const currentPrice = Number.isFinite(globalPrice) ? globalPrice : 1; // PATCH
    const selectedPixels = selected.size * 100;
    const total = (selectedPixels * currentPrice).toFixed(2);

    if (selectedPixels > 0) {
      selectionInfo.innerHTML = `<span class="count">${selectedPixels.toLocaleString()}</span> pixels sélectionnés • $${total}`;
      selectionInfo.classList.add('show');
    } else {
      selectionInfo.classList.remove('show');
    }
  }
  //new modern style

  /*function refreshTopbar(){
    const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;
    pixelsLeftEl.textContent = `${TOTAL_PIXELS.toLocaleString('en-US')} pixels`;

    buyBtn.textContent = `💎 Claim your spot`; buyBtn.disabled = false;

    // Gérer les animations selon la taille de sélection
  if (selected.size > 150) {
    document.body.classList.add('heavy-selection');
  } else {
    document.body.classList.remove('heavy-selection');
  }
    //new modern style
    updateSelectionInfo();
    //new modern style
  }*/

  function refreshTopbar(){
    // PATCH: prix affiché = currentPrice venant du back (/status)
    const currentPrice = Number.isFinite(globalPrice) ? globalPrice : 1; // PATCH
    priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;     // PATCH
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
  // Masquer le guide au premier clic
  if (selectionGuide) {
    selectionGuide.classList.add('hidden');
  }
  
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

  // --- reset uniquement l'état "app.js" (formulaire de base + input fichier)
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
    // On NE touche PAS à fileInput.dataset.regionId : c'est finalize-addon qui gère.
  }
}
 
  /*function setPayPalEnabled(enabled){
    const c = document.getElementById('paypal-button-container');
    if (!c) return;
    c.style.pointerEvents = enabled ? '' : 'none';
    c.style.opacity = enabled ? '' : '0.45';
    c.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    // (Optionnel) message visuel
    let badge = c.querySelector('.pp-disabled-badge');
    if (!enabled) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'pp-disabled-badge';
        badge.textContent = '⏰ Reservation expired — reselect';
        Object.assign(badge.style, {
          position: 'absolute', inset: '0', display:'grid', placeItems:'center',
          fontSize:'14px', fontWeight:'600', color:'#b91c1c', background:'rgba(255,255,255,0.6)'
        });
        c.style.position = 'relative';
        c.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  }*/
 function setPayPalEnabled(enabled){
  const c = document.getElementById('paypal-button-container');
  if (!c) return;
  c.style.pointerEvents = enabled ? '' : 'none';
  c.style.opacity = enabled ? '' : '0.45';
  c.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  // ⬇️ aligne le header PayPal (un seul système de message)
  setPayPalHeaderState(enabled ? 'active' : 'expired');
}


  // === Garde-fous d'expiration côté client (simplifié) ===
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

  // État optimiste immédiat pour éviter le flash "expired"
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Confirm';
  setPayPalEnabled(true);

  //new refonte messages
  setPayPalHeaderState('active'); // évite un flash "expired"
  //new refonte messages
  const tick = () => {
    // ne rien faire pendant le processing
    if (confirmBtn.textContent === 'Processing…') return;

    const blocks = currentLock.length ? currentLock : Array.from(selected);
    const ok = haveMyValidLocks(blocks, 5000); // grâce 5s

    //confirmBtn.disabled = !ok;
    //confirmBtn.textContent = ok ? 'Confirm' : '⏰ Reservation expired — reselect';
    //setPayPalEnabled(ok);
    confirmBtn.disabled = !ok;
    // Un seul système de message: le header PayPal
    confirmBtn.textContent = 'Confirm';
    setPayPalEnabled(ok); // met 'active' / 'expired' sur le container


    // si on n'a plus de blocks (ex: UI vient d’être vidée), ne coupe pas le heartbeat ici
    if (!ok && blocks && blocks.length) {
      window.LockManager.heartbeat.stop();
    }
  };

  // On laisse ~1.2s au cache local / heartbeat pour se stabiliser, puis on lance le polling
  const start = () => {
    tick();
    // on stocke l’ID de l’interval dans la même var pour pouvoir le clear
    modalLockTimer = setInterval(tick, 5000);
  };

  // premier tick après warmup, sinon flicker
  modalLockTimer = setTimeout(start, Math.max(0, warmupMs|0));
}

  function stopModalMonitor(){
  if (modalLockTimer){
    // peu importe si c'était un timeout ou un interval → on clear les deux
    try { clearTimeout(modalLockTimer); } catch {}
    try { clearInterval(modalLockTimer); } catch {}
    modalLockTimer = null;
  }
}

  /*function openModal(){
    resetModalAppState();

    // Notifier les autres modules (finalize-addon.js) pour leur propre cleanup
    document.dispatchEvent(new CustomEvent('modal:opening'));
    
    modal.classList.remove('hidden');

    // Stats
    //const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
    //const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    const selectedPixels = selected.size * 100;
	// PATCH: dans le modal → utiliser reservedPrice si dispo
    const unit = reservedPrice != null ? reservedPrice : globalPrice;
    const total = selectedPixels * unit;
    //const total = selectedPixels * currentPrice;
    modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;

    // Heartbeat pour maintenir la réservation (3 minutes + renouvellement étapes)
    if (currentLock.length) {
      window.LockManager.heartbeat.start(currentLock, 30000, 180000, {
        maxMs: 180000,          // 3 minutes max au total
        autoUnlock: true,       // libère proprement si on stoppe
        requireActivity: true   // coupe si l'utilisateur est inactif 2 min
      });
    } else {
      window.LockManager.heartbeat.stop();
    }

    // Surveiller l'expiration (plus permissif)
    startModalMonitor();
  }*/
 function openModal(){
    resetModalAppState();

    document.dispatchEvent(new CustomEvent('modal:opening'));
    modal.classList.remove('hidden');

    // PATCH: prix du modal = prix garanti de la résa si présent, sinon prix global
    const unit = (reservedPrice != null && Number.isFinite(reservedPrice))
      ? reservedPrice
      : (Number.isFinite(globalPrice) ? globalPrice : 1);                // PATCH

    const selectedPixels = selected.size * 100;
    const total = selectedPixels * unit;                                 // PATCH
    modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;

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
    reservedPrice = null; // PATCH: on libère le prix garanti à la fermeture du modal
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
    //if(!selected.size) return;

    //warning
    // Vérifier s'il y a une sélection
  if(!selected.size) {
    // Afficher le message d'avertissement
    const warningMessage = document.getElementById('warningMessage');
    if (warningMessage) {
      warningMessage.classList.add('show');
      warningMessage.classList.add('shake');
      
      // Masquer après 2 secondes
      setTimeout(() => {
        warningMessage.classList.remove('show');
      }, 2000);
      
      // Retirer l'animation shake
      setTimeout(() => {
        warningMessage.classList.remove('shake');
      }, 500);
    }
    return;
  }
    //warning
    const want = Array.from(selected);
    try{
      // Réservation initiale avec 3 minutes pleines
      const lr = await window.LockManager.lock(want, 180000);
      locks = window.LockManager.getLocalLocks();

      if (!lr || !lr.ok || (lr.conflicts && lr.conflicts.length>0) || (lr.locked && lr.locked.length !== want.length)){
        const rect = rectFromIndices(want);
        if (rect) showInvalidRect(rect.r0, rect.c0, rect.r1, rect.c1, 1200);
        clearSelection(); paintAll();
        return;
      }

      currentLock = (lr.locked || []).slice();
	  
	  // PATCH: si la RPC reserve.js renvoie unitPrice, on le stocke
      if (lr.unitPrice != null) reservedPrice = lr.unitPrice;
	  
      clearSelection();
      for(const i of currentLock){ selected.add(i); grid.children[i].classList.add('sel'); }
      openModal();
      paintAll();
    }catch(e){
      alert('Reservation failed: ' + (e?.message || e));
    }
  });

  // Finalize form — on garde la délégation à finalize-addon.js,
  // avec validation simplifiée
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const blocks = currentLock.length ? currentLock.slice() : Array.from(selected);

    // Si ma résa a expiré → on NE re-lock PAS. On ferme et on force une nouvelle sélection.
    if (!haveMyValidLocks(blocks, 1000)) { // Grâce de 1 seconde seulement ici
      window.LockManager.heartbeat.stop();
      await loadStatus().catch(()=>{});
      closeModal();
      clearSelection();
      paintAll();
      //alert('Your reservation expired. Please reselect your pixels.');
      return;
    }

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

      // PATCH: ingérer le prix courant depuis le back
      if (typeof s.currentPrice === 'number') {        // PATCH
        globalPrice = s.currentPrice;                   // PATCH
      }                                                 // PATCH

      if (!modal.classList.contains('hidden')) {
        if (confirmBtn.textContent !== 'Processing…') {
          const blocks = currentLock.length ? currentLock : Array.from(selected);
          const ok = haveMyValidLocks(blocks, 5000);
          confirmBtn.disabled = !ok;
          confirmBtn.textContent = 'Confirm';
          setPayPalEnabled(ok);
          if (!ok) {
            window.LockManager.heartbeat.stop();
          }
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
  // Essayer les deux formats (camelCase et snake_case)
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

  // Expose small debug helper if needed
  window.__debugGetLocks = () => ({ fromManager: window.LockManager.getLocalLocks(), localVar: locks, uid });
})();