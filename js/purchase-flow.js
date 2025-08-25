// purchase-flow.js — Gestionnaire unifié du flux d'achat avec validation précoce
(function() {
  'use strict';

  if (!window.CoreManager) {
    console.error('[PurchaseFlow] CoreManager required');
    return;
  }
  if (!window.Errors) {
    console.error('[PurchaseFlow] Errors required');
    return;
  }

  const { apiCall } = window.CoreManager;

  // États du flux d'achat
  const STATES = {
    IDLE: 'idle',
    RESERVING: 'reserving', 
    VALIDATING: 'validating',
    UPLOADING: 'uploading',
    FINALIZING: 'finalizing',
    SUCCESS: 'success',
    ERROR: 'error'
  };

  class PurchaseFlow {
    constructor() {
      this.state = STATES.IDLE;
      this.currentPurchase = null;
      this.listeners = new Set();
      
      // Nettoyage automatique si user quitte
      window.addEventListener('beforeunload', () => this.cleanup());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.cleanup();
      });
    }

    // Event system
    on(event, callback) {
      this.listeners.add({ event, callback });
    }

    emit(event, data) {
      this.listeners.forEach(({ event: e, callback }) => {
        if (e === event) {
          try { callback(data); } catch {}
        }
      });
    }

    // ÉTAPE 1: Réserver les blocks
    async reserve(blocks, userData = {}) {
      if (this.state !== STATES.IDLE) {
        throw window.Errors.create('INVALID_STATE', 'Purchase already in progress');
      }

      this.setState(STATES.RESERVING);
      
      try {
        const response = await apiCall('/reserve', {
          method: 'POST',
          body: JSON.stringify({ blocks, ttl: 300000 }) // 5 minutes
        });

        if (!response?.ok) {
          throw window.Errors.create('RESERVE_FAILED', response?.error || 'Failed to reserve blocks');
        }

        this.currentPurchase = {
          blocks: response.locked || blocks,
          userData,
          tempId: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          reservedAt: Date.now()
        };

        this.emit('reserved', this.currentPurchase);
        return this.currentPurchase;

      } catch (error) {
        this.setState(STATES.ERROR);
        throw error;
      }
    }

    // ÉTAPE 2: Valider l'image AVANT upload
    async validateImage(file) {
      if (!this.currentPurchase) {
        throw window.Errors.create('NO_ACTIVE_PURCHASE', 'No active purchase to validate image for');
      }

      this.setState(STATES.VALIDATING);
      
      try {
        // Validation côté client d'abord
        await this.validateImageClient(file);
        
        // Validation côté serveur (upload test)
        const tempPath = await this.uploadToTemp(file);
        
        this.currentPurchase.tempImagePath = tempPath;
        this.currentPurchase.imageFile = file;
        
        this.emit('imageValidated', { file, tempPath });
        return tempPath;

      } catch (error) {
        this.setState(STATES.ERROR);
        throw error;
      }
    }

    // Validation côté client
    async validateImageClient(file) {
      if (!file) {
        throw window.Errors.create('NO_FILE', 'No file selected');
      }

      // Taille
      if (file.size > 1.5 * 1024 * 1024) {
        throw window.Errors.create('FILE_TOO_LARGE', 'Image too large (max 1.5 MB)');
      }

      // Type MIME déclaré
      if (!file.type || !file.type.startsWith('image/')) {
        throw window.Errors.create('INVALID_FILE_TYPE', 'Invalid file type');
      }

      // Extension
      const ext = file.name.toLowerCase().split('.').pop();
      if (!['jpg', 'jpeg', 'png', 'gif'].includes(ext)) {
        throw window.Errors.create('INVALID_FILE_TYPE', 'Invalid file extension');
      }

      // Magic bytes
      const realType = await this.detectRealImageType(file);
      if (!realType) {
        throw window.Errors.create('INVALID_FILE_TYPE', 'File is not a valid image');
      }

      return true;
    }

    // Détection du type réel via magic bytes
    async detectRealImageType(file) {
      const buffer = await file.slice(0, 12).arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // JPEG: FF D8 FF
      if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
      }
      
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes.length >= 8 && 
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
          bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return 'image/png';
      }
      
      // GIF: "GIF87a" ou "GIF89a"
      if (bytes.length >= 6) {
        const header = String.fromCharCode(...bytes.slice(0, 6));
        if (header === 'GIF87a' || header === 'GIF89a') {
          return 'image/gif';
        }
      }

      return null;
    }

    // Upload vers dossier temporaire
    async uploadToTemp(file) {
      this.setState(STATES.UPLOADING);
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('tempId', this.currentPurchase.tempId);
      formData.append('action', 'validate');

      const response = await apiCall('/upload-temp', {
        method: 'POST',
        body: formData
      });

      if (!response?.ok) {
        throw window.Errors.create('UPLOAD_FAILED', response?.error || 'Failed to upload image');
      }

      return response.tempPath;
    }

    // ÉTAPE 3: Finaliser l'achat (atomique)
    async finalize(userData) {
      if (!this.currentPurchase?.tempImagePath) {
        throw window.Errors.create('NO_VALIDATED_IMAGE', 'No validated image found');
      }

      this.setState(STATES.FINALIZING);

      try {
        const response = await apiCall('/finalize-v2', {
          method: 'POST',
          body: JSON.stringify({
            ...userData,
            blocks: this.currentPurchase.blocks,
            tempImagePath: this.currentPurchase.tempImagePath,
            tempId: this.currentPurchase.tempId
          })
        });

        if (!response?.ok) {
          throw window.Errors.create('FINALIZE_FAILED', response?.error || 'Failed to finalize purchase');
        }

        this.setState(STATES.SUCCESS);
        
        const result = {
          ...response,
          blocks: this.currentPurchase.blocks,
          userData
        };

        this.emit('success', result);
        this.currentPurchase = null; // Clear
        
        return result;

      } catch (error) {
        this.setState(STATES.ERROR);
        throw error;
      }
    }

    // Nettoyage/annulation
    async cleanup() {
      if (!this.currentPurchase) return;

      try {
        // Libérer les locks
        if (this.currentPurchase.blocks?.length) {
          await apiCall('/unlock', {
            method: 'POST',
            body: JSON.stringify({ blocks: this.currentPurchase.blocks }),
            keepalive: true
          });
        }

        // Nettoyer l'image temporaire
        if (this.currentPurchase.tempImagePath) {
          await apiCall('/cleanup-temp', {
            method: 'POST', 
            body: JSON.stringify({ tempPath: this.currentPurchase.tempImagePath }),
            keepalive: true
          });
        }
      } catch {}

      this.currentPurchase = null;
      this.setState(STATES.IDLE);
    }

    // Annulation manuelle
    async cancel() {
      await this.cleanup();
      this.emit('cancelled');
    }

    // État
    setState(newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('stateChanged', { from: oldState, to: newState });
    }

    getState() {
      return this.state;
    }

    getCurrentPurchase() {
      return this.currentPurchase;
    }

    isActive() {
      return this.state !== STATES.IDLE && this.state !== STATES.SUCCESS && this.state !== STATES.ERROR;
    }
  }

  // Export global
  window.PurchaseFlow = PurchaseFlow;
  window.PURCHASE_STATES = STATES;
})();