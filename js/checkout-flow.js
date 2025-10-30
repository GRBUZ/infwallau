// checkout-flow.js - Checkout process management
(function() {
  'use strict';

  // Dependencies check
  if (!window.CoreManager || !window.AppState || !window.LockManager || !window.ViewManager || !window.GridManager) {
    console.error('[CheckoutFlow] Missing dependencies');
    return;
  }

  const { uid, apiCall } = window.CoreManager;
  const AppState = window.AppState;
  const DOM = window.DOM;
  const ViewManager = window.ViewManager;
  const GridManager = window.GridManager;
  const Toast = window.Toast;
  const N = 100;

  //  ===== VALIDATION LOCKS =====
  function haveMyValidLocks(arr, graceMs = 2000) {
    if (!arr || !arr.length) return false;
    const now = Date.now() + Math.max(0, graceMs | 0);
    for (const i of arr) {
      const l = AppState.locks[String(i)];
      if (!l || l.uid !== uid || !(l.until > now)) return false;
    }
    return true;
  }

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
        // Immediate feedback (< 10ms)
        DOM.claimBtn.disabled = true;
        DOM.claimBtn.textContent = '⏳ Reserving...';
        DOM.claimBtn.style.opacity = '0.6';

        // Lock with LockManager retry
        const lockResult = await window.LockManager.lock(blocks, 180000);

        if (!lockResult.ok || lockResult.conflicts?.length) {
          console.warn('[CheckoutFlow] Lock failed or conflicts');
          GridManager.showInvalidArea(0, 0, N-1, N-1);
          GridManager.clearSelection();
          // Reset button
          DOM.claimBtn.disabled = false;
          DOM.claimBtn.textContent = 'Claim Your Spot';
          DOM.claimBtn.style.opacity = '1';
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
        // START HEARTBEAT ONCE - 5 MIN MAX
        window.LockManager.heartbeat.start(AppState.orderData.blocks, {
          intervalMs: 30000,     // 30s
          ttlMs: 180000,         // 3 min per renewal
          maxTotalMs: 300000,    // 5 MIN MAX TOTAL
          autoUnlock: true
        });

        // Switch to checkout
        ViewManager.switchTo('checkout');
        // Reset button (important for return)
        DOM.claimBtn.disabled = false;
        DOM.claimBtn.textContent = 'Claim Your Spot';
        DOM.claimBtn.style.opacity = '1';
      } catch (e) {
        console.error('[Checkout] Failed:', e);
        Toast.error('Failed to reserve pixels. Please try again.');
        // Reset button
        DOM.claimBtn.disabled = false;
        DOM.claimBtn.textContent = 'Claim Your Spot';
        DOM.claimBtn.style.opacity = '1';
      }
    },

    async processForm() {
      console.log('[CheckoutFlow] Processing form');

      // DEBOUNCE: Prevent double-click
      if (this._processing) {
        console.warn('[CheckoutFlow] Already processing, ignoring click');
        return;
      }
      this._processing = true;

      try {
        // Immediate feedback
        if (DOM.proceedToPayment) {
          DOM.proceedToPayment.disabled = true;
          DOM.proceedToPayment.textContent = '⏳ Preparing Payment...';
          DOM.proceedToPayment.style.opacity = '0.6';
        }

        // Reset errors
        document.querySelectorAll('.field-error').forEach(el => el.classList.remove('show'));
        document.querySelectorAll('input').forEach(el => el.classList.remove('error'));

        const name = DOM.nameInput.value.trim();

        // Normalize URL BEFORE getting it in a variable
        const linkInput = DOM.linkInput;
        let linkUrl = '';

        if (linkInput && linkInput.value.trim()) {
          linkUrl = this.normalizeUrl(linkInput.value.trim());
          // Update input with normalized URL
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
          // Reset button on validation error
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = false;
            DOM.proceedToPayment.textContent = '💳 Continue to Payment';
            DOM.proceedToPayment.style.opacity = '1';
          }
          this._processing = false;
          return;
        }

        const uploadAge = Date.now() - AppState.uploadedImageCache.uploadedAt;
        if (uploadAge > 300000) {
          Toast.warning('Image upload expired, please reselect your image');
          AppState.uploadedImageCache = null;

          // Reset button
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = false;
            DOM.proceedToPayment.textContent = '💳 Continue to Payment';
            DOM.proceedToPayment.style.opacity = '1';
          }
          this._processing = false;
          return;
        }

        if (!haveMyValidLocks(AppState.orderData.blocks, 1000)) {
          Toast.warning('Your reservation expired. Please reselect your pixels.');
          ViewManager.returnToGrid();

          // Reset button (will also be reset by returnToGrid, but for safety)
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = false;
            DOM.proceedToPayment.textContent = '💳 Continue to Payment';
            DOM.proceedToPayment.style.opacity = '1';
          }
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

        // Wait for DOM to stabilize
        console.log('[CheckoutFlow] Waiting for DOM to stabilize...');
        await new Promise(resolve => setTimeout(resolve, 100));

        await this.initializePayPal();

        // Success: Reset button (in case user goes back later)
        if (DOM.proceedToPayment) {
          DOM.proceedToPayment.disabled = false;
          DOM.proceedToPayment.textContent = '💳 Continue to Payment';
          DOM.proceedToPayment.style.opacity = '1';
        }

      } catch (e) {
        console.error('[Order] Failed:', e);
        Toast.error('Failed to process order: ' + (e.message || e));

        // Reset button on error
        if (DOM.proceedToPayment) {
          DOM.proceedToPayment.disabled = false;
          DOM.proceedToPayment.textContent = '💳 Continue to Payment';
          DOM.proceedToPayment.style.opacity = '1';
        }

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
      // Verify container
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
      // Clear container
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
              // Handle INSTRUMENT_DECLINED
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

            // Wait for complete finalization
            console.log('[PayPal] Waiting for order completion');
            const completed = await this.waitForCompleted(AppState.currentOrder.orderId, 60);

            if (!completed) {
              console.warn('[PayPal] Order not completed in time');
              this.showWarning('Payment is processing. Please check back soon.');
              return;
            }

            // Complete success
            console.log('[PayPal] Order completed successfully');
            Toast.success('Payment successful! Your spot is now live! 🎉', 5000);
            // Return to grid with highlight
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

          // Don't stop heartbeat - allow retry
          ViewManager.setPayPalEnabled(true);
          Toast.info('Payment cancelled. You can retry or go back.');
        },

        onError: async (err) => {
          console.error('[PayPal] Error:', err);

          ViewManager.setPayPalEnabled(false);

          Toast.error('Payment error occurred. Please try again.');
          // Stop heartbeat and unlock
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
            // Use effectiveStatus (normalized by backend)
            const s = String(status.effectiveStatus || status.status || '').toLowerCase();
            if (s === 'completed') return true;
            if (s === 'failed' || s === 'cancelled') return false;  // Simplified: backend normalizes everything to 'failed'
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

      try { window.LockManager.heartbeat.stop(); } catch (e) {}

      // Switch IMMEDIATELY
      const grid = document.querySelector('.grid') || document.getElementById('grid');
      if (grid) {
        grid.style.margin = '0 auto';
        grid.style.left = '0';
        grid.style.transform = 'none';
      }

      ViewManager.switchTo('grid', { keepScroll: true });
      ViewManager.setCheckoutStep(1);
      ViewManager.clearCheckoutForm();

      // renderRegions RIGHT AWAY (data already in memory)
      if (window.renderRegions) {
        window.renderRegions();
      }

      // Then unlock + load in background
      try {
        await window.LockManager.unlock(purchasedBlocks);
      } catch (e) {}

      await window.StatusManager.load();

      // Reset state
      AppState.orderData = { blocks: [], name: '', linkUrl: '', imageUrl: null, regionId: null, totalAmount: 0, unitPrice: 0 };
      AppState.selected.clear();
      AppState.uploadedImageCache = null;
      AppState.currentOrder = null;

      GridManager.paintAll();

      setTimeout(() => {
        this.highlightAndScrollToPurchasedPixels(purchasedBlocks);
      }, 800);
    },

    highlightAndScrollToPurchasedPixels(blocks) {
      if (!blocks || !blocks.length) return;

      // Unlock overflow (will be cleaned automatically on return)
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';

      // Calculate position
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

      // Direct scroll
      window.scrollTo(0, targetScroll);

      // Force after 100ms
      setTimeout(() => {
        if (window.scrollY < 50) {
          document.documentElement.scrollTop = targetScroll;
          document.body.scrollTop = targetScroll;
        }
      }, 100);

      // Create highlight after 500ms
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

  // Export to global scope
  window.CheckoutFlow = CheckoutFlow;
})();
