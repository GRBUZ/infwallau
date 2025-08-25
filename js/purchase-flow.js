// purchase-flow.js — Gestionnaire unifié du flux d'achat avec validation précoce (VERSION CORRIGÉE)
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

  // ✅ États du flux d'achat AVEC RESERVED
  const STATES = {
    IDLE: 'idle',
    RESERVING: 'reserving', 
    RESERVED: 'reserved',     // ✅ AJOUTÉ
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

    // ✅ ÉTAPE 1: Réserver les blocks AVEC ÉTAT CORRECT
    async reserve(blocks, userData = {}) {
      if (this.state !== STATES.IDLE) {
        throw window.Errors.create('INVALID_STATE', 'Purchase already in progress');
      }

      console.log('[PurchaseFlow] Starting reservation for blocks:', blocks);
      this.setState(STATES.RESERVING);
      
      try {
        // ✅ TIMEOUT pour éviter les blocages
        const reservePromise = apiCall('/reserve', {
          method: 'POST',
          body: JSON.stringify({ blocks, ttl: 300000 }) // 5 minutes
        });

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RESERVE_TIMEOUT')), 10000); // 10s timeout
        });

        console.log('[PurchaseFlow] Calling /reserve API...');
        const response = await Promise.race([reservePromise, timeoutPromise]);
        
        console.log('[PurchaseFlow] Reserve response:', response);

        if (!response) {
          throw window.Errors.create('RESERVE_FAILED', 'No response from server');
        }

        if (!response.ok) {
          throw window.Errors.create('RESERVE_FAILED', response?.error || 'Failed to reserve blocks');
        }

        this.currentPurchase = {
          blocks: response.locked || blocks,
          userData,
          tempId: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          reservedAt: Date.now()
        };

        console.log('[PurchaseFlow] Reservation successful:', this.currentPurchase);
        
        // ✅ CORRECTION : Rester en état "reserved"
        this.setState(STATES.RESERVED);
        
        this.emit('reserved', this.currentPurchase);
        return this.currentPurchase;

      } catch (error) {
        console.error('[PurchaseFlow] Reservation failed:', error);
        this.setState(STATES.ERROR);
        
        // ✅ Messages d'erreur spécifiques
        if (error.message === 'RESERVE_TIMEOUT') {
          throw window.Errors.create('RESERVE_TIMEOUT', 'Réservation trop lente. Vérifiez votre connexion.');
        }
        
        throw error;
      }
    }

    // ✅ ÉTAPE 2: Valider l'image AVANT upload AVEC ÉTAT CORRECT
    async validateImage(file) {
      // ✅ CORRECTION : Accepter l'état "reserved"
      if (!this.currentPurchase || this.state !== STATES.RESERVED) {
        throw window.Errors.create('NO_ACTIVE_PURCHASE', 'No active purchase to validate image for');
      }

      console.log('[PurchaseFlow] Starting image validation:', file);
      this.setState(STATES.VALIDATING);
      
      try {
        // Validation côté client d'abord
        await this.validateImageClient(file);
        
        // ✅ Upload vers dossier temporaire AVEC TIMEOUT
        const uploadPromise = this.uploadToTemp(file);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('UPLOAD_TIMEOUT')), 30000); // 30s timeout
        });

        console.log('[PurchaseFlow] Uploading to temp...');
        const tempPath = await Promise.race([uploadPromise, timeoutPromise]);
        
        this.currentPurchase.tempImagePath = tempPath;
        this.currentPurchase.imageFile = file;
        
        console.log('[PurchaseFlow] Image validation successful:', tempPath);
        this.emit('imageValidated', { file, tempPath });
        return tempPath;

      } catch (error) {
        console.error('[PurchaseFlow] Image validation failed:', error);
        this.setState(STATES.ERROR);
        
        if (error.message === 'UPLOAD_TIMEOUT') {
          throw window.Errors.create('UPLOAD_TIMEOUT', 'Upload trop lent. Vérifiez votre connexion.');
        }
        
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

    // ✅ Upload vers dossier temporaire AVEC DEBUGGING
    async uploadToTemp(file) {
      this.setState(STATES.UPLOADING);
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('tempId', this.currentPurchase.tempId);
      formData.append('action', 'validate');

      console.log('[PurchaseFlow] FormData prepared:', {
        fileName: file.name,
        fileSize: file.size,
        tempId: this.currentPurchase.tempId
      });

      // ✅ Utiliser CoreManager avec headers appropriés
      const response = await window.CoreManager.apiCallMultipart('/upload-temp', formData);
      
      console.log('[PurchaseFlow] Upload temp response:', response);

      if (!response?.ok) {
        throw window.Errors.create('UPLOAD_FAILED', response?.error || 'Failed to upload image');
      }

      return response.tempPath;
    }

    // ✅ ÉTAPE 3: Finaliser l'achat (atomique) AVEC TIMEOUT
    async finalize(userData) {
      if (!this.currentPurchase?.tempImagePath) {
        throw window.Errors.create('NO_VALIDATED_IMAGE', 'No validated image found');
      }

      console.log('[PurchaseFlow] Starting finalization:', userData);
      this.setState(STATES.FINALIZING);

      try {
        const finalizePromise = apiCall('/finalize-v2', {
          method: 'POST',
          body: JSON.stringify({
            ...userData,
            blocks: this.currentPurchase.blocks,
            tempImagePath: this.currentPurchase.tempImagePath,
            tempId: this.currentPurchase.tempId
          })
        });

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('FINALIZE_TIMEOUT')), 45000); // 45s timeout
        });

        console.log('[PurchaseFlow] Calling /finalize-v2...');
        const response = await Promise.race([finalizePromise, timeoutPromise]);

        console.log('[PurchaseFlow] Finalize response:', response);

        if (!response?.ok) {
          throw window.Errors.create('FINALIZE_FAILED', response?.error || 'Failed to finalize purchase');
        }

        this.setState(STATES.SUCCESS);
        
        const result = {
          ...response,
          blocks: this.currentPurchase.blocks,
          userData
        };

        console.log('[PurchaseFlow] Purchase completed successfully:', result);
        this.emit('success', result);
        this.currentPurchase = null; // Clear
        
        return result;

      } catch (error) {
        console.error('[PurchaseFlow] Finalization failed:', error);
        this.setState(STATES.ERROR);
        
        if (error.message === 'FINALIZE_TIMEOUT') {
          throw window.Errors.create('FINALIZE_TIMEOUT', 'Finalisation trop lente. Votre achat peut avoir réussi, rechargez la page.');
        }
        
        throw error;
      }
    }

    // Nettoyage/annulation
    async cleanup() {
      if (!this.currentPurchase) return;

      console.log('[PurchaseFlow] Cleaning up purchase:', this.currentPurchase);

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
      } catch (error) {
        console.warn('[PurchaseFlow] Cleanup failed:', error);
      }

      this.currentPurchase = null;
      this.setState(STATES.IDLE);
    }

    // Annulation manuelle
    async cancel() {
      console.log('[PurchaseFlow] Manual cancellation');
      await this.cleanup();
      this.emit('cancelled');
    }

    // État
    setState(newState) {
      const oldState = this.state;
      this.state = newState;
      console.log(`[PurchaseFlow] State change: ${oldState} → ${newState}`);
      this.emit('stateChanged', { from: oldState, to: newState });
    }

    getState() {
      return this.state;
    }

    getCurrentPurchase() {
      return this.currentPurchase;
    }

    // ✅ CORRECTION : isActive inclut RESERVED
    isActive() {
      return this.state !== STATES.IDLE && this.state !== STATES.SUCCESS && this.state !== STATES.ERROR;
    }
  }

  // Export global
  window.PurchaseFlow = PurchaseFlow;
  window.PURCHASE_STATES = STATES;
})();