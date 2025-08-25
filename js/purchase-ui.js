// purchase-ui.js — Interface utilisateur pour le nouveau flux d'achat
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

    createProgressElement() {
      // Créer un élément de progression si inexistant
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
        this.showModal();
        this.updateStats(purchase.blocks);
      });

      this.flow.on('imageValidated', ({ file, tempPath }) => {
        this.showProgress('Image validée', 'Finalisation en cours...');
      });

      this.flow.on('success', (result) => {
        this.showSuccess(result);
        this.refreshGrid();
      });

      this.flow.on('cancelled', () => {
        this.closeModal();
        this.clearSelection();
      });
    }

    // Gestion de la sélection de blocks
    addToSelection(blockIndex) {
      this.selectedBlocks.add(blockIndex);
      this.updateBuyButton();
      this.updateBlockVisual(blockIndex);
    }

    removeFromSelection(blockIndex) {
      this.selectedBlocks.delete(blockIndex);
      this.updateBuyButton();
      this.updateBlockVisual(blockIndex);
    }

    clearSelection() {
      this.selectedBlocks.forEach(idx => this.updateBlockVisual(idx));
      this.selectedBlocks.clear();
      this.updateBuyButton();
    }

    updateBlockVisual(blockIndex) {
      const cell = this.grid?.children[blockIndex];
      if (cell) {
        cell.classList.toggle('sel', this.selectedBlocks.has(blockIndex));
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
      const soldPixels = Object.keys(window.sold || {}).length * 100;
      const currentPrice = 1 + Math.floor(soldPixels / 1000) * 0.01;
      return pixels * currentPrice;
    }

    // Actions principales
    async onBuyClick() {
      if (this.selectedBlocks.size === 0) return;
      
      try {
        this.showProgress('Réservation des blocks...');
        
        const blocks = Array.from(this.selectedBlocks);
        await this.flow.reserve(blocks);
        
      } catch (error) {
        this.hideProgress();
        window.Errors.notifyError(error, 'Purchase');
      }
    }

    async onFormSubmit() {
      const formData = this.getFormData();
      if (!this.validateFormData(formData)) return;

      try {
        this.currentStep = 'processing';
        this.updateFormUI();

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
        this.currentStep = 'form';
        this.updateFormUI();
        this.hideProgress();
        window.Errors.notifyError(error, 'Purchase');
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
      this.flow.cancel();
      this.currentStep = 'selecting';
      this.updateFormUI();
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
        if (typeof window.loadStatus === 'function') {
          await window.loadStatus();
        }
        if (typeof window.paintAll === 'function') {
          window.paintAll();
        }
        if (typeof window.renderRegions === 'function') {
          window.renderRegions();
        }
      } catch (error) {
        console.warn('[PurchaseUI] Failed to refresh grid:', error);
      }
    }
  }

  // Export global
  window.PurchaseUI = PurchaseUI;

  // Auto-init si DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.purchaseUI = new PurchaseUI();
    });
  } else {
    window.purchaseUI = new PurchaseUI();
  }
})();