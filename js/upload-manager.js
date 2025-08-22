// upload-manager.js — Gestionnaire unifié pour tous les uploads d'images (avec gestion d'erreurs via errors.js)
(function() {
  'use strict';

  if (!window.CoreManager) {
    console.error('[UploadManager] CoreManager required!');
    return;
  }
  if (!window.Errors) {
    console.warn('[UploadManager] errors.js not loaded; falling back to generic errors.');
  }

  // Helpers d'erreurs
  function rethrowUpload(err) {
    if (window.Errors) {
      const n = window.Errors.normalize(err);
      throw window.Errors.create('UPLOAD_FAILED', n.message, { status: n.status, retriable: false, details: n.details });
    }
    throw err instanceof Error ? err : new Error(String(err || 'Upload failed'));
  }
  function rethrowLink(err) {
    if (window.Errors) {
      const n = window.Errors.normalize(err);
      throw window.Errors.create('LINK_FAILED', n.message, { status: n.status, retriable: false, details: n.details });
    }
    throw err instanceof Error ? err : new Error(String(err || 'Link failed'));
  }

  class UploadManager {
    constructor() {
      this.MAX_SIZE = 5 * 1024 * 1024; // 5MB max
      this.ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    }

    // Validation commune
    validateFile(file) {
      if (!file) throw new Error('No file selected');
      if (!file.type || !file.type.startsWith('image/')) throw new Error('Please upload an image file');
      if (!this.ALLOWED_TYPES.includes(file.type)) throw new Error('Unsupported image format');
      if (file.size > this.MAX_SIZE) throw new Error('File too large. Max 5MB allowed');
    }

    // Conversion base64 commune
    async toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const result = reader.result || '';
            const base64Data = String(result).split(',')[1] || ''; // Sans préfixe
            const fullDataUrl = result; // Avec préfixe
            resolve({ base64Data, fullDataUrl, contentType: file.type });
          } catch (e) {
            reject(new Error('Failed to read file'));
          }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    // Upload générique (ex: upload-addon.js)
    async uploadGeneric(file, options = {}) {
      try {
        this.validateFile(file);

        const { base64Data, contentType } = await this.toBase64(file);

        const payload = {
          filename: file.name,
          contentType,
          data: base64Data,
          ...options
        };

        const response = await window.CoreManager.apiCall('/upload', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        if (!response || !response.ok) {
          const msg = (response && (response.message || response.error)) || 'Upload failed';
          throw new Error(msg);
        }

        return response;
      } catch (e) {
        rethrowUpload(e);
      }
    }

    // Upload avec regionId (ex: finalize-addon.js → event finalize:success)
    async uploadForRegion(file, regionId) {
      try {
        this.validateFile(file);
        if (!regionId) throw new Error('Missing regionId');

        const { base64Data } = await this.toBase64(file);

        const payload = {
          regionId,
          filename: file.name,
          contentBase64: base64Data
        };

        const response = await window.CoreManager.apiCall('/upload', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        if (!response || !response.ok) {
          const msg = (response && (response.message || response.error)) || 'Upload failed';
          throw new Error(msg);
        }

        return response;
      } catch (e) {
        rethrowUpload(e);
      }
    }

    // Helper pour lier image à région (utilisé par upload-addon.js)
    async linkImageToRegion(regionId, imageUrlOrPath) {
      try {
        if (!regionId || !imageUrlOrPath) {
          throw new Error('Missing regionId or imageUrl');
        }

        const response = await window.CoreManager.apiCall('/link-image', {
          method: 'POST',
          body: JSON.stringify({ regionId, imageUrl: imageUrlOrPath })
        });

        if (!response || !response.ok) {
          throw new Error(response?.error || 'Failed to link image');
        }

        return response;
      } catch (e) {
        rethrowLink(e);
      }
    }
  }

  // Export global
  window.UploadManager = new UploadManager();
})();