// app-refactored.js - Version unifiée sans modal
(function() {
  'use strict';

  // ===== CONFIGURATION & DEPENDENCIES =====
  if (!window.CoreManager || !window.LockManager) {
    console.error('[App] Missing dependencies');
    return;
  }

  const { uid, apiCall } = window.CoreManager;
  const N = 100;
  const TOTAL_PIXELS = 1_000_000;
  const locale = navigator.language || 'en-US';

  // ===== STATE MANAGEMENT =====
  const AppState = {
    view: 'grid', // 'grid' | 'checkout'
    checkoutStep: 1, // 1: form, 2: payment, 3: success
    
    // Grid state
    sold: {},
    locks: {},
    regions: {},
    selected: new Set(),
    globalPrice: 1,
    
    // Checkout state
    currentOrder: null,
    orderData: {
      blocks: [],
      name: '',
      linkUrl: '',
      imageUrl: null,
      totalAmount: 0,
      unitPrice: 0
    },
    
    // Timer state
    lockTimer: null,
    lockExpiry: null
  };

  // ===== DOM REFERENCES =====
  const DOM = {
    // Views
    mainContainer: document.getElementById('mainContainer'),
    gridView: document.getElementById('gridView'),
    checkoutView: document.getElementById('checkoutView'),
    
    // Grid
    grid: document.getElementById('grid'),
    buyBtn: document.getElementById('buyBtn'),
    priceLine: document.getElementById('priceLine'),
    pixelsLeft: document.getElementById('pixelsLeft'),
    selectionInfo: document.getElementById('selectionInfo'),
    warningMessage: document.getElementById('warningMessage'),
    
    // Checkout
    checkoutForm: document.getElementById('checkoutForm'),
    nameInput: document.getElementById('name'),
    linkInput: document.getElementById('link'),
    imageInput: document.getElementById('image'),
    imagePreview: document.getElementById('imagePreview'),
    
    // Summary
    summaryPixels: document.getElementById('summaryPixels'),
    summaryPrice: document.getElementById('summaryPrice'),
    summaryTotal: document.getElementById('summaryTotal'),
    timerValue: document.getElementById('timerValue'),
    pixelPreview: document.getElementById('pixelPreview'),
    
    // Buttons
    backToGrid: document.getElementById('backToGrid'),
    proceedToPayment: document.getElementById('proceedToPayment'),
    
    // Steps
    steps: {
      1: document.getElementById('step1'),
      2: document.getElementById('step2'),
      3: document.getElementById('step3')
    },
    progressSteps: document.querySelectorAll('.progress-step')
  };

  // ===== VIEW MANAGEMENT =====
  const ViewManager = {
    switchTo(view) {
      AppState.view = view;
      DOM.mainContainer.dataset.view = view;
      
      if (view === 'grid') {
        DOM.gridView.classList.add('active');
        DOM.checkoutView.classList.remove('active');
        this.stopLockTimer();
      } else {
        DOM.gridView.classList.remove('active');
        DOM.checkoutView.classList.add('active');
        this.startLockTimer();
        this.updateSummary();
      }
    },
    
    setCheckoutStep(step) {
      AppState.checkoutStep = step;
      
      // Update steps visibility
      Object.entries(DOM.steps).forEach(([num, el]) => {
        el.classList.toggle('active', parseInt(num) === step);
      });
      
      // Update progress bar
      DOM.progressSteps.forEach((el, i) => {
        const stepNum = i + 1;
        el.classList.toggle('active', stepNum <= step);
        el.classList.toggle('completed', stepNum < step);
      });
    },
    
    updateSummary() {
      const { blocks, totalAmount, unitPrice } = AppState.orderData;
      const pixels = blocks.length * 100;
      
      DOM.summaryPixels.textContent = pixels.toLocaleString(locale);
      DOM.summaryPrice.textContent = `$${unitPrice.toFixed(2)}`;
      DOM.summaryTotal.textContent = `$${totalAmount.toFixed(2)}`;
      
      // Update pixel preview
      this.renderPixelPreview();
    },
    
    renderPixelPreview() {
      const { blocks } = AppState.orderData;
      if (!blocks.length) return;
      
      // Create mini grid visualization
      const minRow = Math.min(...blocks.map(i => Math.floor(i / N)));
      const maxRow = Math.max(...blocks.map(i => Math.floor(i / N)));
      const minCol = Math.min(...blocks.map(i => i % N));
      const maxCol = Math.max(...blocks.map(i => i % N));
      
      const width = maxCol - minCol + 1;
      const height = maxRow - minRow + 1;
      
      DOM.pixelPreview.innerHTML = `
        <div class="preview-grid" style="--cols: ${width}; --rows: ${height}">
          ${blocks.map(idx => {
            const r = Math.floor(idx / N) - minRow;
            const c = (idx % N) - minCol;
            return `<div class="preview-pixel" style="--r: ${r}; --c: ${c}"></div>`;
          }).join('')}
        </div>
        <div class="preview-info">${width}×${height} blocks</div>
      `;
    },
    
    startLockTimer() {
      this.stopLockTimer();
      AppState.lockExpiry = Date.now() + 180000; // 3 minutes
      
      const updateTimer = () => {
        const remaining = Math.max(0, AppState.lockExpiry - Date.now());
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        
        DOM.timerValue.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        if (remaining <= 0) {
          this.handleLockExpired();
        }
      };
      
      updateTimer();
      AppState.lockTimer = setInterval(updateTimer, 1000);
    },
    
    stopLockTimer() {
      if (AppState.lockTimer) {
        clearInterval(AppState.lockTimer);
        AppState.lockTimer = null;
      }
    },
    
    handleLockExpired() {
      this.stopLockTimer();
      alert('Your reservation has expired. Please select your pixels again.');
      this.returnToGrid();
    },
    
    async returnToGrid() {
      // Unlock current blocks
      if (AppState.orderData.blocks.length) {
        try {
          await window.LockManager.unlock(AppState.orderData.blocks);
        } catch (e) {
          console.warn('[Unlock] Failed:', e);
        }
      }
      
      // Reset state
      AppState.orderData = {
        blocks: [],
        name: '',
        linkUrl: '',
        imageUrl: null,
        totalAmount: 0,
        unitPrice: 0
      };
      
      AppState.selected.clear();
      GridManager.clearSelection();
      
      // Switch view
      this.switchTo('grid');
      this.setCheckoutStep(1);
      
      // Refresh status
      await StatusManager.load();
      GridManager.paintAll();
    }
  };

  // ===== GRID MANAGEMENT =====
  const GridManager = {
    init() {
      // Build grid
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N * N; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.idx = i;
        frag.appendChild(cell);
      }
      DOM.grid.appendChild(frag);
      
      // Setup event handlers
      this.setupEvents();
    },
    
    setupEvents() {
      let isDragging = false;
      let dragStartIdx = -1;
      let lastDragIdx = -1;
      let suppressClick = false;
      
      const idxFromXY = (x, y) => {
        const rect = DOM.grid.getBoundingClientRect();
        const cell = DOM.grid.children[0];
        if (!cell) return -1;
        
        const cellRect = cell.getBoundingClientRect();
        const cellSize = cellRect.width;
        
        const col = Math.floor((x - rect.left) / cellSize);
        const row = Math.floor((y - rect.top) / cellSize);
        
        if (col < 0 || col >= N || row < 0 || row >= N) return -1;
        return row * N + col;
      };
      
      DOM.grid.addEventListener('mousedown', (e) => {
        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx < 0) return;
        
        isDragging = true;
        dragStartIdx = idx;
        lastDragIdx = idx;
        this.selectRect(idx, idx);
        e.preventDefault();
      });
      
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx < 0 || idx === lastDragIdx) return;
        
        lastDragIdx = idx;
        suppressClick = true;
        this.selectRect(dragStartIdx, idx);
      });
      
      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          dragStartIdx = -1;
          lastDragIdx = -1;
        }
      });
      
      DOM.grid.addEventListener('click', (e) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        
        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx >= 0) this.toggleCell(idx);
      });
    },
    
    selectRect(startIdx, endIdx) {
      const [sr, sc] = [Math.floor(startIdx / N), startIdx % N];
      const [er, ec] = [Math.floor(endIdx / N), endIdx % N];
      
      const r0 = Math.min(sr, er), r1 = Math.max(sr, er);
      const c0 = Math.min(sc, ec), c1 = Math.max(sc, ec);
      
      // Check for blocked cells
      let blocked = false;
      for (let r = r0; r <= r1 && !blocked; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * N + c;
          if (this.isBlocked(idx)) {
            blocked = true;
            break;
          }
        }
      }
      
      if (blocked) {
        this.clearSelection();
        this.showInvalidArea(r0, c0, r1, c1);
        return;
      }
      
      this.clearSelection();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * N + c;
          AppState.selected.add(idx);
          DOM.grid.children[idx].classList.add('sel');
        }
      }
      
      this.updateSelectionInfo();
    },
    
    toggleCell(idx) {
      if (this.isBlocked(idx)) return;
      
      if (AppState.selected.has(idx)) {
        AppState.selected.delete(idx);
        DOM.grid.children[idx].classList.remove('sel');
      } else {
        AppState.selected.add(idx);
        DOM.grid.children[idx].classList.add('sel');
      }
      
      this.updateSelectionInfo();
    },
    
    clearSelection() {
      for (const idx of AppState.selected) {
        DOM.grid.children[idx].classList.remove('sel');
      }
      AppState.selected.clear();
      this.updateSelectionInfo();
    },
    
    isBlocked(idx) {
      if (AppState.sold[idx]) return true;
      const lock = AppState.locks[idx];
      return !!(lock && lock.until > Date.now() && lock.uid !== uid);
    },
    
    paintCell(idx) {
      const cell = DOM.grid.children[idx];
      const sold = AppState.sold[idx];
      const lock = AppState.locks[idx];
      const lockedByOther = lock && lock.until > Date.now() && lock.uid !== uid;
      
      cell.classList.toggle('sold', !!sold);
      cell.classList.toggle('pending', !!lockedByOther);
      cell.classList.toggle('sel', AppState.selected.has(idx));
      
      if (sold) {
        cell.title = (sold.name || '') + ' • ' + (sold.linkUrl || '');
      } else {
        cell.title = '';
      }
    },
    
    paintAll() {
      for (let i = 0; i < N * N; i++) {
        this.paintCell(i);
      }
      this.updateTopbar();
    },
    
    updateSelectionInfo() {
      const count = AppState.selected.size * 100;
      if (count === 0) {
        DOM.selectionInfo.classList.remove('show');
        return;
      }
      
      const total = this.calculateTotal(AppState.selected.size * 100);
      DOM.selectionInfo.innerHTML = 
        `<span class="count">${count.toLocaleString(locale)}</span> pixels • $${total.toFixed(2)}`;
      DOM.selectionInfo.classList.add('show');
    },
    
    updateTopbar() {
      DOM.priceLine.textContent = `1 pixel = $${AppState.globalPrice.toFixed(2)}`;
      DOM.pixelsLeft.textContent = `${TOTAL_PIXELS.toLocaleString(locale)} pixels`;
      this.updateSelectionInfo();
    },
    
    calculateTotal(pixels) {
      const STEP = 1000;
      const INCREMENT = 0.01;
      let total = 0;
      let tierIndex = 0;
      
      const fullSteps = Math.floor(pixels / STEP);
      for (let i = 0; i < fullSteps; i++) {
        total += (AppState.globalPrice + (INCREMENT * tierIndex)) * STEP;
        tierIndex++;
      }
      
      const remainder = pixels % STEP;
      if (remainder > 0) {
        total += (AppState.globalPrice + (INCREMENT * tierIndex)) * remainder;
      }
      
      return Math.round(total * 100) / 100;
    },
    
    showInvalidArea(r0, c0, r1, c1) {
      const cell = DOM.grid.children[0];
      const cellSize = cell.getBoundingClientRect().width;
      
      const overlay = document.createElement('div');
      overlay.className = 'invalid-overlay';
      overlay.style.cssText = `
        position: absolute;
        left: ${c0 * cellSize}px;
        top: ${r0 * cellSize}px;
        width: ${(c1 - c0 + 1) * cellSize}px;
        height: ${(r1 - r0 + 1) * cellSize}px;
        background: rgba(239, 68, 68, 0.2);
        border: 2px solid #ef4444;
        pointer-events: none;
        z-index: 1000;
      `;
      
      DOM.grid.appendChild(overlay);
      setTimeout(() => overlay.remove(), 800);
    }
  };

  // ===== CHECKOUT FLOW =====
  const CheckoutFlow = {
    async initiate() {
      const blocks = Array.from(AppState.selected);
      if (!blocks.length) {
        this.showWarning('Please select pixels first!');
        return;
      }
      
      try {
        // Lock blocks
        const lockResult = await window.LockManager.lock(blocks, 180000);
        if (!lockResult.ok || lockResult.conflicts?.length) {
          GridManager.showInvalidArea(0, 0, N-1, N-1);
          GridManager.clearSelection();
          return;
        }
        
        // Setup order data
        AppState.orderData = {
          blocks: lockResult.locked || blocks,
          name: '',
          linkUrl: '',
          imageUrl: null,
          totalAmount: lockResult.totalAmount || GridManager.calculateTotal(blocks.length * 100),
          unitPrice: lockResult.unitPrice || AppState.globalPrice
        };
        
        // Start heartbeat
        window.LockManager.heartbeat.start(AppState.orderData.blocks, 30000, 180000);
        
        // Switch to checkout view
        ViewManager.switchTo('checkout');
        
      } catch (e) {
        console.error('[Checkout] Failed:', e);
        alert('Failed to reserve pixels. Please try again.');
      }
    },
    
    async processForm() {
      const name = DOM.nameInput.value.trim();
      const linkUrl = this.normalizeUrl(DOM.linkInput.value);
      
      if (!name || !linkUrl) {
        this.showWarning('Please fill in all required fields');
        return;
      }
      
      // Check if image is uploaded
      if (!AppState.orderData.imageUrl) {
        this.showWarning('Please upload an image');
        return;
      }
      
      // Save form data
      AppState.orderData.name = name;
      AppState.orderData.linkUrl = linkUrl;
      
      // Start order
      try {
        const response = await apiCall('/start-order', {
          method: 'POST',
          body: JSON.stringify({
            name,
            linkUrl,
            blocks: AppState.orderData.blocks,
            imageUrl: AppState.orderData.imageUrl
          })
        });
        
        if (!response.ok) throw new Error(response.error || 'Failed to start order');
        
        AppState.currentOrder = response;
        
        // Move to payment step
        ViewManager.setCheckoutStep(2);
        
        // Initialize PayPal
        await this.initializePayPal();
        
      } catch (e) {
        console.error('[Order] Failed:', e);
        alert('Failed to process order. Please try again.');
      }
    },
    
    async initializePayPal() {
      if (!window.PayPalIntegration) {
        console.error('PayPal not loaded');
        return;
      }
      
      await window.PayPalIntegration.initAndRender({
        orderId: AppState.currentOrder.orderId,
        currency: AppState.currentOrder.currency || 'USD',
        
        onApproved: async (data, actions) => {
          try {
            const response = await apiCall('/paypal-capture-finalize', {
              method: 'POST',
              body: JSON.stringify({
                orderId: AppState.currentOrder.orderId,
                paypalOrderId: data.orderID
              })
            });
            
            if (!response.ok) throw new Error(response.error || 'Payment failed');
            
            // Success!
            ViewManager.setCheckoutStep(3);
            window.LockManager.heartbeat.stop();
            
            // Refresh grid
            setTimeout(async () => {
              await StatusManager.load();
              GridManager.paintAll();
            }, 1000);
            
          } catch (e) {
            console.error('[Payment] Failed:', e);
            alert('Payment processing failed. Please contact support.');
          }
        },
        
        onCancel: () => {
          console.log('Payment cancelled');
        },
        
        onError: (err) => {
          console.error('Payment error:', err);
          alert('Payment error. Please try again.');
        }
      });
    },
    
    normalizeUrl(url) {
      url = String(url || '').trim();
      if (!url) return '';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      return url;
    },
    
    showWarning(message) {
      DOM.warningMessage.textContent = message;
      DOM.warningMessage.classList.add('show');
      setTimeout(() => DOM.warningMessage.classList.remove('show'), 3000);
    }
  };

  // ===== IMAGE UPLOAD =====
  const ImageUpload = {
    init() {
      DOM.imageInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        DOM.imagePreview.innerHTML = '<div class="upload-spinner">Uploading...</div>';
        
        try {
          // Validate file
          await window.UploadManager.validateFile(file);
          
          // Compress if needed
          const compressed = await this.compressImage(file);
          
          // Upload
          const result = await window.UploadManager.uploadForRegion(
            compressed, 
            'region-' + Date.now()
          );
          
          if (!result.ok) throw new Error(result.error || 'Upload failed');
          
          AppState.orderData.imageUrl = result.imageUrl;
          
          // Show preview
          DOM.imagePreview.innerHTML = `
            <img src="${result.imageUrl}" alt="Preview" />
            <button type="button" class="remove-image" onclick="ImageUpload.remove()">×</button>
          `;
          
        } catch (error) {
          console.error('[Upload] Failed:', error);
          DOM.imagePreview.innerHTML = '<span class="error">Upload failed. Please try again.</span>';
        }
      });
    },
    
    async compressImage(file) {
      if (file.size < 50 * 1024) return file;
      
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        const maxSize = 1200;
        
        let { width, height } = bitmap;
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height);
          width *= ratio;
          height *= ratio;
        }
        
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        const blob = await new Promise(resolve => 
          canvas.toBlob(resolve, 'image/webp', 0.8)
        );
        
        return new File([blob], 'image.webp', { type: 'image/webp' });
        
      } catch (e) {
        console.warn('[Compress] Failed, using original:', e);
        return file;
      }
    },
    
    remove() {
      AppState.orderData.imageUrl = null;
      DOM.imageInput.value = '';
      DOM.imagePreview.innerHTML = '<span>Click to upload or drag & drop</span>';
    }
  };

  // ===== STATUS MANAGEMENT =====
  const StatusManager = {
    lastUpdate: 0,
    
    async load() {
      try {
        const response = await apiCall('/status?ts=' + Date.now());
        if (!response.ok) return;
        
        AppState.sold = response.sold || {};
        AppState.locks = window.LockManager.merge(response.locks || {});
        AppState.regions = response.regions || {};
        
        if (response.currentPrice) {
          AppState.globalPrice = response.currentPrice;
        }
        
        this.lastUpdate = Date.now();
        
        // Update regions display
        if (window.renderRegions) {
          window.renderRegions();
        }
        
      } catch (e) {
        console.warn('[Status] Load failed:', e);
      }
    },
    
    startPolling() {
      setInterval(async () => {
        await this.load();
        GridManager.paintAll();
      }, 4000);
    }
  };

  // ===== EVENT HANDLERS =====
  // ===== EVENT HANDLERS =====
const EventHandlers = {
  init() {
    // Buy button - CORRECTION ICI
    DOM.buyBtn.addEventListener('click', async () => {
      await CheckoutFlow.initiate();
    });
    
    // Back button
    DOM.backToGrid.addEventListener('click', () => {
      if (confirm('Are you sure? Your selection will be lost.')) {
        ViewManager.returnToGrid();
      }
    });
    
    // Form submit
    DOM.checkoutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await CheckoutFlow.processForm();
    });
    
    // View success pixels
    document.getElementById('viewMyPixels')?.addEventListener('click', () => {
      ViewManager.returnToGrid();
    });
    
    // Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && AppState.view === 'checkout') {
        if (confirm('Exit checkout? Your reservation will be cancelled.')) {
          ViewManager.returnToGrid();
        }
      }
    });
  }
};

  // ===== INITIALIZATION =====
// ===== INITIALIZATION =====
async function init() {
  console.log('[App] Initializing refactored version...');
  
  // Initialize grid
  GridManager.init();
  
  // Initialize image upload
  ImageUpload.init();
  
  // Initialize event handlers
  EventHandlers.init();
  
  // Load initial status
  await StatusManager.load();
  GridManager.paintAll();
  
  // Start polling
  StatusManager.startPolling();
  
  // Expose global functions for compatibility et débogage
  window.ImageUpload = ImageUpload;
  window.getSelectedIndices = () => Array.from(AppState.selected);
  window.renderRegions = renderRegions;
  
  // AJOUT pour débogage
  window.AppDebug = {
    AppState,
    ViewManager,
    GridManager,
    CheckoutFlow,
    StatusManager
  };
  
  console.log('[App] Initialization complete');
}

  // ===== REGIONS RENDERING =====
  function renderRegions() {
    const gridEl = DOM.grid;
    if (!gridEl) return;
    
    gridEl.querySelectorAll('.region-overlay').forEach(n => n.remove());
    
    const firstCell = gridEl.querySelector('.cell');
    const size = firstCell ? firstCell.offsetWidth : 10;
    
    const regionLink = {};
    
    for (const [idx, s] of Object.entries(AppState.sold)) {
      const regionId = s.regionId || s.region_id;
      const linkUrl = s.linkUrl || s.link_url;
      if (s && regionId && !regionLink[regionId] && linkUrl) {
        regionLink[regionId] = linkUrl;
      }
    }
    
    for (const [rid, reg] of Object.entries(AppState.regions)) {
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
        top: tl.offsetTop + 'px',
        width: (w * size) + 'px',
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

  // Start app
  init();
})();