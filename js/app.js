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
// ===== TOAST NOTIFICATION SYSTEM - SOBRE & CENTRÉ =====
const Toast = {
  container: null,
  
  init() {
    if (this.container) return;
    
    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 12px;
      pointer-events: none;
    `;
    document.body.appendChild(this.container);
  },
  
  show(message, type = 'info', duration = 3000) {
    this.init();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
      success: '✓',
      error: '!',
      warning: '⚠',
      info: 'i'
    };
    
    const colors = {
      success: '#10b981',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };
    
    const color = colors[type] || colors.info;
    
    toast.style.cssText = `
      background: #ffffff;
      color: #1f2937;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 320px;
      max-width: 500px;
      font-size: 15px;
      pointer-events: auto;
      opacity: 0;
      transform: scale(0.9);
      transition: all 0.2s ease;
      border-left: 4px solid ${color};
    `;
    
    toast.innerHTML = `
      <div style="
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: ${color};
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 14px;
        flex-shrink: 0;
      ">${icons[type]}</div>
      <span style="flex: 1; line-height: 1.4; font-weight: 500;">${message}</span>
    `;
    
    const close = () => {
      toast.style.opacity = '0';
      toast.style.transform = 'scale(0.9)';
      setTimeout(() => toast.remove(), 200);
    };
    
    toast.addEventListener('click', close);
    
    this.container.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'scale(1)';
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
window.Toast = Toast;
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
    lockSecondsRemaining: 300,  // ← Mettre 300 (5 min)
    lockStartTime: 0, 
    
    // Upload cache
    uploadedImageCache: null
  };

  // ===== DOM REFERENCES =====
  let DOM;

  // ===== VIEW MANAGEMENT =====
  const ViewManager = {
    _scrollTimeout: null,
    switchTo(view, options = {}) {
      console.log('[ViewManager] Switching to:', view);
      // ⭐ ANNULER tout scroll en attente
      if (this._scrollTimeout) {
        clearTimeout(this._scrollTimeout);
        this._scrollTimeout = null;
      }
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
        
        // ⭐ NE PAS scroller en haut si on demande de garder la position
        if (!options.keepScroll) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        //window.scrollTo({ top: 0, behavior: 'smooth' });
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
        
        // ⭐ STOCKER le timeout
      this._scrollTimeout = setTimeout(() => {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        this._scrollTimeout = null;
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

  updateCheckoutButtons() {
  if (!DOM.backToGrid || !DOM.proceedToPayment) return;
  
  const step = AppState.checkoutStep;
  
  if (step === 1) {
    DOM.backToGrid.style.display = '';
    DOM.proceedToPayment.style.display = '';
    DOM.proceedToPayment.textContent = '💳 Continue to Payment';
  } 
  else if (step === 2) {
    DOM.backToGrid.style.display = '';
    DOM.proceedToPayment.style.display = 'none';
  }
  else if (step === 3) {
    DOM.backToGrid.style.display = 'none';
    DOM.proceedToPayment.style.display = 'none';
  }
},

   setCheckoutStep(step) {
  console.log('[ViewManager] Setting checkout step:', step);
  AppState.checkoutStep = step;

  if (!DOM || !DOM.steps) {
    console.warn('[ViewManager] DOM.steps not ready yet.');
    return;
  }

  // Update steps visibility
  Object.entries(DOM.steps).forEach(([num, el]) => {
    if (!el) {
      console.warn(`[ViewManager] Missing step element for step ${num}`);
      return;
    }
    el.classList.toggle('active', parseInt(num, 10) === step);
  });

  // ✅ MODIFIÉ: Update progress bar avec 4 étapes
  if (DOM.progressSteps && DOM.progressSteps.forEach) {
    DOM.progressSteps.forEach((el, i) => {
      if (!el) return;
      
      // Récupérer le numéro d'étape depuis data-step (0, 1, 2, 3)
      const progressStep = parseInt(el.dataset.step, 10);
      
      // Step 0 (Selection) est toujours completed en checkout
      if (progressStep === 0) {
        el.classList.add('completed');
        el.classList.remove('active');
      }
      // Step actuel
      else if (progressStep === step) {
        el.classList.add('active');
        el.classList.remove('completed');
      }
      // Steps complétés (avant le step actuel)
      else if (progressStep < step) {
        el.classList.add('completed');
        el.classList.remove('active');
      }
      // Steps futurs
      else {
        el.classList.remove('active', 'completed');
      }
    });
  } else {
    console.warn('[ViewManager] progressSteps not ready or empty');
  }

  // ✅ INCHANGÉ: Gestion des colonnes selon le step
  if (step === 1) {
    // Step 1: 2 colonnes (Order Summary + Form)
    if (DOM.checkoutContent) {
      DOM.checkoutContent.classList.remove('three-columns');
    }
    if (DOM.userInfoRecap) {
      DOM.userInfoRecap.classList.remove('show');
    }
  } else if (step === 2) {
    // Step 2: 3 colonnes (Order Summary + User Info + Payment)
    console.log('[ViewManager] Step 2: Activating 3-column layout');
    
    if (DOM.checkoutContent) {
      DOM.checkoutContent.classList.add('three-columns');
    }
    
    // Populer et afficher le recap
    this.populateUserRecap();
    
    if (DOM.userInfoRecap) {
      // Petit délai pour l'animation
      setTimeout(() => {
        DOM.userInfoRecap.classList.add('show');
      }, 50);
    }
  }
  
  // Mettre à jour les boutons
  this.updateCheckoutButtons();
},

populateUserRecap() {
  console.log('[ViewManager] Populating user info recap');
  
  const { name, linkUrl, imageUrl } = AppState.orderData;
  
  // Name
  if (DOM.recapName) {
    DOM.recapName.textContent = name || '—';
  }
  
  // URL
  if (DOM.recapUrl) {
    if (linkUrl) {
      DOM.recapUrl.textContent = this.truncateUrl(linkUrl, 35);
      DOM.recapUrl.href = linkUrl;
      DOM.recapUrl.style.pointerEvents = 'auto';
    } else {
      DOM.recapUrl.textContent = '—';
      DOM.recapUrl.href = '#';
      DOM.recapUrl.style.pointerEvents = 'none';
    }
  }
  
  // Image
  if (DOM.recapImage && DOM.recapImageWrapper) {
    const noImageSpan = DOM.recapImageWrapper.querySelector('.recap-no-image');
    
    if (imageUrl) {
      DOM.recapImage.src = imageUrl;
      DOM.recapImage.style.display = 'block';
      if (noImageSpan) noImageSpan.style.display = 'none';
    } else {
      DOM.recapImage.style.display = 'none';
      if (noImageSpan) noImageSpan.style.display = 'block';
    }
  }
},

truncateUrl(url, maxLength = 40) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    const path = urlObj.pathname + urlObj.search;
    
    if (path.length <= 1) {
      return domain;
    }
    
    const full = domain + path;
    if (full.length <= maxLength) {
      return full;
    }
    
    return domain + path.substring(0, maxLength - domain.length - 3) + '...';
  } catch (e) {
    return url.length > maxLength ? url.substring(0, maxLength - 3) + '...' : url;
  }
},
    updateSummary() {
      const { blocks, totalAmount, unitPrice } = AppState.orderData;
      const pixels = blocks.length * 100;
      
      DOM.summaryPixels.textContent = pixels.toLocaleString(locale);
      DOM.summaryPrice.textContent = `$${unitPrice.toLocaleString(locale, { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      })}`;
      DOM.summaryTotal.textContent = `$${totalAmount.toLocaleString(locale, { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      })}`;
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
  
  // 🔥 LIMITER à 20×15 max
  const maxWidth = 20;
  const maxHeight = 15;
  
  const displayWidth = Math.min(width, maxWidth);
  const displayHeight = Math.min(height, maxHeight);
  
  // Calculer le centre de la sélection (centrer si trop grand)
  const startCol = width > maxWidth ? minCol + Math.floor((width - maxWidth) / 2) : minCol;
  const startRow = height > maxHeight ? minRow + Math.floor((height - maxHeight) / 2) : minRow;
  
  const endCol = startCol + displayWidth - 1;
  const endRow = startRow + displayHeight - 1;
  
  // Filtrer les blocs à afficher
  const displayBlocks = blocks.filter(idx => {
    const r = Math.floor(idx / N);
    const c = idx % N;
    return r >= startRow && r <= endRow && c >= startCol && c <= endCol;
  });
  
  DOM.pixelPreview.innerHTML = `
    <div class="preview-grid" style="--cols: ${displayWidth}; --rows: ${displayHeight}">
      ${displayBlocks.map(idx => {
        const r = Math.floor(idx / N) - startRow;
        const c = (idx % N) - startCol;
        return `<div class="preview-pixel" style="--r: ${r}; --c: ${c}"></div>`;
      }).join('')}
    </div>
    <div class="preview-info">
      ${width}×${height} blocks
      ${(width > maxWidth || height > maxHeight) ? '<span class="preview-truncated"> (preview)</span>' : ''}
    </div>
  `;
},
 
startLockTimer() {
  console.log('[Timer] Starting 5-minute countdown');
  
  const hbRunning = window.LockManager?.heartbeat?.isRunning?.();
  if (!hbRunning) {
    console.warn('[Timer] Not starting: heartbeat not running');
    if (DOM.timerValue) DOM.timerValue.textContent = 'Reservation expired 😱';
    return;
  }
  
  if (AppState.lockTimer) {
    clearInterval(AppState.lockTimer);
    AppState.lockTimer = null;
  }

  // ✅ TIMESTAMP ABSOLU (résistant au throttling)
  AppState.lockStartTime = Date.now();
  const LOCK_DURATION_MS = 300000; // 5 min

  const updateDisplay = () => {
    // ✅ TOUJOURS CALCULER DEPUIS LE TIMESTAMP RÉEL
    const elapsed = Date.now() - AppState.lockStartTime;
    const remaining = Math.max(0, Math.floor((LOCK_DURATION_MS - elapsed) / 1000));
    
    AppState.lockSecondsRemaining = remaining;
    
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    if (DOM.timerValue) {
      if (remaining > 0) {
        DOM.timerValue.textContent = `Reserved for ${minutes}:${seconds.toString().padStart(2, '0')}`;
      } else {
        DOM.timerValue.textContent = 'Reservation expired 😱';
      }
    }

    if (remaining <= 0) {
      clearInterval(AppState.lockTimer);
      AppState.lockTimer = null;
      console.log('[Timer] Countdown reached 0:00');
      return;
    }
  };

  updateDisplay();
  AppState.lockTimer = setInterval(updateDisplay, 1000);
  
  // ✅ FORCER UPDATE QUAND L'ONGLET REVIENT AU PREMIER PLAN
  const handleVisibilityChange = () => {
    if (!document.hidden) {
      console.log('[Timer] Tab visible again, forcing update');
      updateDisplay();
    }
  };
  
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Cleanup au stop
  const originalStop = this.stopAllTimers;
  this.stopAllTimers = function() {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    originalStop.call(this);
  };
},
// Dans app.js - startLockMonitoring
startLockMonitoring(warmupMs = 1200) {
  console.log('[Monitoring] Starting with warmup:', warmupMs);

  if (AppState.lockCheckTimeout) { 
    clearTimeout(AppState.lockCheckTimeout); 
    AppState.lockCheckTimeout = null; 
  }
  if (AppState.lockCheckInterval) { 
    clearInterval(AppState.lockCheckInterval); 
    AppState.lockCheckInterval = null; 
  }

  const checkLocks = async () => {
    const blocks = AppState.orderData.blocks;
    if (!blocks || !blocks.length) return;

    const checkStartTime = Date.now();

    try {
      const status = await apiCall('/status?ts=' + Date.now());
      if (status && status.ok) {
        AppState.locks = window.LockManager.merge(status.locks || {});
        AppState.sold = status.sold || AppState.sold;
        AppState.regions = status.regions || AppState.regions;
      }
    } catch (err) {
      console.warn('[Monitoring] Failed to refresh /status:', err);
    }

    const valid = haveMyValidLocks(blocks, 2000);
    
    // Logs détaillés
    const now = Date.now();
    const firstBlock = blocks[0];
    const lock = AppState.locks[String(firstBlock)];
    
    if (lock) {
      const untilMs = lock.until;
      const remainingMs = untilMs - now;
      const remainingWithGrace = untilMs - (now + 2000);
      
      console.log('[Monitoring] Detailed check:', {
        timerSeconds: AppState.lockSecondsRemaining,
        lockUntil: new Date(untilMs).toISOString(),
        now: new Date(now).toISOString(),
        remainingMs: Math.round(remainingMs),
        remainingWithGrace: Math.round(remainingWithGrace),
        valid: valid
      });
    }
    
    console.log('[Monitoring] Locks valid:', valid, '| Timer:', AppState.lockSecondsRemaining, 's');

    if (AppState.checkoutStep === 1) {
      if (DOM.proceedToPayment) {
        DOM.proceedToPayment.disabled = !valid;
        DOM.proceedToPayment.textContent = valid 
          ? '💳 Continue to Payment' 
          : '⏰ Reservation expired - reselect';
      }
    } else if (AppState.checkoutStep === 2) {
      ViewManager.setPayPalEnabled(valid);
    }

    if (!valid) {
      console.log('[Monitoring] Locks invalid, stopping monitoring & heartbeat');
      
      try { window.LockManager.heartbeat.stop(); } catch (e) {}
      
      if (AppState.lockCheckInterval) {
        clearInterval(AppState.lockCheckInterval);
        AppState.lockCheckInterval = null;
      }
      
      return;
    }

    // ✅ NOUVEAU : Monitoring adaptatif selon temps restant
    if (AppState.lockCheckInterval) {
      clearInterval(AppState.lockCheckInterval);
      AppState.lockCheckInterval = null;
    }

    let nextInterval = 5000;  // 5s par défaut
    
    if (AppState.lockSecondsRemaining <= 10) {
      nextInterval = 2000;  // 2s si < 10s restant
    }
    
    console.log(`[Monitoring] Next check in ${nextInterval}ms`);
    AppState.lockCheckInterval = setTimeout(checkLocks, nextInterval);
  };

  // Premier check après warmup
  AppState.lockCheckTimeout = setTimeout(() => {
    checkLocks();
  }, Math.max(0, warmupMs | 0));

  console.log('[Monitoring] Scheduled with warmup:', warmupMs);
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
      console.time('returnToGrid TOTAL');  // ✅
      console.log('[ViewManager] Returning to grid');
      
      // ✅ Annuler l'order si existe (user était allé jusqu'au paiement)
      if (AppState.currentOrder?.orderId) {
        try {
          await apiCall('/order-status?orderId=' + encodeURIComponent(AppState.currentOrder.orderId) + '&action=cancel');
          console.log('[ViewManager] Order cancelled:', AppState.currentOrder.orderId);
        } catch (e) {
          console.warn('[ViewManager] Failed to cancel order:', e);
        }
      }
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
      

      const grid = document.querySelector('.grid') || document.getElementById('grid');
      if (grid) {
        grid.style.margin = '0 auto';
        grid.style.left = '0';
        grid.style.transform = 'none';
      }

      // Switch view
      this.switchTo('grid');
      
      this.setCheckoutStep(1);
      // ✅ AJOUTER CET APPEL
      this.updateCheckoutButtons();
      // Refresh
      await StatusManager.load();
      GridManager.paintAll();
      console.timeEnd('returnToGrid TOTAL');
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

        // 🔥 NOUVEAU : Selection guide logic
  const selectionGuide = document.getElementById('selectionGuide');
  let hasUserDragged = false;
  let isMouseOverGrid = false;
  
  const updateGuidePosition = (e) => {
    if (hasUserDragged || !isMouseOverGrid || !selectionGuide) return;
    
    const rect = DOM.grid.getBoundingClientRect();
    const offsetX = 20;
    const offsetY = 20;
    
    selectionGuide.style.left = (e.clientX - rect.left + offsetX) + 'px';
    selectionGuide.style.top = (e.clientY - rect.top + offsetY) + 'px';
  };
  
  const dismissGuide = () => {
    hasUserDragged = true;
    if (selectionGuide) {
      selectionGuide.classList.add('dismissed');
      selectionGuide.classList.remove('show');
    }
  };
  
  // Mouse enter grid
  DOM.grid.addEventListener('mouseenter', (e) => {
    isMouseOverGrid = true;
    if (!hasUserDragged && AppState.selected.size === 0 && selectionGuide) {
      selectionGuide.classList.add('show');
      updateGuidePosition(e);
    }
  });
  
  // Mouse leave grid
  DOM.grid.addEventListener('mouseleave', () => {
    isMouseOverGrid = false;
    if (selectionGuide) {
      selectionGuide.classList.remove('show');
    }
  });
  
  // Mouse move on grid
  DOM.grid.addEventListener('mousemove', (e) => {
    updateGuidePosition(e);
  });
      
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
        // 🔥 Dismiss guide au premier drag
    if (!hasUserDragged) {
      dismissGuide();
    }
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
  
  // 🔥 METTRE À JOUR LE CONTENU
  const detailsEl = DOM.selectionInfo.querySelector('.selection-details');
  if (detailsEl) {
    detailsEl.innerHTML = 
      `<span class="count">${count.toLocaleString(locale)}</span> pixels • $${total.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  // 🔥 PAS DE CALCUL DE POSITION - FIXE EN CSS !
  DOM.selectionInfo.classList.add('show');
},
    
    updateTopbar() {
      const priceEl = DOM.priceLine;
      if (priceEl) {
        // Format avec 2 décimales selon locale
        priceEl.textContent = `$${AppState.globalPrice.toLocaleString(locale, { 
          minimumFractionDigits: 2, 
          maximumFractionDigits: 2 
        })}/px`;
      }
      DOM.pixelsLeft.textContent = '1M PIXELs';
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
    
    // Setup order data
    AppState.orderData = {
      blocks: lockResult.locked || blocks,
      name: '',
      linkUrl: '',
      imageUrl: null,
      regionId: lockResult.regionId || null,
      totalAmount: lockResult.totalAmount || GridManager.calculateTotal(blocks.length * 100),
      unitPrice: lockResult.unitPrice || AppState.globalPrice
    };
    
    window.reservedTotal = AppState.orderData.totalAmount;
    window.reservedPrice = AppState.orderData.unitPrice;
    
    console.log('[CheckoutFlow] Order data:', AppState.orderData);
    
    // ✅ START HEARTBEAT UNE SEULE FOIS - 5 MIN MAX
    window.LockManager.heartbeat.start(AppState.orderData.blocks, {
      intervalMs: 30000,     // 30s
      ttlMs: 180000,         // 3 min par renewal
      maxTotalMs: 300000,    // ✅ 5 MIN MAX TOTAL
      autoUnlock: true
    });
    
    // Switch to checkout
    ViewManager.switchTo('checkout');
    
  } catch (e) {
    console.error('[Checkout] Failed:', e);
    Toast.error('Failed to reserve pixels. Please try again.');
  }
},
    
async processForm() {
  console.log('[CheckoutFlow] Processing form');
  
  // ✅ DEBOUNCE: Empêcher double-click
  if (this._processing) {
    console.warn('[CheckoutFlow] Already processing, ignoring click');
    return;
  }
  this._processing = true;
  
  try {
    // Reset erreurs
    document.querySelectorAll('.field-error').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('input').forEach(el => el.classList.remove('error'));
    
    const name = DOM.nameInput.value.trim();
    
    // Normaliser URL AVANT de la récupérer dans une variable
    const linkInput = DOM.linkInput;
    let linkUrl = '';
    
    if (linkInput && linkInput.value.trim()) {
      linkUrl = this.normalizeUrl(linkInput.value.trim());
      // Mettre à jour l'input avec l'URL normalisée
      linkInput.value = linkUrl;
    }
    
    let hasError = false;
    
    if (!name) {
      this.showFieldError('name', 'This field is required.');
      hasError = true;
    }
    
    if (!linkUrl) {
      this.showFieldError('link', 'This field is required.');
      hasError = true;
    } else if (!this.isValidUrl(linkUrl)) {
      this.showFieldError('link', 'Please enter a valid URL.');
      hasError = true;
    }
    
    if (!AppState.uploadedImageCache || !AppState.uploadedImageCache.imageUrl) {
      this.showFieldError('image', 'Please upload an image.');
      hasError = true;
    }
    
    if (hasError) {
      this._processing = false;
      return;
    }
    
    const uploadAge = Date.now() - AppState.uploadedImageCache.uploadedAt;
    if (uploadAge > 300000) {
      Toast.warning('Image upload expired, please reselect your image');
      AppState.uploadedImageCache = null;
      this._processing = false;
      return;
    }
    
    if (!haveMyValidLocks(AppState.orderData.blocks, 1000)) {
      //await StatusManager.load();
      Toast.warning('Your reservation expired. Please reselect your pixels.');
      ViewManager.returnToGrid();
      this._processing = false;
      return;
    }

    AppState.orderData.name = name;
    AppState.orderData.linkUrl = linkUrl;
    AppState.orderData.imageUrl = AppState.uploadedImageCache.imageUrl;
    AppState.orderData.regionId = AppState.uploadedImageCache.regionId;
    
    console.log('[CheckoutFlow] Order data before step 2:', AppState.orderData);

    await window.LockManager.lock(AppState.orderData.blocks, 180000, { optimistic: false });

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
    
    await window.LockManager.lock(AppState.orderData.blocks, 180000, { optimistic: false });

    ViewManager.setCheckoutStep(2);
    
    // ✅ ATTENDRE DOM STABLE
    console.log('[CheckoutFlow] Waiting for DOM to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await this.initializePayPal();
    
  } catch (e) {
    console.error('[Order] Failed:', e);
    Toast.error('Failed to process order: ' + (e.message || e));
  } finally {
    setTimeout(() => {
      this._processing = false;
    }, 1000);
  }
},

    showFieldError(fieldName, message) {
  const input = document.getElementById(fieldName);
  const error = document.getElementById(`${fieldName}-error`);
  
  if (input) {
    input.classList.add('error');
    input.focus();
  }
  
  if (error) {
    error.textContent = message;
    error.classList.add('show');
  }
},

isValidUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
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
      // ✅ VÉRIFIER CONTAINER
      const container = document.getElementById('paypal-button-container');
      if (!container) {
        console.error('[PayPal] Container not found');
        Toast.error('PayPal initialization failed');
        return;
      }
      if (!document.body.contains(container)) {
        console.warn('[PayPal] Container not in DOM, waiting...');
        await new Promise(resolve => setTimeout(resolve, 200));
        
        if (!document.body.contains(container)) {
          console.error('[PayPal] Container still not in DOM');
          Toast.error('PayPal initialization failed');
          return;
        }
      }
      // ✅ CLEAR CONTAINER
      console.log('[CheckoutFlow] Clearing PayPal container');
      container.innerHTML = '';
              
      console.log('[CheckoutFlow] Rendering PayPal buttons');
      
      await window.PayPalIntegration.initAndRender({
        orderId: AppState.currentOrder.orderId,
        currency: AppState.currentOrder.currency,

        onApproved: async (data, actions) => {
          console.log('[PayPal] Payment approved');
          
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
              return;
            }

            // Succès complet
            console.log('[PayPal] Order completed successfully');
            Toast.success('Payment successful! Your spot is now live! 🎉', 5000);
            // ⭐ NOUVEAU : Retourner à la grille avec highlight
            await this.returnToGridWithHighlight();

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
        },

        onError: async (err) => {
          console.error('[PayPal] Error:', err);
          
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
      console.log('[CheckoutFlow] PayPal buttons initialized');
    },
    
    async waitForCompleted(orderId, maxSeconds = 120) {
      const maxAttempts = 12;
      let delay = 1000;
      
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const status = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
          
          if (status?.ok) {
            // ✅ Utiliser effectiveStatus (normalisé par backend)
            const s = String(status.effectiveStatus || status.status || '').toLowerCase();
            if (s === 'completed') return true;
            if (s === 'failed' || s === 'cancelled') return false;  // Simplifié : backend normalise tout en 'failed'
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

  const grid = document.querySelector('.grid') || document.getElementById('grid');
if (grid) {
  grid.style.margin = '0 auto';
  grid.style.left = '0';
  grid.style.transform = 'none';
}

  // Switch to grid SANS scroll
  ViewManager.switchTo('grid', { keepScroll: true });
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
  
  // ⭐ ATTENDRE QUE LA GRILLE SOIT VISIBLE (800ms au lieu de 500ms)
  setTimeout(() => {
    this.highlightAndScrollToPurchasedPixels(purchasedBlocks);
  }, 800);

},

highlightAndScrollToPurchasedPixels(blocks) {
  if (!blocks || !blocks.length) return;
  
    // Débloquer overflow (sera nettoyé automatiquement au retour)
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
    
  // Calculer position
  const minRow = Math.min(...blocks.map(i => Math.floor(i / 100)));
  const maxRow = Math.max(...blocks.map(i => Math.floor(i / 100)));
  const minCol = Math.min(...blocks.map(i => i % 100));
  const maxCol = Math.max(...blocks.map(i => i % 100));
  
  const cell = DOM.grid.children[0];
  if (!cell) return;
  
  const cellSize = cell.getBoundingClientRect().width;
  const firstPurchasedCell = DOM.grid.children[blocks[0]];
  if (!firstPurchasedCell) return;
  
  const cellRect = firstPurchasedCell.getBoundingClientRect();
  const cellTopInDocument = window.scrollY + cellRect.top;
  const targetScroll = cellTopInDocument - 150;
  
  console.log('[Highlight] Scrolling to:', targetScroll);
  
  // Scroll direct
  window.scrollTo(0, targetScroll);
  
  // Force après 100ms
  setTimeout(() => {
    if (window.scrollY < 50) {
      document.documentElement.scrollTop = targetScroll;
      document.body.scrollTop = targetScroll;
    }
  }, 100);
  
  // Créer highlight après 500ms
  setTimeout(() => {
    const highlight = document.createElement('div');
    highlight.style.cssText = `
      position: absolute;
      left: ${minCol * cellSize}px;
      top: ${minRow * cellSize}px;
      width: ${(maxCol - minCol + 1) * cellSize}px;
      height: ${(maxRow - minRow + 1) * cellSize}px;
      border: 3px solid #a21caf;
      background: rgba(162, 28, 175, 0.15);
      box-shadow: 0 0 30px rgba(162, 28, 175, 0.6), inset 0 0 30px rgba(162, 28, 175, 0.2);
      pointer-events: none;
      z-index: 1001;
      border-radius: 4px;
      animation: highlightPulse 2s ease-in-out 3;
    `;
    
    if (!document.getElementById('highlight-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'highlight-pulse-style';
      style.textContent = `
        @keyframes highlightPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.02); }
        }
      `;
      document.head.appendChild(style);
    }
    
    DOM.grid.appendChild(highlight);
    
    setTimeout(() => {
      highlight.style.opacity = '0';
      highlight.style.transition = 'opacity 0.5s';
      setTimeout(() => highlight.remove(), 500);
    }, 6000);
  }, 500);
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
    pollingInterval: null,
    async load() {
      console.log('[StatusManager.load] Called at', performance.now().toFixed(2));  // ✅
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
    
    /*startPolling() {
      setInterval(async () => {
        await this.load();
      }, 3500); // 3.5s optimisé
    }*/
   startPolling() {
  // ✅ Protection contre double appel
  if (this.pollingInterval) {
    console.warn('[StatusManager] Polling already running!');
    return;
  }
  
  console.log('[StatusManager] Starting polling (3.5s)');
  this.pollingInterval = setInterval(async () => {
    console.log('[StatusManager] Polling tick');
    await this.load();
  }, 3500);
}
  };

  // ===== EVENT HANDLERS =====
  const EventHandlers = {
    init() {
      console.log('[EventHandlers] Initializing');
      
      // Buy button
      if (DOM.claimBtn) {
        DOM.claimBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          
          // ✅ Force refresh pour avoir locks à jour
          console.log('[Claim] Force refreshing status before claim...');
          await StatusManager.load();
          
          // ✅ Re-vérifier si blocks toujours disponibles
          const blockedIndexes = [];
          for (const idx of AppState.selected) {
            if (GridManager.isBlocked(idx)) {
              blockedIndexes.push(idx);
            }
          }
          
          if (blockedIndexes.length > 0) {
            Toast.error(`${blockedIndexes.length} block(s) were just reserved by another user. Please select again.`);
            GridManager.clearSelection();
            return;
          }
          
          console.log('[Claim] All blocks still available, proceeding...');
          
          console.log('[EventHandlers] Claim clicked');
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
      
// Edit info button
if (DOM.editInfoBtn) {
  DOM.editInfoBtn.addEventListener('click', () => {
    console.log('[EventHandlers] Edit info clicked');
    
    // ✅ NOUVEAU: Vérifier si les locks sont encore valides
    const blocks = AppState.orderData?.blocks || [];
    const locksValid = haveMyValidLocks(blocks, 2000);
    
    if (!locksValid) {
      console.warn('[EventHandlers] Cannot edit: locks expired');
      Toast.warning('Your reservation has expired. Please start over.');
      return; // ❌ Bloquer l'action
    }
    
    // ✅ Locks valides, permettre l'édition
    ViewManager.setCheckoutStep(1);
    
    // Scroll vers le formulaire
    setTimeout(() => {
      const form = document.getElementById('checkoutForm');
      if (form) {
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  });
}
     // Continue to Payment button (maintenant hors du form)
if (DOM.proceedToPayment) {
  DOM.proceedToPayment.addEventListener('click', async (e) => {
    e.preventDefault();
    
    // Si on est au step 1, valider et soumettre le formulaire
    if (AppState.checkoutStep === 1) {
      console.log('[EventHandlers] Continue to Payment clicked');
      
      // Déclencher la validation du formulaire
      const form = DOM.checkoutForm;
      if (!form) return;
      
      // Utiliser la validation HTML5
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      
      // Valider et continuer
      await CheckoutFlow.processForm();
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
  /*function renderRegions() {
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
  }*/
 // Remplacer renderRegions() par cette version ULTRA-OPTIMISÉE

function renderRegions() {
  console.time('renderRegions');
  console.trace('[renderRegions] Called from'); 
  
  const gridEl = DOM.grid;
  if (!gridEl) return;
  
  // Supprimer anciens overlays
  gridEl.querySelectorAll('.region-overlay').forEach(n => n.remove());
  
  const firstCell = gridEl.children[0];
  const size = firstCell ? firstCell.offsetWidth : 10;
  
  // Build regionLink map
  const regionLink = {};
  for (const [idx, s] of Object.entries(AppState.sold)) {
    const regionId = s.regionId || s.region_id;
    const linkUrl = s.linkUrl || s.link_url;
    if (s && regionId && !regionLink[regionId] && linkUrl) {
      regionLink[regionId] = linkUrl;
    }
  }
  
  // ✅ DocumentFragment pour éviter reflows
  const fragment = document.createDocumentFragment();
  
  for (const [rid, reg] of Object.entries(AppState.regions)) {
    if (!reg || !reg.rect || !reg.imageUrl) continue;
    const { x, y, w, h } = reg.rect;
    const idxTL = y * 100 + x;
    
    // ✅ Accès direct au lieu de querySelector
    const tl = gridEl.children[idxTL];
    if (!tl) continue;
    
    const a = document.createElement('a');
    a.className = 'region-overlay';
    if (regionLink[rid]) {
      a.href = regionLink[rid];
      a.target = '_blank';
      a.rel = 'noopener nofollow';
    }
    
    // ✅ Inline styles (plus rapide que Object.assign)
    a.style.cssText = `
      position: absolute;
      left: ${tl.offsetLeft}px;
      top: ${tl.offsetTop}px;
      width: ${w * size}px;
      height: ${h * size}px;
      background-image: url("${reg.imageUrl}");
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      z-index: 999;
    `;
    
    fragment.appendChild(a);
  }
  
  // ✅ 1 seul appendChild = 1 seul reflow
  gridEl.appendChild(fragment);
  
  gridEl.style.position = 'relative';
  gridEl.style.zIndex = 2;
  
  console.timeEnd('renderRegions');
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
      //buyBtn: document.getElementById('buyBtn'),
      claimBtn: document.getElementById('claimBtn'),
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
      // ✅ AJOUTER ces nouvelles références
      userInfoRecap: document.getElementById('userInfoRecap'),
      recapName: document.getElementById('recapName'),
      recapUrl: document.getElementById('recapUrl'),
      recapImage: document.getElementById('recapImage'),
      recapImageWrapper: document.getElementById('recapImageWrapper'),
      editInfoBtn: document.getElementById('editInfoBtn'),
      checkoutContent: document.querySelector('.checkout-content'),
      
      // Steps
      steps: {
        1: document.getElementById('step1'),
        2: document.getElementById('step2')
      },
      progressSteps: document.querySelectorAll('.progress-step')
    };
    
    // Initialize modules
    GridManager.init();
    ImageUpload.init();
    EventHandlers.init();

    // ✅ Exposer renderRegions AVANT le load
    window.renderRegions = renderRegions;
    window.ImageUpload = ImageUpload;
    window.getSelectedIndices = () => Array.from(AppState.selected);
    window.reservedTotal = 0;
    window.reservedPrice = 0;

    // Load status
    console.log('[App] Loading initial status...');
    console.time('Initial status load');
    await StatusManager.load();
    console.timeEnd('Initial status load');
    GridManager.paintAll();
    
    // Start polling
    StatusManager.startPolling();
    
    // Debug API
    window.AppDebug = {
      AppState,
      ViewManager,
      GridManager,
      CheckoutFlow,
      StatusManager,
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

// Price info tooltip - Standalone
(function() {
  'use strict';
  
  function initPriceTooltip() {
    const priceInfoBtn = document.getElementById('priceInfoBtn');
    const priceTooltip = document.getElementById('priceTooltip');
    
    console.log('Price info button:', priceInfoBtn);
    console.log('Price tooltip:', priceTooltip);
    
    if (!priceInfoBtn || !priceTooltip) {
      console.error('Price info elements not found!');
      return;
    }

    // 🔥 FORMATTER LE NOMBRE DE PIXELS SELON LOCALE
    const tooltipPixelCount = document.getElementById('tooltipPixelCount');
    if (tooltipPixelCount) {
      const locale = navigator.language || 'en-US';
      tooltipPixelCount.textContent = (1000).toLocaleString(locale);
    }
    const tooltipPixelraise = document.getElementById('tooltipPixelraise');
    if (tooltipPixelraise) {
      const locale = navigator.language || 'en-US';
      tooltipPixelraise.textContent = ` +$${(0.01).toLocaleString(locale)}`;
    }
    
    let tooltipTimeout = null;
    
    // Click to toggle
    priceInfoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      console.log('Button clicked!');
      priceTooltip.classList.toggle('show');
      
      // Auto-hide après 5 secondes
      if (priceTooltip.classList.contains('show')) {
        console.log('Tooltip shown');
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => {
          priceTooltip.classList.remove('show');
        }, 5000);
      }
    });
    
    // Fermer si on clique ailleurs
    document.addEventListener('click', (e) => {
      if (!priceInfoBtn.contains(e.target) && !priceTooltip.contains(e.target)) {
        priceTooltip.classList.remove('show');
        clearTimeout(tooltipTimeout);
      }
    });
    
    // Fermer au scroll
    window.addEventListener('scroll', () => {
      if (priceTooltip.classList.contains('show')) {
        priceTooltip.classList.remove('show');
        clearTimeout(tooltipTimeout);
      }
    }, { passive: true });
  }
  
  // Init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPriceTooltip);
  } else {
    initPriceTooltip();
  }
})()