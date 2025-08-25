// purchase-ui.js — Interface utilisateur pour le nouveau flux d'achat (CORRIGÉ)
(function() {
  'use strict';

  if (!window.PurchaseFlow) {
    console.error('[PurchaseUI] PurchaseFlow required');
    return;
  }
  if (!window.Errors) {
    console.error('[PurchaseUI] Errors required');
    return;
  }

  class PurchaseUI {
    constructor() {
      this.flow = new window.PurchaseFlow();
      this.selectedBlocks = new Set();
      this.currentStep = 'selecting'; // selecting, form, processing, success
      
      this.initDOM();
      this.initEvents();
      this.initFlowEvents();
      this.initGrid(); // ✅ AJOUTÉ
    }

    initDOM() {
      // Elements principaux
      this.grid = document.getElementById('grid');
      this.buyBtn = document.getElementById('buyBtn');
      this.modal = document.getElementById('modal');
      this.form = document.getElementById('form');
      this.confirmBtn = document.getElementById('confirm');
      
      // Inputs du formulaire
      this.nameInput = document.getElementById('name');
      this.emailInput = document.getElementById('email');
      this.linkInput = document.getElementById('link');
      this.fileInput = document.getElementById('image');
      
      // Elements de statut
      this.modalStats = document.getElementById('modalStats');
      this.progressEl = this.createProgressElement();
    }

    // ✅ NOUVEAU - Initialisation de la grille
    initGrid() {
      if (!this.grid) return;
      
      // Construction de la grille si vide
      if (this.grid.children.length === 0) {
        this.buildGrid();
      }
      
      // Événements de sélection
      this.initGridEvents();
    }

    buildGrid() {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 10000; i++) { // 100x100
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.idx = i;
        fragment.appendChild(cell);
      }
      this.grid.appendChild(fragment);
    }

    initGridEvents() {
      let isDragging = false;
      let dragStartIdx = -1;
      
      // ✅ Gestion du clic et drag pour sélection
      this.grid.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.cell');
        if (!cell) return;
        
        const idx = parseInt(cell.dataset.idx);
        if (this.isBlockBlocked(idx)) return;
        
        isDragging = true;
        dragStartIdx = idx;
        this.selectRect(idx, idx);
        e.preventDefault();
      });
      
      this.grid.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const cell = e.target.closest('.cell');
        if (!cell) return;
        
        const idx = parseInt(cell.dataset.idx);
        this.selectRect(dragStartIdx, idx);
      });
      
      document.addEventListener('mouseup', () => {
        isDragging = false;
        dragStartIdx = -1;
      });
      
      // Clic simple pour toggle
      this.grid.addEventListener('click', (e) => {
        if (isDragging) return;
        
        const cell = e.target.closest('.cell');
        if (!cell) return;
        
        const idx = parseInt(cell.dataset.idx);
        if (this.isBlockBlocked(idx)) return;
        
        this.toggleBlock(idx);
      });
    }

    // ✅ Sélection rectangulaire
    selectRect(startIdx, endIdx) {
      const N = 100;
      const startRow = Math.floor(startIdx / N);
      const startCol = startIdx % N;
      const endRow = Math.floor(endIdx / N);
      const endCol = endIdx % N;
      
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      
      // Vérifier s'il y a des blocks bloqués dans la sélection
      let hasBlocked = false;
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const idx = r * N + c;
          if (this.isBlockBlocked(idx)) {
            hasBlocked = true;
            break;
          }
        }
        if (hasBlocked) break;
      }
      
      if (hasBlocked) {
        // Afficher erreur visuelle
        this.showInvalidSelection(minRow, minCol, maxRow, maxCol);
        return;
      }
      
      // Effacer ancienne sélection
      this.clearSelection();
      
      // Nouvelle sélection
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const idx = r * N + c;
          this.selectedBlocks.add(idx);
          this.updateBlockVisual(idx);
        }
      }
      
      this.updateBuyButton();
    }

    toggleBlock(idx) {
      if (this.isBlockBlocked(idx)) return;
      
      if (this.selectedBlocks.has(idx)) {
        this.selectedBlocks.delete(idx);
      } else {
        this.selectedBlocks.add(idx);
      }
      
      this.updateBlockVisual(idx);
      this.updateBuyButton();
    }

    isBlockBlocked(idx) {
      // Vérifier si le block est vendu ou locké par un autre
      const sold = window.sold || {};
      const locks = window.locks || {};
      
      if (sold[idx]) return true;
      
      const lock = locks[idx];
      if (lock && lock.until > Date.now() && lock.uid !== window.uid) {
        return true;
      }
      
      return false;
    }

    showInvalidSelection(minRow, minCol, maxRow, maxCol) {
      // Effet visuel pour sélection invalide
      console.warn('Invalid selection: blocked cells detected');
      window.Errors?.showToast('Cette zone contient des pixels déjà vendus', 'warn');
    }

    createProgressElement() {
      let progress = document.getElementById('purchaseProgress');
      if (!progress) {
        progress = document.createElement('div');
        progress.id = 'purchaseProgress';
        progress.className = 'purchase-progress hidden';
        progress.innerHTML = `
          <div class="progress-content">
            <div class="progress-spinner"></div>
            <div class="progress-text">Processing...</div>
            <div class="progress-detail"></div>
          </div>
        `;
        document.body.appendChild(progress);
      }
      return progress;
    }

    initEvents() {
      // Bouton d'achat
      if (this.buyBtn) {
        this.buyBtn.addEventListener('click', () => this.onBuyClick());
      }

      // Formulaire
      if (this.form) {
        this.form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.onFormSubmit();
        });
      }

      // Bouton de confirmation
      if (this.confirmBtn) {
        this.confirmBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.onFormSubmit();
        });
      }

      // Fermeture modal
      document.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', () => this.closeModal());
      });

      // ESC pour fermer
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isModalOpen()) {
          this.closeModal();
        }
      });

      // Validation en temps réel du fichier
      if (this.fileInput) {
        this.fileInput.addEventListener('change', () => this.onFileChange());
      }
    }

    initFlowEvents() {
      this.flow.on('stateChanged', ({ from, to }) => {
        console.log(`[PurchaseUI] State: ${from} → ${to}`);
        this.updateUI(to);
      });

      this.flow.on('reserved', (purchase) => {
        console.log('[PurchaseUI] Blocks reserved:', purchase);
        this.showModal();
        this.updateStats(purchase.blocks);
      });

      this.flow.on('imageValidated', ({ file, tempPath }) => {
        console.log('[PurchaseUI] Image validated:', tempPath);
        this.showProgress('Image validée', 'Finalisation en cours...');
      });

      this.flow.on('success', (result) => {
        console.log('[PurchaseUI] Purchase successful:', result);
        this.showSuccess(result);
        this.refreshGrid();
      });

      this.flow.on('cancelled', () => {
        console.log('[PurchaseUI] Purchase cancelled');
        this.closeModal();
        this.clearSelection();
      });
    }

    // Gestion de la sélection de blocks
    clearSelection() {
      this.selectedBlocks.forEach(idx => this.updateBlockVisual(idx));
      this.selectedBlocks.clear();
      this.updateBuyButton();
    }

    updateBlockVisual(blockIndex) {
      const cell = this.grid?.children[blockIndex];
      if (!cell) return;
      
      // Retirer toutes les classes d'état
      cell.classList.remove('sel', 'pending', 'sold');
      
      // État du block
      const sold = window.sold || {};
      const locks = window.locks || {};
      
      if (sold[blockIndex]) {
        cell.classList.add('sold');
        return;
      }
      
      const lock = locks[blockIndex];
      if (lock && lock.until > Date.now() && lock.uid !== window.uid) {
        cell.classList.add('pending');
        return;
      }
      
      if (this.selectedBlocks.has(blockIndex)) {
        cell.classList.add('sel');
      }
    }

    updateBuyButton() {
      if (!this.buyBtn) return;
      
      const count = this.selectedBlocks.size;
      if (count === 0) {
        this.buyBtn.textContent = 'Buy Pixels';
        this.buyBtn.disabled = true;
      } else {
        const pixels = count * 100;
        const price = this.calculatePrice(pixels);
        this.buyBtn.textContent = `Buy ${pixels.toLocaleString()} pixels ($${price.toFixed(2)})`;
        this.buyBtn.disabled = false;
      }
    }

    calculatePrice(pixels) {
      // Logique de prix basée sur le nombre de pixels vendus
      const sold = window.sold || {};
      const soldPixels = Object.keys(sold).length * 100;
      const currentPrice = 1 + Math.floor(soldPixels / 1000) * 0.01;
      return pixels * currentPrice;
    }

    // Actions principales
    async onBuyClick() {
      if (this.selectedBlocks.size === 0) {
        window.Errors?.showToast('Veuillez sélectionner au moins un pixel', 'warn');
        return;
      }
      
      try {
        this.showProgress('Réservation des blocks...');
        
        const blocks = Array.from(this.selectedBlocks);
        console.log('[PurchaseUI] Attempting to reserve blocks:', blocks);
        
        // ✅ CORRECTION : Appeler reserve() du flow
        await this.flow.reserve(blocks);
        
        // La suite est gérée par l'event 'reserved'
        
      } catch (error) {
        console.error('[PurchaseUI] Reserve failed:', error);
        this.hideProgress();
        window.Errors?.notifyError(error, 'Purchase');
      }
    }

    async onFormSubmit() {
      const formData = this.getFormData();
      if (!this.validateFormData(formData)) return;

      try {
        this.currentStep = 'processing';
        this.updateFormUI();

        console.log('[PurchaseUI] Starting image validation...');
        
        // ✅ DÉBOGAGE : Vérifier l'état du flow
        console.log('[PurchaseUI] Flow state:', this.flow.getState());
        console.log('[PurchaseUI] Current purchase:', this.flow.getCurrentPurchase());

        // Étape 1: Valider l'image
        this.showProgress('Validation de l\'image...');
        await this.flow.validateImage(formData.file);

        // Étape 2: Finaliser
        this.showProgress('Finalisation de l\'achat...', 'Cela peut prendre quelques secondes');
        const result = await this.flow.finalize({
          name: formData.name,
          linkUrl: formData.linkUrl,
          email: formData.email
        });

        this.currentStep = 'success';
        
      } catch (error) {
        console.error('[PurchaseUI] Form submit failed:', error);
        this.currentStep = 'form';
        this.updateFormUI();
        this.hideProgress();
        window.Errors?.notifyError(error, 'Purchase');
      }
    }

    onFileChange() {
      const file = this.fileInput?.files?.[0];
      if (!file) return;

      // Validation rapide côté client
      try {
        if (file.size > 1.5 * 1024 * 1024) {
          throw new Error('Image trop lourde (max 1.5 MB)');
        }
        
        if (!file.type.startsWith('image/')) {
          throw new Error('Format invalide (images uniquement)');
        }

        // Visual feedback positif
        this.setFileInputStatus('✓ Image sélectionnée', 'success');
        
      } catch (error) {
        this.setFileInputStatus(error.message, 'error');
        this.fileInput.value = '';
      }
    }

    // Helpers UI
    getFormData() {
      return {
        name: this.nameInput?.value?.trim() || '',
        email: this.emailInput?.value?.trim() || '',
        linkUrl: this.linkInput?.value?.trim() || '',
        file: this.fileInput?.files?.[0] || null
      };
    }

    validateFormData(data) {
      if (!data.name) {
        this.showFieldError(this.nameInput, 'Nom requis');
        return false;
      }
      
      if (!data.linkUrl) {
        this.showFieldError(this.linkInput, 'URL requise');
        return false;
      }
      
      if (!data.file) {
        this.showFieldError(this.fileInput, 'Image requise');
        return false;
      }

      return true;
    }

    showFieldError(input, message) {
      if (!input) return;
      
      input.classList.add('error');
      window.Errors?.showToast(message, 'warn');
      
      // Retirer l'erreur après interaction
      const removeError = () => {
        input.classList.remove('error');
        input.removeEventListener('input', removeError);
        input.removeEventListener('change', removeError);
      };
      
      input.addEventListener('input', removeError);
      input.addEventListener('change', removeError);
    }

    setFileInputStatus(message, type = 'info') {
      // Afficher un statut près du file input
      let status = this.fileInput?.parentNode?.querySelector('.file-status');
      if (!status) {
        status = document.createElement('div');
        status.className = 'file-status';
        this.fileInput?.parentNode?.appendChild(status);
      }
      
      status.textContent = message;
      status.className = `file-status ${type}`;
    }

    updateStats(blocks) {
      if (!this.modalStats) return;
      
      const pixels = blocks.length * 100;
      const price = this.calculatePrice(pixels);
      this.modalStats.textContent = `${pixels.toLocaleString()} pixels — $${price.toFixed(2)}`;
    }

    updateFormUI() {
      if (!this.confirmBtn) return;
      
      if (this.currentStep === 'processing') {
        this.confirmBtn.disabled = true;
        this.confirmBtn.textContent = 'Processing...';
      } else {
        this.confirmBtn.disabled = false;
        this.confirmBtn.textContent = 'Confirm';
      }
    }

    updateUI(flowState) {
      // Mettre à jour l'UI selon l'état du flux
      switch (flowState) {
        case 'reserving':
          this.showProgress('Réservation...');
          break;
        case 'validating':
          this.showProgress('Validation...');
          break;
        case 'uploading':
          this.showProgress('Upload...');
          break;
        case 'finalizing':
          this.showProgress('Finalisation...');
          break;
        case 'success':
          this.hideProgress();
          break;
        case 'error':
          this.hideProgress();
          break;
      }
    }

    // Modal et progress
    showModal() {
      this.modal?.classList.remove('hidden');
    }

    closeModal() {
      this.modal?.classList.add('hidden');
      this.hideProgress();
      
      // ✅ CORRECTION : Appeler cancel() du flow
      if (this.flow.isActive()) {
        this.flow.cancel();
      }
      
      this.currentStep = 'selecting';
      this.updateFormUI();
      
      // Reset du formulaire
      if (this.form) {
        this.form.reset();
      }
    }

    isModalOpen() {
      return !this.modal?.classList.contains('hidden');
    }

    showProgress(message, detail = '') {
      if (!this.progressEl) return;
      
      this.progressEl.querySelector('.progress-text').textContent = message;
      this.progressEl.querySelector('.progress-detail').textContent = detail;
      this.progressEl.classList.remove('hidden');
    }

    hideProgress() {
      this.progressEl?.classList.add('hidden');
    }

    showSuccess(result) {
      this.hideProgress();
      
      window.Errors?.showToast(
        `Achat finalisé ! ${result.soldCount} blocks achetés.`, 
        'success',
        5000
      );
      
      // Fermer modal après un délai
      setTimeout(() => {
        this.closeModal();
        this.clearSelection();
      }, 2000);
    }

    // Refresh grid après achat
    async refreshGrid() {
      try {
        // ✅ Charger le nouvel état
        const response = await window.CoreManager?.apiCall('/status');
        if (response?.ok) {
          window.sold = response.sold || {};
          window.locks = response.locks || {};
          window.regions = response.regions || {};
          
          // Redessiner la grille
          this.redrawGrid();
        }
      } catch (error) {
        console.warn('[PurchaseUI] Failed to refresh grid:', error);
      }
    }

    redrawGrid() {
      // Redessiner tous les blocks
      for (let i = 0; i < 10000; i++) {
        this.updateBlockVisual(i);
      }
      
      // Render regions si fonction disponible
      if (typeof window.renderRegions === 'function') {
        window.renderRegions();
      }
    }

    // ✅ Méthodes publiques pour compatibilité avec app.js
    getSelectedIndices() {
      return Array.from(this.selectedBlocks);
    }

    paintAll() {
      this.redrawGrid();
    }
  }

  // Export global
  window.PurchaseUI = PurchaseUI;

  // Auto-init si DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.purchaseUI = new PurchaseUI();
      
      // ✅ Compatibilité avec ancien app.js
      window.getSelectedIndices = () => window.purchaseUI.getSelectedIndices();
      window.paintAll = () => window.purchaseUI.paintAll();
    });
  } else {
    window.purchaseUI = new PurchaseUI();
    
    // ✅ Compatibilité avec ancien app.js
    window.getSelectedIndices = () => window.purchaseUI.getSelectedIndices();
    window.paintAll = () => window.purchaseUI.paintAll();
  }
})();