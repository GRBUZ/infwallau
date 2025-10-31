// view-manager.js - View management (grid/checkout transitions)
(function() {
  'use strict';

  // Dependencies check
  if (!window.CoreManager || !window.AppState || !window.LockManager) {
    console.error('[ViewManager] Missing dependencies');
    return;
  }

  const { uid, apiCall } = window.CoreManager;
  const AppState = window.AppState;
  const DOM = window.DOM;
  const N = 100;
  const locale = navigator.language || 'en-US';

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

  // ===== VIEW MANAGEMENT =====
  const ViewManager = {
    _scrollTimeout: null,

    switchTo(view, options = {}) {
      console.log('[ViewManager] Switching to:', view);
      // Cancel any pending scroll
      if (this._scrollTimeout) {
        clearTimeout(this._scrollTimeout);
        this._scrollTimeout = null;
      }
      AppState.view = view;
      DOM.mainContainer.dataset.view = view;

      // Manage body class
      if (view === 'checkout') {
        document.body.classList.add('checkout-mode');
      } else {
        document.body.classList.remove('checkout-mode');
      }

      if (view === 'grid') {
        // Transition to grid
        DOM.checkoutView.classList.remove('active');
        setTimeout(() => {
          DOM.checkoutView.style.display = 'none';
        }, 400);

        DOM.gridView.style.display = 'block';
        requestAnimationFrame(() => {
          DOM.gridView.classList.add('active');
        });

        this.stopAllTimers();

        // Don't scroll to top if keepScroll option is set
        if (!options.keepScroll) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
      else if (view === 'checkout') {
        // Hide selection bubble
        if (DOM.selectionInfo) {
          DOM.selectionInfo.classList.remove('show');
        }

        // Transition to checkout
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

        // Store timeout to cancel later if needed
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

    /*updateCheckoutButtons() {
      if (!DOM.backToGrid || !DOM.proceedToPayment) return;

      const step = AppState.checkoutStep;

      if (step === 1) {
        DOM.backToGrid.style.display = '';
        DOM.proceedToPayment.style.display = '';
        // ✅ NE reset QUE si le bouton n'est pas en train de "Preparing"
  if (DOM.proceedToPayment.textContent !== '⏳ Preparing Payment...') {
    DOM.proceedToPayment.textContent = '💳 Continue to Payment';
    DOM.proceedToPayment.disabled = false;
    DOM.proceedToPayment.style.opacity = '1';
  }
      }
      else if (step === 2) {
        DOM.backToGrid.style.display = '';
        DOM.proceedToPayment.style.display = 'none';
      }
      else if (step === 3) {
        DOM.backToGrid.style.display = 'none';
        DOM.proceedToPayment.style.display = 'none';
      }
    },*/
    updateCheckoutButtons() {
  console.log('[DEBUG] updateCheckoutButtons called, step:', AppState.checkoutStep);
  
  if (!DOM.backToGrid || !DOM.proceedToPayment) return;

  const step = AppState.checkoutStep;
  
  console.log('[DEBUG] Button text AVANT:', DOM.proceedToPayment.textContent);

  if (step === 1) {
    DOM.backToGrid.style.display = '';
    DOM.proceedToPayment.style.display = '';
    
    if (DOM.proceedToPayment.textContent !== '⏳ Preparing Payment...') {
      console.log('[DEBUG] Resetting button text');
      DOM.proceedToPayment.textContent = '💳 Continue to Payment';
      DOM.proceedToPayment.disabled = false;
      DOM.proceedToPayment.style.opacity = '1';
    } else {
      console.log('[DEBUG] Keeping "Preparing Payment..." text');
    }
  }
  else if (step === 2) {
    console.log('[DEBUG] Step 2, hiding button');
    DOM.backToGrid.style.display = '';
    DOM.proceedToPayment.style.display = 'none';
  }
  else if (step === 3) {
    DOM.backToGrid.style.display = 'none';
    DOM.proceedToPayment.style.display = 'none';
  }
  
  console.log('[DEBUG] Button text APRÈS:', DOM.proceedToPayment.textContent);
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

      // Update progress bar with 4 steps
      if (DOM.progressSteps && DOM.progressSteps.forEach) {
        DOM.progressSteps.forEach((el, i) => {
          if (!el) return;

          // Get step number from data-step (0, 1, 2, 3)
          const progressStep = parseInt(el.dataset.step, 10);

          // Step 0 (Selection) is always completed in checkout
          if (progressStep === 0) {
            el.classList.add('completed');
            el.classList.remove('active');
          }
          // Current step
          else if (progressStep === step) {
            el.classList.add('active');
            el.classList.remove('completed');
          }
          // Completed steps (before current step)
          else if (progressStep < step) {
            el.classList.add('completed');
            el.classList.remove('active');
          }
          // Future steps
          else {
            el.classList.remove('active', 'completed');
          }
        });
      } else {
        console.warn('[ViewManager] progressSteps not ready or empty');
      }

      // Manage columns according to step
      if (step === 1) {
        // Step 1: 2 columns (Order Summary + Form)
        if (DOM.checkoutContent) {
          DOM.checkoutContent.classList.remove('three-columns');
        }
        if (DOM.userInfoRecap) {
          DOM.userInfoRecap.classList.remove('show');
        }
      } else if (step === 2) {
        // Step 2: 3 columns (Order Summary + User Info + Payment)
        console.log('[ViewManager] Step 2: Activating 3-column layout');

        if (DOM.checkoutContent) {
          DOM.checkoutContent.classList.add('three-columns');
        }

        // Populate and show recap
        this.populateUserRecap();

        if (DOM.userInfoRecap) {
          // Small delay for animation
          setTimeout(() => {
            DOM.userInfoRecap.classList.add('show');
          }, 50);
        }
      }

      // Update buttons
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

      // Limit to 20×15 max
      const maxWidth = 10;
      const maxHeight = 8;

      const displayWidth = Math.min(width, maxWidth);
      const displayHeight = Math.min(height, maxHeight);

      // Calculate center of selection (center if too large)
      const startCol = width > maxWidth ? minCol + Math.floor((width - maxWidth) / 2) : minCol;
      const startRow = height > maxHeight ? minRow + Math.floor((height - maxHeight) / 2) : minRow;

      const endCol = startCol + displayWidth - 1;
      const endRow = startRow + displayHeight - 1;

      // Filter blocks to display
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
        if (DOM.timerValue) DOM.timerValue.innerHTML = 'Reservation expired 😱';
        return;
      }

      if (AppState.lockTimer) {
        clearInterval(AppState.lockTimer);
        AppState.lockTimer = null;
      }

      AppState.lockStartTime = Date.now();
      const LOCK_DURATION_MS = 300000; // 5 min

      const updateDisplay = () => {
        const elapsed = Date.now() - AppState.lockStartTime;
        const remaining = Math.max(0, Math.floor((LOCK_DURATION_MS - elapsed) / 1000));

        AppState.lockSecondsRemaining = remaining;

        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        const progress = (remaining / 300) * 100;

        if (DOM.timerValue) {
          if (remaining > 0) {
            DOM.timerValue.innerHTML = `
              <div class="circular-timer">
                <svg width="50" height="50" style="transform: rotate(-90deg)">
                  <circle cx="25" cy="25" r="21" fill="none" stroke="#f3f4f6" stroke-width="3"/>
                  <circle cx="25" cy="25" r="21" fill="none"
                    stroke="#ef4444"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-dasharray="132"
                    stroke-dashoffset="${132 - (132 * progress / 100)}"
                    style="transition: stroke-dashoffset 1s linear"/>
                </svg>
                <div class="timer-text">${minutes}:${seconds.toString().padStart(2, '0')}</div>
              </div>
            `;
          } else {
            DOM.timerValue.textContent = 'Reservation expired 😱';
          }
        }

        if (remaining <= 0) {
          clearInterval(AppState.lockTimer);
          AppState.lockTimer = null;
          // ✅ DÉSACTIVER LE BOUTON "CONTINUE TO PAYMENT"
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = true;
            DOM.proceedToPayment.textContent = '⏰ Reservation expired - reselect';
            DOM.proceedToPayment.style.opacity = '0.5';
          }
          return;
        }
      };

      updateDisplay();
      AppState.lockTimer = setInterval(updateDisplay, 1000);

      const handleVisibilityChange = () => {
        if (!document.hidden) {
          console.log('[Timer] Tab visible again, forcing update');
          updateDisplay();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);

      const originalStop = this.stopAllTimers;
      this.stopAllTimers = function() {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        originalStop.call(this);
      };
    },

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

        // Detailed logs
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
            // ✅ NE reset que si le bouton n'est pas en train de "Preparing"
            if (DOM.proceedToPayment.textContent !== '⏳ Preparing Payment...') {
              DOM.proceedToPayment.disabled = !valid;
              DOM.proceedToPayment.textContent = valid
                ? '💳 Continue to Payment'
                : '⏰ Reservation expired - reselect';
            }
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

        // Adaptive monitoring based on remaining time
        if (AppState.lockCheckInterval) {
          clearInterval(AppState.lockCheckInterval);
          AppState.lockCheckInterval = null;
        }

        let nextInterval = 5000;  // 5s by default

        if (AppState.lockSecondsRemaining <= 10) {
          nextInterval = 2000;  // 2s if < 10s remaining
        }

        console.log(`[Monitoring] Next check in ${nextInterval}ms`);
        AppState.lockCheckInterval = setTimeout(checkLocks, nextInterval);
      };

      // First check after warmup
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
      console.time('returnToGrid TOTAL');

      window.StatusManager.pausePolling();

      try { window.LockManager.heartbeat.stop(); } catch (e) {}

      // Switch view
      const grid = document.querySelector('.grid') || document.getElementById('grid');
      if (grid) {
        grid.style.margin = '0 auto';
        grid.style.left = '0';
        grid.style.transform = 'none';
      }

      this.switchTo('grid');
      this.setCheckoutStep(1);
      this.updateCheckoutButtons();

      window.GridManager.clearSelection();
      this.clearCheckoutForm();

      if (DOM.proceedToPayment) {
        DOM.proceedToPayment.disabled = false;
        DOM.proceedToPayment.textContent = '💳 Continue to Payment';
      }

      // Call renderRegions() immediately (with data already in memory)
      if (window.renderRegions) {
        window.renderRegions();
      }

      // Then make network calls in background
      const unlockPromise = AppState.orderData.blocks.length
        ? window.LockManager.unlock(AppState.orderData.blocks)
            .then(() => console.log('[ViewManager] Unlocked', AppState.orderData.blocks.length, 'blocks'))
            .catch(e => console.warn('[Unlock] Failed:', e))
        : Promise.resolve();

      if (AppState.currentOrder?.orderId) {
        apiCall('/order-status?orderId=' + encodeURIComponent(AppState.currentOrder.orderId) + '&action=cancel')
          .catch(e => console.warn('[ViewManager] Failed to cancel order:', e));
      }

      const loadPromise = window.StatusManager.load();

      await Promise.all([unlockPromise, loadPromise]);

      window.GridManager.paintAll();

      // Reset state
      AppState.orderData = { blocks: [], name: '', linkUrl: '', imageUrl: null, regionId: null, totalAmount: 0, unitPrice: 0 };
      AppState.selected.clear();
      AppState.uploadedImageCache = null;
      AppState.currentOrder = null;

      window.StatusManager.resumePolling();

      console.timeEnd('returnToGrid TOTAL');
    }
  };

  // Export to global scope
  window.ViewManager = ViewManager;
})();
