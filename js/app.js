// app.js - Main application orchestrator (refactored)
(function() {
  'use strict';

  // ===== CONFIGURATION & DEPENDENCIES =====
  if (!window.CoreManager || !window.LockManager || !window.AppState || !window.ViewManager ||
      !window.GridManager || !window.CheckoutFlow || !window.StatusManager) {
    console.error('[App] Missing dependencies');
    return;
  }

  const { uid, apiCall } = window.CoreManager;
  const AppState = window.AppState;
  const DOM = window.DOM;
  const ViewManager = window.ViewManager;
  const GridManager = window.GridManager;
  const CheckoutFlow = window.CheckoutFlow;
  const StatusManager = window.StatusManager;
  const Toast = window.Toast;
  const Modal = window.Modal;
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

          // Check stale upload
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

  // ===== EVENT HANDLERS =====
  const EventHandlers = {
    init() {
      console.log('[EventHandlers] Initializing');

      // Buy button
      if (DOM.claimBtn) {
        DOM.claimBtn.addEventListener('click', async (e) => {
          e.preventDefault();

          // Force refresh to have locks up to date
          console.log('[Claim] Force refreshing status before claim...');
          await StatusManager.load();

          // Re-check if blocks still available
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
              if (confirmed) { ViewManager.returnToGrid(); }
            });
          }
        });
      }

      // Edit info button
      if (DOM.editInfoBtn) {
        DOM.editInfoBtn.addEventListener('click', () => {
          console.log('[EventHandlers] Edit info clicked');

          // Check if locks are still valid
          const blocks = AppState.orderData?.blocks || [];
          const locksValid = haveMyValidLocks(blocks, 2000);

          if (!locksValid) {
            console.warn('[EventHandlers] Cannot edit: locks expired');
            Toast.warning('Your reservation has expired. Please start over.');
            return; // Block the action
          }

          // Locks valid, allow editing
          ViewManager.setCheckoutStep(1);
          // ✅ RESET LE BOUTON "CONTINUE TO PAYMENT"
          if (DOM.proceedToPayment) {
            DOM.proceedToPayment.disabled = false;
            DOM.proceedToPayment.textContent = '💳 Continue to Payment';
            DOM.proceedToPayment.style.opacity = '1';
          }

          // Scroll to form
          setTimeout(() => {
            const form = document.getElementById('checkoutForm');
            if (form) {
              form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 100);
        });
      }

      // Continue to Payment button (now outside the form)
      if (DOM.proceedToPayment) {
        DOM.proceedToPayment.addEventListener('click', async (e) => {
          e.preventDefault();

          // If at step 1, validate and submit the form
          if (AppState.checkoutStep === 1) {
            console.log('[EventHandlers] Continue to Payment clicked');

            // Trigger form validation
            const form = DOM.checkoutForm;
            if (!form) return;

            // Use HTML5 validation
            if (!form.checkValidity()) {
              form.reportValidity();
              return;
            }

            // Validate and continue
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
  function renderRegions() {
    console.time('renderRegions');
    console.trace('[renderRegions] Called from');

    const gridEl = DOM.grid;
    if (!gridEl) return;

    // Remove old overlays
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

    // DocumentFragment to avoid reflows
    const fragment = document.createDocumentFragment();

    for (const [rid, reg] of Object.entries(AppState.regions)) {
      if (!reg || !reg.rect || !reg.imageUrl) continue;
      const { x, y, w, h } = reg.rect;
      const idxTL = y * 100 + x;

      // Direct access instead of querySelector
      const tl = gridEl.children[idxTL];
      if (!tl) continue;

      const a = document.createElement('a');
      a.className = 'region-overlay';
      if (regionLink[rid]) {
        a.href = regionLink[rid];
        a.target = '_blank';
        a.rel = 'noopener nofollow';
      }

      // Inline styles (faster than Object.assign)
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

    // 1 single appendChild = 1 single reflow
    gridEl.appendChild(fragment);

    gridEl.style.position = 'relative';
    gridEl.style.zIndex = 2;

    console.timeEnd('renderRegions');
  }

  // ===== INITIALIZATION =====
  async function init() {
    console.log('[App] Initializing unified version with full lock logic');

    // Initialize DOM references
    Object.assign(DOM, {
      // Views
      mainContainer: document.getElementById('mainContainer'),
      gridView: document.getElementById('gridView'),
      checkoutView: document.getElementById('checkoutView'),

      // Grid
      grid: document.getElementById('grid'),
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
    });

    // Initialize modules
    GridManager.init();
    ImageUpload.init();
    EventHandlers.init();

    // Expose renderRegions BEFORE load
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

    // Format pixel count according to locale
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

      // Auto-hide after 5 seconds
      if (priceTooltip.classList.contains('show')) {
        console.log('Tooltip shown');
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => {
          priceTooltip.classList.remove('show');
        }, 5000);
      }
    });

    // Close if clicking elsewhere
    document.addEventListener('click', (e) => {
      if (!priceInfoBtn.contains(e.target) && !priceTooltip.contains(e.target)) {
        priceTooltip.classList.remove('show');
        clearTimeout(tooltipTimeout);
      }
    });

    // Close on scroll
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
})();
