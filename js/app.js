// app.js - Version unifiée avec logique locks/heartbeat complète
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

  // ===== HEARTBEAT CONTROL =====
  let __processing = false;

  function pauseHeartbeat() {
    if (__processing) return;
    __processing = true;
    try { 
      window.LockManager?.heartbeat?.stop?.(); 
      console.log('[Heartbeat] Paused');
    } catch (e) {
      console.warn('[Heartbeat] Pause failed', e);
    }
  }

  function resumeHeartbeat() {
    if (!__processing) return;
    __processing = false;
    try {
      const sel = AppState.orderData?.blocks || [];
      if (sel.length && AppState.view === 'checkout') {
        window.LockManager?.heartbeat?.start?.(sel, 30000, 180000, {
          maxMs: 180000,
          autoUnlock: true,
          requireActivity: true
        });
        console.log('[Heartbeat] Resumed for', sel.length, 'blocks');
      }
    } catch (e) {
      console.warn('[Heartbeat] Resume failed', e);
    }
  }

  // ===== VALIDATION LOCKS =====
  function haveMyValidLocks(arr, graceMs = 2000) {
    if (!arr || !arr.length) return false;
    const now = Date.now() + Math.max(0, graceMs | 0);
    for (const i of arr) {
      const l = AppState.locks[String(i)];
      if (!l || l.uid !== uid || !(l.until > now)) return false;
    }
    return true;
  }
   // ===== TOAST NOTIFICATION SYSTEM =====
  const Toast = {
    container: null,
    
    init() {
      if (this.container) return;
      
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 12px;
        pointer-events: none;
      `;
      document.body.appendChild(this.container);
    },
    
    show(message, type = 'info', duration = 4000) {
      this.init();
      
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      
      const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
      };
      
      const colors = {
        success: { bg: '#10b981', border: '#059669' },
        error: { bg: '#ef4444', border: '#dc2626' },
        warning: { bg: '#f59e0b', border: '#d97706' },
        info: { bg: '#3b82f6', border: '#2563eb' }
      };
      
      const color = colors[type] || colors.info;
      
      toast.style.cssText = `
        background: ${color.bg};
        color: white;
        padding: 16px 20px;
        border-radius: 12px;
        border-left: 4px solid ${color.border};
        box-shadow: 0 10px 25px rgba(0,0,0,0.2), 0 4px 10px rgba(0,0,0,0.15);
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 320px;
        max-width: 500px;
        font-size: 14px;
        font-weight: 500;
        pointer-events: auto;
        cursor: pointer;
        transform: translateX(400px);
        opacity: 0;
        transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      `;
      
      toast.innerHTML = `
        <span style="font-size: 20px; font-weight: 600; flex-shrink: 0;">${icons[type]}</span>
        <span style="flex: 1; line-height: 1.4;">${message}</span>
        <button style="
          background: rgba(255,255,255,0.2);
          border: none;
          color: white;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
          transition: background 0.2s;
        " onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">×</button>
      `;
      
      const closeBtn = toast.querySelector('button');
      const close = () => {
        toast.style.transform = 'translateX(400px)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      };
      
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
      
      toast.addEventListener('click', close);
      
      this.container.appendChild(toast);
      
      // Animate in
      requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
        toast.style.opacity = '1';
      });
      
      // Auto remove
      if (duration > 0) {
        setTimeout(close, duration);
      }
    },
    
    success(message, duration) {
      this.show(message, 'success', duration);
    },
    
    error(message, duration) {
      this.show(message, 'error', duration);
    },
    
    warning(message, duration) {
      this.show(message, 'warning', duration);
    },
    
    info(message, duration) {
      this.show(message, 'info', duration);
    }
  };

  // ===== MODAL CONFIRMATION SYSTEM =====
  const Modal = {
    show(options) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        `;
        
        const modal = document.createElement('div');
        modal.style.cssText = `
          background: white;
          border-radius: 16px;
          padding: 28px;
          max-width: 440px;
          width: 90%;
          box-shadow: 0 20px 50px rgba(0,0,0,0.3);
          transform: scale(0.9);
          transition: transform 0.2s;
        `;
        
        const title = options.title || 'Confirm';
        const message = options.message || 'Are you sure?';
        const confirmText = options.confirmText || 'Confirm';
        const cancelText = options.cancelText || 'Cancel';
        const type = options.type || 'warning'; // 'warning' | 'danger' | 'info'
        
        const colors = {
          warning: '#f59e0b',
          danger: '#ef4444',
          info: '#3b82f6'
        };
        
        modal.innerHTML = `
          <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600; color: #111827;">${title}</h3>
          <p style="margin: 0 0 24px 0; color: #6b7280; line-height: 1.6; font-size: 15px;">${message}</p>
          <div style="display: flex; gap: 12px; justify-content: flex-end;">
            <button id="modal-cancel" style="
              padding: 10px 20px;
              border: 2px solid #e5e7eb;
              background: white;
              color: #374151;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            ">${cancelText}</button>
            <button id="modal-confirm" style="
              padding: 10px 20px;
              border: none;
              background: ${colors[type]};
              color: white;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            ">${confirmText}</button>
          </div>
        `;
        
        const confirmBtn = modal.querySelector('#modal-confirm');
        const cancelBtn = modal.querySelector('#modal-cancel');
        
        confirmBtn.addEventListener('mouseover', () => {
          confirmBtn.style.transform = 'translateY(-2px)';
          confirmBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        });
        confirmBtn.addEventListener('mouseout', () => {
          confirmBtn.style.transform = '';
          confirmBtn.style.boxShadow = '';
        });
        
        cancelBtn.addEventListener('mouseover', () => {
          cancelBtn.style.background = '#f3f4f6';
        });
        cancelBtn.addEventListener('mouseout', () => {
          cancelBtn.style.background = 'white';
        });
        
        const close = (result) => {
          overlay.style.opacity = '0';
          modal.style.transform = 'scale(0.9)';
          setTimeout(() => {
            overlay.remove();
            resolve(result);
          }, 200);
        };
        
        confirmBtn.addEventListener('click', () => close(true));
        cancelBtn.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close(false);
        });
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          modal.style.transform = 'scale(1)';
        });
      });
    },
    
    confirm(message, title = 'Confirm') {
      return this.show({ message, title, type: 'warning' });
    },
    
    danger(message, title = 'Warning') {
      return this.show({ message, title, type: 'danger', confirmText: 'Yes, continue' });
    }
  };

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
      regionId: null,
      totalAmount: 0,
      unitPrice: 0
    },
    
    // Timer state
    lockTimer: null,
    lockCheckTimeout: null,
    lockCheckInterval: null,
    lockSecondsRemaining: 180,
    
    // Upload cache
    uploadedImageCache: null
  };

  // ===== DOM REFERENCES =====
  let DOM;

  // ===== VIEW MANAGEMENT =====
  const ViewManager = {
    switchTo(view) {
      console.log('[ViewManager] Switching to:', view);
      AppState.view = view;
      DOM.mainContainer.dataset.view = view;

      // Gestion classe body
      if (view === 'checkout') {
        document.body.classList.add('checkout-mode');
      } else {
        document.body.classList.remove('checkout-mode');
      }
      
      if (view === 'grid') {
        // Transition vers grille
        DOM.checkoutView.classList.remove('active');
        setTimeout(() => {
          DOM.checkoutView.style.display = 'none';
        }, 400);
        
        DOM.gridView.style.display = 'block';
        requestAnimationFrame(() => {
          DOM.gridView.classList.add('active');
        });

        this.stopAllTimers();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } 
      else if (view === 'checkout') {
        // Masquer bulle sélection
        if (DOM.selectionInfo) {
          DOM.selectionInfo.classList.remove('show');
        }
        
        // Transition vers checkout
        DOM.gridView.classList.remove('active');
        setTimeout(() => {
          DOM.gridView.style.display = 'none';
        }, 400);

        DOM.checkoutView.style.display = 'block';
        requestAnimationFrame(() => {
          DOM.checkoutView.classList.add('active');
        });

        this.startLockTimer();
        this.startLockMonitoring(1200);
        this.updateSummary();
        
        // Scroll en haut
        setTimeout(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        }, 50);
      }
    },
    
    clearCheckoutForm() {
      if (DOM.nameInput) DOM.nameInput.value = '';
      if (DOM.linkInput) DOM.linkInput.value = '';
      if (DOM.imageInput) DOM.imageInput.value = '';
      if (DOM.imagePreview) {
        DOM.imagePreview.innerHTML = '<span>Click to upload or drag & drop</span>';
      }
      AppState.orderData.imageUrl = null;
      AppState.orderData.regionId = null;
      AppState.uploadedImageCache = null;
    },

    setCheckoutStep(step) {
      console.log('[ViewManager] Setting checkout step:', step);
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
      
      // Au passage à step 2 (payment), redémarrer le timer visuel
      if (step === 2) {
        console.log('[ViewManager] Step 2: Restarting visual countdown');
        this.startLockTimer();
      }
    },
    
    updateSummary() {
      const { blocks, totalAmount, unitPrice } = AppState.orderData;
      const pixels = blocks.length * 100;
      
      DOM.summaryPixels.textContent = pixels.toLocaleString(locale);
      DOM.summaryPrice.textContent = `$${unitPrice.toFixed(2)}`;
      DOM.summaryTotal.textContent = `$${totalAmount.toFixed(2)}`;
      
      this.renderPixelPreview();
    },
    
    renderPixelPreview() {
      const { blocks } = AppState.orderData;
      if (!blocks.length) return;
      
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
      console.log('[ViewManager] Starting 3-minute countdown');

      // Arrêter timer précédent
      if (AppState.lockTimer) {
        clearInterval(AppState.lockTimer);
        AppState.lockTimer = null;
      }

      // Reset à 180 secondes
      AppState.lockSecondsRemaining = 180;

      const updateDisplay = () => {
        const secondsRemaining = AppState.lockSecondsRemaining;
        const minutes = Math.floor(Math.max(0, secondsRemaining) / 60);
        const seconds = Math.max(0, secondsRemaining % 60);

        if (DOM.timerValue) {
          if (secondsRemaining > 0) {
            DOM.timerValue.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
          } else {
            DOM.timerValue.textContent = 'Reservation expired 😱';
          }
        }

        if (secondsRemaining <= 0) {
          if (AppState.lockTimer) {
            clearInterval(AppState.lockTimer);
            AppState.lockTimer = null;
          }
          if (DOM.timerValue) DOM.timerValue.textContent = '0:00';
          console.log('[ViewManager] Visual countdown reached 0');
          return;
        }

        AppState.lockSecondsRemaining--;
      };

      updateDisplay();
      AppState.lockTimer = setInterval(updateDisplay, 1000);
    },

    startLockMonitoring(warmupMs = 1200) {
      console.log('[ViewManager] Starting lock monitoring with server refresh');

      // Cleanup anciens timers
      if (AppState.lockCheckTimeout) { 
        clearTimeout(AppState.lockCheckTimeout); 
        AppState.lockCheckTimeout = null; 
      }
      if (AppState.lockCheckInterval) { 
        clearInterval(AppState.lockCheckInterval); 
        AppState.lockCheckInterval = null; 
      }

      const checkLocks = async () => {
        // Skip si en processing
        if (__processing) {
          console.log('[LockMonitor] Skipping check (processing)');
          return;
        }

        const blocks = AppState.orderData.blocks;
        if (!blocks || !blocks.length) return;

        // 1) Rafraîchir status serveur (source de vérité)
        try {
          const status = await apiCall('/status?ts=' + Date.now());
          if (status && status.ok) {
            AppState.locks = window.LockManager.merge(status.locks || {});
            AppState.sold = status.sold || AppState.sold;
            AppState.regions = status.regions || AppState.regions;
          } else {
            console.warn('[LockMonitor] /status returned not ok');
          }
        } catch (err) {
          console.warn('[LockMonitor] Failed to refresh /status:', err);
        }

        // 2) Vérifier validité locks
        const ok = haveMyValidLocks(blocks, 3000);
        console.log('[LockMonitor] Check result:', ok, '| Timer:', AppState.lockSecondsRemaining, 's');

        // 3) Update UI selon step
        if (AppState.checkoutStep === 1) {
          // Step 1: bouton "Continue to Payment"
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = !ok;
            DOM.proceedToPayment.textContent = ok 
              ? '💳 Continue to Payment' 
              : '⏰ Reservation expired - reselect';
          }
        } else if (AppState.checkoutStep === 2) {
          // Step 2: PayPal
          this.setPayPalEnabled(ok);
        }

        // 4) Stop monitoring si locks invalides
        if (!ok) {
          try { window.LockManager.heartbeat.stop(); } catch (e) {}
          console.log('[LockMonitor] Locks invalid, stopping monitoring');
          
          if (AppState.lockCheckInterval) {
            clearInterval(AppState.lockCheckInterval);
            AppState.lockCheckInterval = null;
          }
          return;
        }

        // 5) Unlock défensif si timer visuel expiré ET heartbeat arrêté
        const timerExpired = AppState.lockSecondsRemaining <= 0;
        const heartbeatObj = window.LockManager?.heartbeat;
        const heartbeatRunning = !!(heartbeatObj && (
          heartbeatObj.isRunning || heartbeatObj._running || heartbeatObj._timer
        ));

        if (timerExpired && !heartbeatRunning) {
          console.warn('[LockMonitor] Defensive unlock: timer expired, heartbeat stopped');
          
          try {
            await window.LockManager.unlock(blocks);
          } catch (e) {
            try {
              await apiCall('/unlock', {
                method: 'POST',
                body: JSON.stringify({ blocks })
              });
            } catch (ex) {
              console.error('[LockMonitor] Defensive unlock failed', ex);
            }
          }

          if (AppState.lockCheckInterval) {
            clearInterval(AppState.lockCheckInterval);
            AppState.lockCheckInterval = null;
          }

          AppState.locks = {};
          
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = true;
            DOM.proceedToPayment.textContent = '⏰ Reservation expired - reselect';
          }
          this.setPayPalEnabled(false);
          return;
        }
      };

      // Première vérif après warmup, puis toutes les 5s
      AppState.lockCheckTimeout = setTimeout(() => {
        checkLocks();
        AppState.lockCheckInterval = setInterval(checkLocks, 5000);
      }, Math.max(0, warmupMs | 0));

      console.log('[ViewManager] Lock monitoring scheduled with warmup:', warmupMs);
    },

    stopAllTimers() {
      console.log('[ViewManager] Stopping all timers');
      
      if (AppState.lockTimer) {
        clearInterval(AppState.lockTimer);
        AppState.lockTimer = null;
      }
      
      if (AppState.lockCheckTimeout) {
        clearTimeout(AppState.lockCheckTimeout);
        AppState.lockCheckTimeout = null;
      }
      
      if (AppState.lockCheckInterval) {
        clearInterval(AppState.lockCheckInterval);
        AppState.lockCheckInterval = null;
      }
    },
    
    setPayPalEnabled(enabled) {
      const container = document.getElementById('paypal-button-container');
      if (!container) return;
      
      container.style.pointerEvents = enabled ? '' : 'none';
      container.style.opacity = enabled ? '' : '0.45';
      container.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      
      // Update state class
      if (enabled) {
        container.className = 'active';
      } else {
        container.className = 'expired';
      }
    },
    
    async returnToGrid() {
      console.log('[ViewManager] Returning to grid');
      
      // Stop heartbeat
      try { window.LockManager.heartbeat.stop(); } catch (e) {}
      
      // Unlock blocks
      if (AppState.orderData.blocks.length) {
        try {
          await window.LockManager.unlock(AppState.orderData.blocks);
          console.log('[ViewManager] Unlocked', AppState.orderData.blocks.length, 'blocks');
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
        regionId: null,
        totalAmount: 0,
        unitPrice: 0
      };
      
      AppState.selected.clear();
      AppState.uploadedImageCache = null;
      AppState.currentOrder = null;
      
      GridManager.clearSelection();
      this.clearCheckoutForm();
      
      // Réactiver boutons
      if (DOM.proceedToPayment) {
        DOM.proceedToPayment.disabled = false;
        DOM.proceedToPayment.textContent = '💳 Continue to Payment';
      }
      
      // Switch view
      this.switchTo('grid');
      this.setCheckoutStep(1);
      
      // Refresh
      await StatusManager.load();
      GridManager.paintAll();
    }
  };

  // ===== GRID MANAGEMENT =====
  const GridManager = {
    init() {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N * N; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.idx = i;
        frag.appendChild(cell);
      }
      DOM.grid.appendChild(frag);
      
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
      
      // Check blocked
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
      if (AppState.view === 'checkout') {
        DOM.selectionInfo.classList.remove('show');
        return;
      }
      
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
      console.log('[CheckoutFlow] Initiating checkout');
      
      const blocks = Array.from(AppState.selected);
      if (!blocks.length) {
        //this.showWarning('Please select pixels first!');
        Toast.warning('Please select pixels first!');
        return;
      }
      
      try {
        // Lock avec retry de LockManager
        const lockResult = await window.LockManager.lock(blocks, 180000);
        console.log('[CheckoutFlow] Lock result:', lockResult);
        
        if (!lockResult.ok || lockResult.conflicts?.length) {
          console.warn('[CheckoutFlow] Lock failed or conflicts');
          GridManager.showInvalidArea(0, 0, N-1, N-1);
          GridManager.clearSelection();
          return;
        }
        
        // Setup order data avec prix serveur
        AppState.orderData = {
          blocks: lockResult.locked || blocks,
          name: '',
          linkUrl: '',
          imageUrl: null,
          regionId: lockResult.regionId || null,
          totalAmount: lockResult.totalAmount || GridManager.calculateTotal(blocks.length * 100),
          unitPrice: lockResult.unitPrice || AppState.globalPrice
        };
        
        // Exposer pour compatibilité
        window.reservedTotal = AppState.orderData.totalAmount;
        window.reservedPrice = AppState.orderData.unitPrice;
        
        console.log('[CheckoutFlow] Order data:', AppState.orderData);
        
        // Start heartbeat avec config complète
        window.LockManager.heartbeat.start(
          AppState.orderData.blocks, 
          30000,   // interval 30s
          180000,  // max 180s
          {
            maxMs: 180000,
            autoUnlock: true,
            requireActivity: true
          }
        );
        
        // Switch to checkout
        ViewManager.switchTo('checkout');
        
      } catch (e) {
        console.error('[Checkout] Failed:', e);
        Toast.error('Failed to reserve pixels. Please try again.');
      }
    },
    
    async processForm() {
      console.log('[CheckoutFlow] Processing form');
      
      const name = DOM.nameInput.value.trim();
      const linkUrl = this.normalizeUrl(DOM.linkInput.value);
      
      if (!name || !linkUrl) {
        //this.showWarning('Please fill in all required fields');
        Toast.warning('Please fill in all required fields');
        return;
      }
      
      // Vérifier upload image
      if (!AppState.uploadedImageCache || !AppState.uploadedImageCache.imageUrl) {
        //this.showWarning('Please upload an image');
        Toast.warning('Please upload an image');
        return;
      }
      
      // Vérifier âge upload (max 5 min)
      const uploadAge = Date.now() - AppState.uploadedImageCache.uploadedAt;
      if (uploadAge > 300000) {
        this.showWarning('Image upload expired, please reselect your image');
        AppState.uploadedImageCache = null;
        return;
      }
      
      // Vérifier locks
      if (!haveMyValidLocks(AppState.orderData.blocks, 1000)) {
        await StatusManager.load();
        this.showWarning('Your reservation expired. Please reselect your pixels.');
        ViewManager.returnToGrid();
        return;
      }

      // Save form data
      AppState.orderData.name = name;
      AppState.orderData.linkUrl = linkUrl;
      AppState.orderData.imageUrl = AppState.uploadedImageCache.imageUrl;
      AppState.orderData.regionId = AppState.uploadedImageCache.regionId;

      pauseHeartbeat();
      
      try {
        // Renouveler locks avant start-order
        console.log('[CheckoutFlow] Renewing locks before start-order');
        await window.LockManager.lock(AppState.orderData.blocks, 180000, { optimistic: false });

        // Paralléliser SDK PayPal + start-order
        console.log('[CheckoutFlow] Parallel: SDK + start-order');
        const startTime = performance.now();
        
        const [sdkReady, orderResult] = await Promise.all([
          this.ensurePayPalSDK(),
          this.startOrder()
        ]);
        
        const parallelTime = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`[CheckoutFlow] Parallel completed in ${parallelTime}s`);

        if (!orderResult || !orderResult.success) {
          throw new Error(orderResult?.error || 'Failed to start order');
        }

        AppState.currentOrder = {
          orderId: orderResult.orderId,
          regionId: orderResult.regionId,
          currency: orderResult.currency || 'USD'
        };
        
        // Extension finale locks avant PayPal
        console.log('[CheckoutFlow] Final lock extension before PayPal');
        await window.LockManager.lock(AppState.orderData.blocks, 180000, { optimistic: false });

        // Passer au step 2 et render PayPal
        ViewManager.setCheckoutStep(2);
        await this.initializePayPal();

      } catch (e) {
        console.error('[Order] Failed:', e);
        Toast.error('Failed to process order: ' + (e.message || e));
      } finally {
        resumeHeartbeat();
      }
    },
    
    async ensurePayPalSDK() {
      if (window.paypal && window.paypal.Buttons) {
        console.log('[PayPal SDK] Already loaded');
        return true;
      }

      if (window.PayPalIntegration && typeof window.PayPalIntegration.ensureSDK === 'function') {
        console.log('[PayPal SDK] Loading via PayPalIntegration');
        await window.PayPalIntegration.ensureSDK();
        return true;
      }

      // Fallback: wait for window.paypal
      console.log('[PayPal SDK] Waiting for window.paypal');
      const timeout = 5000;
      const start = Date.now();
      while (!window.paypal || !window.paypal.Buttons) {
        if (Date.now() - start > timeout) {
          throw new Error('PayPal SDK load timeout');
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return true;
    },
    
    async startOrder() {
      try {
        console.log('[CheckoutFlow] Calling /start-order');
        
        const response = await apiCall('/start-order', {
          method: 'POST',
          body: JSON.stringify({
            name: AppState.orderData.name,
            linkUrl: AppState.orderData.linkUrl,
            blocks: AppState.orderData.blocks,
            imageUrl: AppState.orderData.imageUrl,
            regionId: AppState.orderData.regionId
          })
        });

        if (!response || !response.ok) {
          const message = (response && (response.error || response.message)) || 'Start order failed';
          return { success: false, error: message };
        }

        return {
          success: true,
          orderId: response.orderId,
          regionId: response.regionId,
          currency: response.currency || 'USD'
        };

      } catch (e) {
        console.error('[startOrder] Error:', e);
        return { success: false, error: e.message || 'Unknown error' };
      }
    },
    
    async initializePayPal() {
      if (!window.PayPalIntegration) {
        console.error('[PayPal] PayPalIntegration not loaded');
        return;
      }
      
      console.log('[CheckoutFlow] Rendering PayPal buttons');
      
      await window.PayPalIntegration.initAndRender({
        orderId: AppState.currentOrder.orderId,
        currency: AppState.currentOrder.currency,

        onApproved: async (data, actions) => {
          console.log('[PayPal] Payment approved');
          pauseHeartbeat();
          
          try {
            ViewManager.setPayPalEnabled(false);
            
            const res = await apiCall('/paypal-capture-finalize', {
              method: 'POST',
              body: JSON.stringify({
                orderId: AppState.currentOrder.orderId,
                paypalOrderId: data.orderID
              })
            });

            if (!res || !res.ok) {
              // Gérer INSTRUMENT_DECLINED
              const name = res?.details?.name || '';
              const issues = Array.isArray(res?.details?.details) 
                ? res.details.details.map(d => d.issue) 
                : [];
              const isInstrDeclined = res?.error === 'INSTRUMENT_DECLINED' || 
                (name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED'));

              if (isInstrDeclined) {
                console.warn('[PayPal] Instrument declined, allowing restart');
                if (actions && typeof actions.restart === 'function') {
                  ViewManager.setPayPalEnabled(true);
                  await actions.restart();
                  return;
                }
                ViewManager.setPayPalEnabled(true);
                this.showWarning('Payment was declined. Please try again.');
                return;
              }

              throw new Error(res?.error || res?.message || 'Capture failed');
            }

            // Attendre finalisation complète
            console.log('[PayPal] Waiting for order completion');
            const completed = await this.waitForCompleted(AppState.currentOrder.orderId, 60);
            
            if (!completed) {
              console.warn('[PayPal] Order not completed in time');
              this.showWarning('Payment is processing. Please check back soon.');
              ViewManager.setCheckoutStep(3);
              return;
            }

            // Succès complet
            console.log('[PayPal] Order completed successfully');
            Toast.success('Payment successful! Your spot is now live! 🎉', 5000);
            //ViewManager.setCheckoutStep(3);
            // ⭐ NOUVEAU : Retourner à la grille avec highlight
            await this.returnToGridWithHighlight();
            // Cleanup
            //try { window.LockManager.heartbeat.stop(); } catch (e) {}
            //try { 
              //await window.LockManager.unlock(AppState.orderData.blocks); 
            //} catch (e) {}
            
            // Refresh
            //await StatusManager.load();
            //GridManager.paintAll();

          } catch (e) {
            console.error('[Payment] Failed:', e);
            Toast.error('Payment failed: ' + (e.message || 'Unknown error'));
            ViewManager.setPayPalEnabled(false);
            try { window.LockManager.heartbeat.stop(); } catch (ex) {}
          }
        },

        onCancel: () => {
          console.log('[PayPal] Payment cancelled by user');
          
          // NE PAS stopper heartbeat - permettre retry
          ViewManager.setPayPalEnabled(true);
          //this.showWarning('Payment cancelled. You can retry or go back.');
          Toast.info('Payment cancelled. You can retry or go back.');
          resumeHeartbeat();
        },

        onError: async (err) => {
          console.error('[PayPal] Error:', err);
          
          pauseHeartbeat();
          ViewManager.setPayPalEnabled(false);
          
          //this.showWarning('Payment error occurred. Please try again or contact support.');
          Toast.error('Payment error occurred. Please try again.');
          // Stopper heartbeat et unlock
          try { window.LockManager.heartbeat.stop(); } catch (e) {}
          try { 
            await window.LockManager.unlock(AppState.orderData.blocks); 
          } catch (e) {}
        }
      });
    },
    
    async waitForCompleted(orderId, maxSeconds = 120) {
      const maxAttempts = 12;
      let delay = 1000;
      
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const status = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
          
          if (status?.ok) {
            const s = String(status.status || '').toLowerCase();
            if (s === 'completed') return true;
            if (['failed', 'failed_refund', 'cancelled', 'expired'].includes(s)) return false;
            console.log('[CheckoutFlow] Order status:', s);
          }
        } catch (e) {
          console.warn('[CheckoutFlow] Status check failed:', e);
        }
        
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(10000, Math.round(delay * 1.7));
      }
      
      return false;
    },
    
    async returnToGridWithHighlight() {
  const purchasedBlocks = AppState.orderData.blocks.slice();
  
  // Cleanup
  try { window.LockManager.heartbeat.stop(); } catch (e) {}
  try { 
    await window.LockManager.unlock(purchasedBlocks); 
  } catch (e) {}
  
  // Refresh status
  await StatusManager.load();
  
  // Switch to grid
  ViewManager.switchTo('grid');
  ViewManager.setCheckoutStep(1);
  ViewManager.clearCheckoutForm();
  
  // Reset state
  AppState.orderData = {
    blocks: [],
    name: '',
    linkUrl: '',
    imageUrl: null,
    regionId: null,
    totalAmount: 0,
    unitPrice: 0
  };
  AppState.selected.clear();
  AppState.uploadedImageCache = null;
  AppState.currentOrder = null;
  
  // Paint all
  GridManager.paintAll();
  
  // ⭐ HIGHLIGHT les pixels achetés
  setTimeout(() => {
    this.highlightPurchasedPixels(purchasedBlocks);
  }, 600); // Attendre la transition de vue
},

highlightPurchasedPixels(blocks) {
  if (!blocks || !blocks.length) return;
  
  // Calculer le rectangle englobant
  const minRow = Math.min(...blocks.map(i => Math.floor(i / 100)));
  const maxRow = Math.max(...blocks.map(i => Math.floor(i / 100)));
  const minCol = Math.min(...blocks.map(i => i % 100));
  const maxCol = Math.max(...blocks.map(i => i % 100));
  
  const cell = DOM.grid.children[0];
  const cellSize = cell.getBoundingClientRect().width;
  
  // Créer l'overlay de highlight
  const highlight = document.createElement('div');
  highlight.style.cssText = `
    position: absolute;
    left: ${minCol * cellSize}px;
    top: ${minRow * cellSize}px;
    width: ${(maxCol - minCol + 1) * cellSize}px;
    height: ${(maxRow - minRow + 1) * cellSize}px;
    border: 4px solid #10b981;
    background: rgba(16, 185, 129, 0.15);
    box-shadow: 0 0 30px rgba(16, 185, 129, 0.6), inset 0 0 30px rgba(16, 185, 129, 0.2);
    pointer-events: none;
    z-index: 1001;
    border-radius: 4px;
    animation: highlightPulse 2s ease-in-out 3;
  `;
  
  // Ajouter l'animation CSS si pas déjà présente
  if (!document.getElementById('highlight-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'highlight-pulse-style';
    style.textContent = `
      @keyframes highlightPulse {
        0%, 100% { 
          opacity: 1; 
          transform: scale(1);
        }
        50% { 
          opacity: 0.6; 
          transform: scale(1.02);
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  DOM.grid.appendChild(highlight);
  
  // ⭐ SCROLL AMÉLIORÉ : utiliser la position absolue de la grille
  const gridRect = DOM.grid.getBoundingClientRect();
  const gridTop = window.scrollY + gridRect.top;
  
  const highlightAbsoluteTop = gridTop + (minRow * cellSize);
  const highlightAbsoluteBottom = gridTop + ((maxRow + 1) * cellSize);
  const highlightHeight = (maxRow - minRow + 1) * cellSize;
  
  // Calculer le centre du highlight
  const highlightCenter = highlightAbsoluteTop + (highlightHeight / 2);
  
  // Scroll pour centrer le highlight dans le viewport
  const targetScroll = highlightCenter - (window.innerHeight / 2);
  
  console.log('[Highlight] Scrolling to purchased pixels:', {
    minRow, maxRow,
    gridTop,
    highlightTop: highlightAbsoluteTop,
    targetScroll
  });
  
  window.scrollTo({
    top: Math.max(0, targetScroll),
    behavior: 'smooth'
  });
  
  // Retirer après 6 secondes (3 pulses × 2s)
  setTimeout(() => {
    highlight.style.opacity = '0';
    highlight.style.transition = 'opacity 0.5s';
    setTimeout(() => highlight.remove(), 500);
  }, 6000);
},
    normalizeUrl(url) {
      url = String(url || '').trim();
      if (!url) return '';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      
      try {
        const urlObj = new URL(url);
        urlObj.hash = '';
        return urlObj.toString();
      } catch {
        return '';
      }
    },
    
    showWarning(message) {
      if (!DOM.warningMessage) {
        alert(message);
        return;
      }
      
      DOM.warningMessage.textContent = message;
      DOM.warningMessage.classList.add('show');
      setTimeout(() => DOM.warningMessage.classList.remove('show'), 3000);
    }
  };

  // ===== IMAGE UPLOAD =====
  const ImageUpload = {
    init() {
      // Click to upload
      DOM.imagePreview.addEventListener('click', () => {
        DOM.imageInput.click();
      });
      
      DOM.imageInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) {
          AppState.uploadedImageCache = null;
          return;
        }
        
        const selectionId = (window.crypto && crypto.randomUUID) 
          ? crypto.randomUUID() 
          : ('sel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        
        DOM.imageInput.dataset.selectionId = selectionId;
        const regionId = selectionId;
        
        // Show spinner
        DOM.imagePreview.innerHTML = '<div class="upload-spinner">Validating...</div>';
        
        try {
          // Validate
          await window.UploadManager.validateFile(file);
          
          DOM.imagePreview.innerHTML = '<div class="upload-spinner">Compressing...</div>';
          
          // Compress
          let fileToUpload;
          try {
            fileToUpload = await this.compressImage(file, {
              maxWidth: 1600,
              maxHeight: 1600,
              quality: 0.82
            });
          } catch (err) {
            console.warn('[Upload] Compression failed, using original:', err);
            fileToUpload = file;
          }
          
          DOM.imagePreview.innerHTML = '<div class="upload-spinner">Uploading...</div>';
          
          // Upload
          const result = await window.UploadManager.uploadForRegion(fileToUpload, regionId);
          
          // Vérifier stale upload
          if (DOM.imageInput.dataset.selectionId !== selectionId) {
            console.log('[Upload] Stale upload, ignoring');
            return;
          }
          
          if (!result || !result.ok) {
            throw new Error(result?.error || result?.message || 'Upload failed');
          }
          
          // Cache upload
          AppState.uploadedImageCache = {
            imageUrl: result.imageUrl,
            regionId: result.regionId || regionId,
            uploadedAt: Date.now()
          };
          
          AppState.orderData.imageUrl = result.imageUrl;
          AppState.orderData.regionId = result.regionId || regionId;
          
          // Show preview
          DOM.imagePreview.innerHTML = `
            <img src="${result.imageUrl}" alt="Preview" style="max-width: 100%; max-height: 100%;" />
            <button type="button" class="remove-image" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.6); color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 18px; line-height: 1;">×</button>
          `;
          
          // Add remove handler
          const removeBtn = DOM.imagePreview.querySelector('.remove-image');
          if (removeBtn) {
            removeBtn.addEventListener('click', (evt) => {
              evt.stopPropagation();
              this.remove();
            });
          }
          
          console.log('[Upload] Completed:', AppState.uploadedImageCache);
          
        } catch (error) {
          console.error('[Upload] Failed:', error);
          AppState.uploadedImageCache = null;
          DOM.imagePreview.innerHTML = '<span class="error" style="color: #ef4444;">Upload failed. Please try again.</span>';
          Toast.error('Image upload failed: ' + (error.message || 'Unknown error'));
        }
      });
      
      // Drag & drop
      DOM.imagePreview.addEventListener('dragover', (e) => {
        e.preventDefault();
        DOM.imagePreview.classList.add('dragover');
      });
      
      DOM.imagePreview.addEventListener('dragleave', () => {
        DOM.imagePreview.classList.remove('dragover');
      });
      
      DOM.imagePreview.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.imagePreview.classList.remove('dragover');
        
        const file = e.dataTransfer.files?.[0];
        if (file) {
          DOM.imageInput.files = e.dataTransfer.files;
          const event = new Event('change');
          DOM.imageInput.dispatchEvent(event);
        }
      });
    },
    
    async compressImage(file, { maxWidth = 1200, maxHeight = 1200, quality = 0.80 } = {}) {
      if (file.size < 50 * 1024) return file;
      
      try {
        const bitmap = await createImageBitmap(file);
        
        let { width, height } = bitmap;
        const ratio = Math.min(1, maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        
        let canvas;
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(width, height);
        } else {
          canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
        }
        
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        // Detect alpha
        let hasAlpha = false;
        try {
          const imageData = ctx.getImageData(0, 0, 1, 1).data;
          hasAlpha = imageData[3] !== 255;
        } catch (e) {
          hasAlpha = false;
        }
        
        // Choose format
        const supportsWebP = (() => {
          try {
            const c = document.createElement('canvas');
            return !!(c.getContext && c.getContext('2d') && 
              c.toDataURL('image/webp').indexOf('data:image/webp') === 0);
          } catch { return false; }
        })();
        
        let outType = 'image/jpeg';
        if (supportsWebP) outType = 'image/webp';
        else if (hasAlpha) outType = 'image/png';
        
        // Convert to blob
        let outBlob;
        if (canvas.convertToBlob) {
          outBlob = await canvas.convertToBlob({ type: outType, quality });
        } else {
          outBlob = await new Promise((res) => canvas.toBlob(res, outType, quality));
        }
        
        if (!outBlob) return file;
        
        const ext = outBlob.type.includes('webp') ? '.webp' 
          : outBlob.type.includes('jpeg') ? '.jpg' 
          : '.png';
        const newName = file.name.replace(/\.[^/.]+$/, '') + ext;
        const newFile = new File([outBlob], newName, { 
          type: outBlob.type, 
          lastModified: Date.now() 
        });
        
        console.log(`[Compression] ${file.name}: ${(file.size/1024).toFixed(0)}KB → ${(newFile.size/1024).toFixed(0)}KB`);
        return newFile;
        
      } catch (e) {
        console.warn('[Compression] Failed:', e);
        return file;
      }
    },
    
    remove() {
      AppState.uploadedImageCache = null;
      AppState.orderData.imageUrl = null;
      AppState.orderData.regionId = null;
      DOM.imageInput.value = '';
      DOM.imagePreview.innerHTML = '<span>Click to upload or drag & drop</span>';
    }
  };

  // ===== STATUS MANAGEMENT =====
  const StatusManager = {
    lastUpdate: 0,
    
    async load() {
      try {
        const sinceParam = this.lastUpdate 
          ? '?since=' + encodeURIComponent(this.lastUpdate)
          : '?ts=' + Date.now();
        
        const response = await apiCall('/status' + sinceParam);
        if (!response || !response.ok) return;
        
        // Update price
        if (typeof response.currentPrice === 'number') {
          AppState.globalPrice = response.currentPrice;
        }
        
        // Diff-based update
        const newSold = response.sold || {};
        const newLocks = response.locks || {};
        const changed = new Set();
        
        for (const k of Object.keys(AppState.sold || {})) changed.add(k);
        for (const k of Object.keys(newSold)) changed.add(k);
        for (const k of Object.keys(AppState.locks || {})) changed.add(k);
        for (const k of Object.keys(newLocks)) changed.add(k);
        
        AppState.sold = newSold;
        AppState.locks = window.LockManager.merge(newLocks);
        AppState.regions = response.regions || AppState.regions;
        
        // Paint only changed
        for (const k of changed) {
          const idx = parseInt(k, 10);
          if (!Number.isNaN(idx) && DOM.grid.children[idx]) {
            GridManager.paintCell(idx);
          }
        }
        
        if (window.renderRegions) {
          window.renderRegions();
        }
        
        GridManager.updateTopbar();
        
        if (typeof response.ts === 'number') {
          this.lastUpdate = response.ts;
        }
        
      } catch (e) {
        console.warn('[Status] Load failed:', e);
      }
    },
    
    startPolling() {
      setInterval(async () => {
        await this.load();
      }, 3500); // 3.5s optimisé
    }
  };

  // ===== EVENT HANDLERS =====
  const EventHandlers = {
    init() {
      console.log('[EventHandlers] Initializing');
      
      // Buy button
      if (DOM.buyBtn) {
        DOM.buyBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          console.log('[EventHandlers] Buy clicked');
          await CheckoutFlow.initiate();
        });
      }
      
      // Back button
      if (DOM.backToGrid) {
        DOM.backToGrid.addEventListener('click', () => {
          const isExpired = DOM.proceedToPayment?.disabled;
          
          if (isExpired) {
            ViewManager.returnToGrid();
          } else {
            Modal.confirm(
              'Your reservation will be cancelled and pixels will be released.',
              'Exit checkout?'
            ).then(confirmed => {
              if (confirmed) { ViewManager.returnToGrid();}
            });
          }
        });
      }
      
      // Form submit
      if (DOM.checkoutForm) {
        DOM.checkoutForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          await CheckoutFlow.processForm();
        });
      }
      
      // Continue to Payment - redémarre le timer visuel
      if (DOM.proceedToPayment) {
        DOM.proceedToPayment.addEventListener('click', () => {
          if (AppState.checkoutStep === 1) {
            console.log('[EventHandlers] Resetting countdown on payment transition');
            // Le timer sera redémarré automatiquement par setCheckoutStep(2)
          }
        });
      }
      
      // View pixels button
      const viewPixelsBtn = document.getElementById('viewMyPixels');
      if (viewPixelsBtn) {
        viewPixelsBtn.addEventListener('click', () => {
          ViewManager.returnToGrid();
        });
      }
      
      // Escape key
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && AppState.view === 'checkout') {
          if (confirm('Exit checkout? Your reservation will be cancelled.')) {
            ViewManager.returnToGrid();
          }
        }
      });
      
      console.log('[EventHandlers] All listeners initialized');
    }
  };

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

  // ===== INITIALIZATION =====
  async function init() {
    console.log('[App] Initializing unified version with full lock logic');
    
    // Initialize DOM references
    DOM = {
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
    
    // Initialize modules
    GridManager.init();
    ImageUpload.init();
    EventHandlers.init();
    
    // Load status
    await StatusManager.load();
    GridManager.paintAll();
    
    // Start polling
    StatusManager.startPolling();
    
    // Expose global APIs
    window.ImageUpload = ImageUpload;
    window.getSelectedIndices = () => Array.from(AppState.selected);
    window.renderRegions = renderRegions;
    window.reservedTotal = 0; // Compat
    window.reservedPrice = 0; // Compat
    
    // Debug API
    window.AppDebug = {
      AppState,
      ViewManager,
      GridManager,
      CheckoutFlow,
      StatusManager,
      pauseHeartbeat,
      resumeHeartbeat,
      haveMyValidLocks
    };
    
    console.log('[App] Initialization complete');
  }

  // Start app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();