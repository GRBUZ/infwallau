// app.js — robust locks: local-wins merge + heartbeat during modal
// Anti-flicker pour les locks d’autrui
const othersLastSeen = Object.create(null); // idx -> lastSeen timestamp
const OTHERS_GRACE_MS = 5000;              // garde un lock d’autrui jusqu’à 5s s’il “disparaît” ponctuellement
const othersHold = Object.create(null);    // idx -> expiresAt (timestamp)


const N = 100;
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

function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }

  // 1. UID génération plus robuste pour Edge
const uid = (()=>{ 
    const k='iw_uid'; 
    let v=localStorage.getItem(k); 
    if(!v){ 
        // Meilleure compatibilité Edge
        if (window.crypto && window.crypto.randomUUID) {
            v = crypto.randomUUID();
        } else if (window.crypto && window.crypto.getRandomValues) {
            // Fallback pour Edge anciennes versions
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            v = Array.from(arr, byte => byte.toString(16).padStart(2, '0')).join('');
        } else {
            // Fallback ultime
            v = Date.now().toString(36) + Math.random().toString(36).slice(2);
        }
        localStorage.setItem(k,v);
    } 
    window.uid=v; 
    return v; 
})();

let sold = {};
let locks = {};
let selected = new Set();
let holdIncomingLocksUntil = 0;   // fenêtre pendant laquelle on NE TOUCHE PAS aux locks venant du serveur


// Heartbeat while modal open
let currentLock = [];
let heartbeat = null;
function startHeartbeat(){
  stopHeartbeat();
  heartbeat = setInterval(async ()=>{
    if (!currentLock.length) return;
    try { await reserve(currentLock); } catch {}
  }, 4000); // 25s
}
function stopHeartbeat(){
  if (heartbeat){ clearInterval(heartbeat); heartbeat=null; }
}

// Merge helper: keep our local locks (same uid) if longer
function mergeLocksPreferLocal(local, incoming){
  const now = Date.now();
  const out = Object.create(null);

  // 1) Mes locks à moi (uid === uid) : on garde s'ils sont encore valides
  for (const [k, l] of Object.entries(local || {})) {
    if (l && l.uid === uid && l.until > now) {
      out[k] = { uid: l.uid, until: l.until };
    }
  }

  // 2) Locks entrants (serveur) : vérité pour les autres + on note "vu à now"
  for (const [k, l] of Object.entries(incoming || {})) {
    if (l && l.until > now) {
      out[k] = { uid: l.uid, until: l.until };
      othersLastSeen[k] = now;
    }
  }

  // 3) Si un lock d’autrui a "disparu" à ce poll, on le garde en grâce qq secondes
  for (const [k, l] of Object.entries(local || {})) {
    if (!out[k] && l && l.uid !== uid && l.until > now) {
      const last = othersLastSeen[k] || 0;
      if (now - last < OTHERS_GRACE_MS) {
        out[k] = { uid: l.uid, until: l.until }; // on le maintient temporairement
      } else {
        delete othersLastSeen[k]; // grâce expirée : on laisse tomber
      }
    }
  }

  return out;
}


let isDragging=false, dragStartIdx=-1, movedDuringDrag=false, lastDragIdx=-1, suppressNextClick=false;
let blockedDuringDrag = false;

(function build(){
  const frag=document.createDocumentFragment();
  for(let i=0;i<N*N;i++){ const d=document.createElement('div'); d.className='cell'; d.dataset.idx=i; frag.appendChild(d); }
  grid.appendChild(frag);
  const cs = getComputedStyle(grid);
  if (cs.position === 'static') grid.style.position = 'relative';
})();

const invalidEl = document.createElement('div');
invalidEl.id = 'invalidRect';
Object.assign(invalidEl.style, { position:'absolute', border:'2px solid #ef4444', background:'rgba(239,68,68,0.08)', pointerEvents:'none', display:'none', zIndex:'999' });
const invalidIcon = document.createElement('div');
Object.assign(invalidIcon.style, { position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:'1000' });
invalidIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.95)"></circle><circle cx="12" cy="12" r="9" fill="none" stroke="#ef4444" stroke-width="2"></circle><line x1="7" y1="17" x2="17" y2="7" stroke="#ef4444" stroke-width="2" stroke-linecap="round"></line></svg>`;
invalidEl.appendChild(invalidIcon);
grid.appendChild(invalidEl);

function getCellSize(){ const cell=grid.children[0]; if(!cell) return {w:10,h:10}; const r=cell.getBoundingClientRect(); return { w:Math.max(1,Math.round(r.width)), h:Math.max(1,Math.round(r.height)) }; }
function showInvalidRect(r0,c0,r1,c1, ttl=900){
  const { w:CW, h:CH } = getCellSize();
  const left=c0*CW, top=r0*CH, w=(c1-c0+1)*CW, h=(r1-r0+1)*CH;
  Object.assign(invalidEl.style,{ left:left+'px', top:top+'px', width:w+'px', height:h+'px', display:'block' });
  const size = Math.max(16, Math.min(64, Math.floor(Math.min(w, h) * 0.7)));
  const svg = invalidIcon.querySelector('svg'); svg.style.width=size+'px'; svg.style.height=size+'px';
  if (ttl>0) setTimeout(()=>{ invalidEl.style.display='none'; }, ttl);
}
function hideInvalidRect(){ invalidEl.style.display='none'; }

function idxToRowCol(idx){ return [Math.floor(idx/N), idx%N]; }
function rowColToIdx(r,c){ return r*N + c; }
function isBlockedCell(idx){
  if (sold[idx]) return true;
  const l = locks[idx];
  return !!(l && l.until > Date.now() && l.uid !== uid);
}

function paintCell(idx){
  const d=grid.children[idx]; const s=sold[idx]; const l=locks[idx];
  // DEBUG TEMPORAIRE pour quelques cellules
  if (idx < 5 || (l && l.until > Date.now())) {
    console.log(`🎨 [paintCell] idx=${idx}:`, {
      sold: !!s,
      lock: l ? {uid: l.uid, until: new Date(l.until).toLocaleTimeString()} : null,
      isReserved: !!(l && l.until > Date.now()),
      isOtherUser: !!(l && l.until > Date.now() && l.uid !== uid)
    });
  }
  
  const reserved = l && l.until > Date.now() && !s;
  const reservedByOther = reserved && l.uid !== uid;
  d.classList.toggle('sold', !!s);
  d.classList.toggle('pending', !!reservedByOther);
  d.classList.toggle('sel', selected.has(idx));
  
  if (s && s.imageUrl && s.rect && Number.isInteger(s.rect.x)){
    const [r,c]=idxToRowCol(idx); const { w:CW, h:CH }=getCellSize();
    const offX=(c - s.rect.x)*CW, offY=(r - s.rect.y)*CH;
    d.style.backgroundImage=`url(${s.imageUrl})`;
    d.style.backgroundSize=`${s.rect.w*CW}px ${s.rect.h*CH}px`;
    d.style.backgroundPosition=`-${offX}px -${offY}px`;
  } else {
    d.style.backgroundImage=''; d.style.backgroundSize=''; d.style.backgroundPosition='';
  }
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
  //const left = TOTAL_PIXELS - pixelsSold;
  //pixelsLeftEl.textContent = `${formatInt(left)} pixels left`;
  // Afficher toujours le total fixe "1,000,000 pixels"
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
  selected.clear(); refreshTopbar();
}

function selectRect(aIdx,bIdx){
  const [ar,ac]=idxToRowCol(aIdx), [br,bc]=idxToRowCol(bIdx);
  const r0=Math.min(ar,br), r1=Math.max(ar,br), c0=Math.min(ac,bc), c1=Math.max(ac,bc);
  blockedDuringDrag = false;
  for(let r=r0;r<=r1;r++){ for(let c=c0;c<=c1;c++){ const idx=rowColToIdx(r,c); if (isBlockedCell(idx)) { blockedDuringDrag = true; break; } } if (blockedDuringDrag) break; }
  if (blockedDuringDrag){ clearSelection(); showInvalidRect(r0,c0,r1,c1,900); return; }
  hideInvalidRect(); clearSelection();
  for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){ const idx=rowColToIdx(r,c); selected.add(idx); }
  for(const i of selected) grid.children[i].classList.add('sel');
  refreshTopbar();
}

function toggleCell(idx){
  if (isBlockedCell(idx)) return;
  const d=grid.children[idx];
  if (selected.has(idx)) { selected.delete(idx); d.classList.remove('sel'); }
  else { selected.add(idx); d.classList.add('sel'); }
  refreshTopbar();
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

function openModal(){ 
  modal.classList.remove('hidden');
  const blocksSold=Object.keys(sold).length, pixelsSold=blocksSold*100;
  const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
  const selectedPixels = selected.size * 100;
  const total = selectedPixels * currentPrice;
  modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;
  
  // ✅ UN SEUL heartbeat !
  if (currentLock.length) {
    startHeartbeat();
    console.log('[MODAL] Started heartbeat for', currentLock.length, 'blocks');
  }
}

function closeModal(){ 
  modal.classList.add('hidden'); 
  stopHeartbeat(); // ← C'est suffisant, pas besoin de répéter
}

document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', async () => {
  // PRENDS un snapshot AVANT
  const toRelease = (currentLock && currentLock.length) ? currentLock.slice() : Array.from(selected);

  // 🔒 Couper toute relock possible AVANT d’unlock
  currentLock = [];
  stopHeartbeat();

  // Libère au serveur
  if (toRelease.length) {
    try { await unlock(toRelease); } catch {}
  }

  closeModal();
  clearSelection();
  setTimeout(async () => { await loadStatus(); paintAll(); }, 150);
}));


window.addEventListener('keydown', async (e)=>{
  if(e.key==='Escape' && !modal.classList.contains('hidden')){
    const toRelease = (currentLock && currentLock.length) ? currentLock.slice() : Array.from(selected);

    currentLock = [];
    stopHeartbeat();

    if (toRelease.length) {
      try { await unlock(toRelease); } catch {}
    }

    closeModal();
    clearSelection();
    setTimeout(async () => { await loadStatus(); paintAll(); }, 150);
  }
});


async function reserve(indices){
  const r = await fetch('/.netlify/functions/reserve', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ uid, blocks: indices, ttl: 300000 })
  });
  const res=await r.json();
  if(!r.ok||!res.ok) throw new Error(res.error||('HTTP '+r.status));

  // Ensure local locks reflect what we just reserved, with a full TTL
  const now = Date.now();
  for (const i of (res.locked||[])){
    locks[i] = { uid, until: now + 300000 };
  }
  // Merge incoming (others' locks) without dropping ours
  locks = mergeLocksPreferLocal(locks, res.locks || {});
  paintAll();
  
  // Empêche loadStatus() d’écraser nos locks pendant 8s (latence GitHub/Netlify)
  holdIncomingLocksUntil = Date.now() + 8000;
  // Souviens-toi de ce que TU viens de réserver (pour le heartbeat et la finalisation)
  currentLock = Array.isArray(res.locked) ? res.locked.slice() : [];
  return res;
}

async function unlock(indices){
  console.log('🔓 [UNLOCK] Début pour', indices.length, 'blocs:', indices);
  
  const r = await fetch('/.netlify/functions/unlock',{
    method:'POST', 
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ uid, blocks: indices })
  });
  
  console.log('🔓 [UNLOCK] Réponse HTTP:', r.status, r.ok);
  
  const res = await r.json(); 
  console.log('🔓 [UNLOCK] Réponse serveur:', res);
  
  if(!r.ok || !res.ok) {
    console.error('❌ [UNLOCK] Échec:', res.error || ('HTTP '+r.status));
    throw new Error(res.error || ('HTTP '+r.status));
  }
  
  // ✅ CORRECTION CRITIQUE : Mettre à jour les locks ET supprimer la protection
  locks = res.locks || {}; 
  holdIncomingLocksUntil = 0; // ✅ Supprimer immédiatement la protection !
  
  console.log('🔄 [UNLOCK] Locks mis à jour:', Object.keys(locks).length);
  console.log('🔄 [UNLOCK] Protection supprimée');
  
  paintAll(); 
  return res;
}


buyBtn.addEventListener('click', async ()=>{
  if(!selected.size) return;
  const want = Array.from(selected);
  try{
    const got = await reserve(want);
    if ((got.conflicts && got.conflicts.length>0) || (got.locked && got.locked.length !== want.length)){
      const rect = rectFromIndices(want);
      if (rect) showInvalidRect(rect.r0, rect.c0, rect.r1, rect.c1, 1200);
      clearSelection(); paintAll();
      return;
    }
    // remember our current lock and start heartbeat in modal
    currentLock = got.locked.slice();
    clearSelection();
    for(const i of got.locked){ selected.add(i); grid.children[i].classList.add('sel'); }
    openModal();
  }catch(e){
    alert('Reservation failed: ' + (e?.message || e));
  }
});

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  let linkUrl = linkInput.value.trim();
  const name  = nameInput.value.trim();
  const email = emailInput.value.trim();
  if(!linkUrl || !name || !email){ return; }
  if (!/^https?:\/\//i.test(linkUrl)) linkUrl = 'https://' + linkUrl;

  confirmBtn.disabled=true; confirmBtn.textContent='Processing…';
  try{
    const blocks = currentLock.length ? currentLock.slice() : Array.from(selected);
    const r = await fetch('/.netlify/functions/finalize', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ uid, blocks, linkUrl, name, email })
    });
    const res = await r.json();
    if (r.status===409 && res.taken){
      const rect = rectFromIndices(blocks);
      if (rect) showInvalidRect(rect.r0, rect.c0, rect.r1, rect.c1, 1200);
      clearSelection(); paintAll();
      return;
    }
    if (!r.ok || !res.ok) throw new Error(res.error || ('HTTP '+r.status));
    sold = res.soldMap || sold;
    try{ await unlock(blocks); }catch{}
    currentLock = []; stopHeartbeat();
    clearSelection(); paintAll(); closeModal();
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

// Remplacez le début de loadStatus() par ceci pour voir la réponse brute :

// CORRECTION CRITIQUE : Nettoyer les locks expirés dans loadStatus
async function loadStatus(){
  try{
    const r = await fetch('/.netlify/functions/status', { cache:'no-store' });
    const s = await r.json();
    if (!s || !s.ok) return;

    // 1) Màj des ventes
    sold = s.sold || {};

    const incoming = s.locks || {};
    const now = Date.now();

    // 2) Renouvelle la "dernière vue" pour les locks d'AUTRUI présents dans la réponse
    for (const [k, l] of Object.entries(incoming)) {
      if (!l) continue;
      if (l.uid !== uid && l.until > now) {
        othersHold[k] = now + OTHERS_GRACE_MS;  // on les gardera au moins jusque-là
      }
    }

    // 3) Purge des holds expirés (pas vus depuis > OTHERS_GRACE_MS)
    for (const [k, exp] of Object.entries(othersHold)) {
      if (exp <= now) delete othersHold[k];
    }

    // 4) Construit la carte de locks "visibles"
    const visible = Object.create(null);

    // a) base = locks renvoyés par le serveur (si encore valides)
    for (const [k, l] of Object.entries(incoming)) {
      if (l && l.until > now) visible[k] = { uid: l.uid, until: l.until };
    }

    // b) ajoute les holds (locks d'autrui "aperçus récemment") absents du snapshot courant
    for (const [k, exp] of Object.entries(othersHold)) {
      if (!visible[k]) visible[k] = { uid: 'other', until: exp };
    }

    // c) par-dessus, impose MES locks locaux s'ils sont plus longs/encore valides
    for (const [k, l] of Object.entries(locks || {})) {
      if (l && l.uid === uid && l.until > now) {
        const cur = visible[k];
        if (!cur || cur.uid !== uid || l.until > (cur.until || 0)) {
          visible[k] = { uid: l.uid, until: l.until };
        }
      }
    }

    // 5) remplace la carte active et repeins
    locks = visible;
    paintAll();
  } catch {}
}

(async function init(){ 
  await loadStatus(); paintAll(); 
  /*setInterval(async()=>{ await loadStatus(); paintAll(); }, 2500); */
  setInterval(async()=>{ 
  console.log('⏰ [POLLING PRINCIPAL] Début cycle');
  await loadStatus(); 
  paintAll(); 
  console.log('⏰ [POLLING PRINCIPAL] Fin cycle - locks actuels:', Object.keys(locks).length);
}, 2500);

}

)();

window.__regionsPoll && clearInterval(window.__regionsPoll);
window.__regionsPoll = setInterval(async () => {
  try {
    console.log('🌍 [REGIONS] Début polling regions...');
    const res = await fetch('/.netlify/functions/status?ts=' + Date.now());
    const data = await res.json();
    
    // SEULEMENT regions et sold, PAS de locks !
    window.sold = data.sold || {};
    window.regions = data.regions || {};
    
    console.log('🌍 [REGIONS] Mise à jour:', {
      regions: Object.keys(window.regions).length,
      sold: Object.keys(window.sold).length
    });
    
    if (typeof window.renderRegions === 'function') window.renderRegions();
    console.log('🌍 [REGIONS] Terminé');
  } catch (e) { 
    console.warn('❌ [REGIONS] Erreur:', e);
  }
}, 15000);

// Regions overlay (kept)
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

// Initial regions fetch + periodic refresh (15s)
(async function regionsBootOnce(){
  try {
    // Utilise la même fonction que le polling principal
    await loadStatus();
    paintAll(); // S'assurer que tout est rendu
    console.log('[regions] initial load via loadStatus()');
  } catch (e) { 
    console.warn('[regions] initial load failed', e); 
  }
})();
console.log('✅ Unified polling implemented - no more timing conflicts!');
/*console.log('app.js (robust locks + heartbeat) loaded');*/

// BONUS : Fonction de nettoyage manuel pour débugger
function debugCleanExpiredLocks() {
  const now = Date.now();
  const before = Object.keys(locks).length;
  
  for (const [k, l] of Object.entries(locks)) {
    if (!l || l.until <= now) {
      delete locks[k];
      console.log(`🧹 [DEBUG] Supprimé lock expiré ${k}`);
    }
  }
  
  const after = Object.keys(locks).length;
  console.log(`🧹 [DEBUG] Nettoyage: ${before} -> ${after} locks`);
  paintAll();
}