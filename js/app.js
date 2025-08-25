// app.js — Version simplifiée pour compatibilité avec la nouvelle architecture
(function(){
  'use strict';

  // Hard requirements
  if (!window.CoreManager) {
    console.error('[app.js] CoreManager is required.');
    return;
  }

  const { apiCall } = window.CoreManager;

  // Variables globales pour compatibilité
  window.sold = {};
  window.locks = {};
  window.regions = {};

  // Helpers
  function formatInt(n){ return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function formatMoney(n){ const [i,d]=Number(n).toFixed(2).split('.'); return '$'+i.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + '.' + d; }

  // DOM elements
  const priceLine = document.getElementById('priceLine');
  const pixelsLeftEl = document.getElementById('pixelsLeft');

  function refreshTopbar(){
    const blocksSold = Object.keys(window.sold).length;
    const pixelsSold = blocksSold * 100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;
    
    if (priceLine) {
      priceLine.textContent = `1 pixel = ${formatMoney(currentPrice)}`;
    }
    
    if (pixelsLeftEl) {
      const totalPixels = 1000000;
      const remaining = totalPixels - pixelsSold;
      pixelsLeftEl.textContent = `${remaining.toLocaleString('en-US')} pixels left`;
    }
  }

  // Poll status and update global state
  async function loadStatus(){
    try{
      const s = await apiCall('/status');
      if (!s || !s.ok) return;

      window.sold = s.sold || {};
      window.locks = s.locks || {};
      window.regions = s.regions || {};

      refreshTopbar();
      
      // Notifier PurchaseUI si elle existe
      if (window.purchaseUI && typeof window.purchaseUI.redrawGrid === 'function') {
        window.purchaseUI.redrawGrid();
      }

      renderRegions();

    } catch (e) {
      console.warn('[status] failed', e);
    }
  }

  // Regions overlay
  function renderRegions() {
    const gridEl = document.getElementById('grid');
    if (!gridEl) return;
    
    // Supprimer anciennes regions
    gridEl.querySelectorAll('.region-overlay').forEach(n => n.remove());
    
    const firstCell = gridEl.querySelector('.cell');
    const size = firstCell ? firstCell.offsetWidth : 10;

    // Mapping regionId -> linkUrl
    const regionLink = {};
    for (const [idx, s] of Object.entries(window.sold || {})) {
      if (s && s.regionId && !regionLink[s.regionId] && s.linkUrl) {
        regionLink[s.regionId] = s.linkUrl;
      }
    }

    // Créer overlays pour chaque région
    for (const [rid, reg] of Object.entries(window.regions || {})) {
      if (!reg || !reg.rect || !reg.imageUrl) continue;
      
      const { x, y, w, h } = reg.rect;
      const idxTL = y * 100 + x;
      const tl = gridEl.querySelector(`.cell[data-idx="${idxTL}"]`);
      if (!tl) continue;
      
      const a = document.createElement('a');
      a.className = 'region-overlay';
      if (regionLink[rid]) { 
        a.href = regionLink[rid]; 
        a.target = '_blank'; 
        a.rel = 'noopener nofollow'; 
      }
      
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

  // Export functions for compatibility
  window.loadStatus = loadStatus;
  window.renderRegions = renderRegions;

  // Initial boot + polling
  (async function init(){
    await loadStatus();
    setInterval(async ()=>{ await loadStatus(); }, 5000); // Plus lent pour éviter le spam
  })();

})();