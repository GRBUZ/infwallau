(function(){
  'use strict';

  const { uid, apiCall } = window.CoreManager;

  const N = 100;
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

  let sold = {};
  let locks = {};
  let selected = new Set();
  let currentLock = [];

  let modalLockTimer = null;

  // PATCH: deux sources de prix
  let globalPrice = 1;      // vient de /price.js (toolbar, sélection)
  let reservedPrice = null; // vient de reserve.js (modal)

  // Helpers
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }

  // ====== MISE À JOUR INFO SÉLECTION ======
  function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    if (!selectionInfo) return;

    const selectedPixels = selected.size * 100;
    const total = (selectedPixels * globalPrice).toFixed(2);

    if (selectedPixels > 0) {
      selectionInfo.innerHTML = `<span class="count">${selectedPixels.toLocaleString()}</span> pixels sélectionnés • $${total}`;
      selectionInfo.classList.add('show');
    } else {
      selectionInfo.classList.remove('show');
    }
  }

  function refreshTopbar(){
    priceLine.textContent = `1 pixel = ${formatMoney(globalPrice)}`;
    pixelsLeftEl.textContent = `${TOTAL_PIXELS.toLocaleString('en-US')} pixels`;
    buyBtn.textContent = `💎 Claim your spot`;
    buyBtn.disabled = false;

    if (selected.size > 150) {
      document.body.classList.add('heavy-selection');
    } else {
      document.body.classList.remove('heavy-selection');
    }
    updateSelectionInfo();
  }

  function openModal(){
    modal.classList.remove('hidden');

    const selectedPixels = selected.size * 100;
    // PATCH: dans le modal → utiliser reservedPrice si dispo
    const unit = reservedPrice != null ? reservedPrice : globalPrice;
    const total = selectedPixels * unit;

    modalStats.textContent = `${formatInt(selectedPixels)} px — ${formatMoney(total)}`;
    // … le reste inchangé
  }

  // Buy flow
  buyBtn.addEventListener('click', async ()=>{
    if(!selected.size) { /* warning UI */ return; }
    const want = Array.from(selected);
    try{
      const lr = await window.LockManager.lock(want, 180000);
      locks = window.LockManager.getLocalLocks();

      if (!lr || !lr.ok || (lr.conflicts && lr.conflicts.length>0) || (lr.locked && lr.locked.length !== want.length)){
        clearSelection(); return;
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

  // Poll status and merge locks via LockManager
  async function loadStatus(){
    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      if (s.sold && typeof s.sold === 'object') {
        sold = s.sold;
      }

      locks = window.LockManager.merge(s.locks || {});

      // PATCH: récupérer prix courant depuis /price.js si dispo
      if (s.currentPrice) {
        globalPrice = s.currentPrice;
      }

      paintAll();
    } catch (e) {
      console.warn('[status] failed', e);
    }
  }

  (async function init(){
    await loadStatus();
    paintAll();
    setInterval(async ()=>{ await loadStatus(); }, 2500);
  })();

})();
