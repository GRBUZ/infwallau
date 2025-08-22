// upload-manager.js — Gestionnaire unifié pour tous les uploads d'images
(function() {
  'use strict';
  
  if (!window.CoreManager) {
    console.error('[UploadManager] CoreManager required!');
    return;
  }
  
  class UploadManager {
    constructor() {
      this.MAX_SIZE = 5 * 1024 * 1024; // 5MB max
      this.ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    }
    
    // Validation commune
    validateFile(file) {
      if (!file) throw new Error('No file selected');
      if (!file.type.startsWith('image/')) throw new Error('Please upload an image file');
      if (!this.ALLOWED_TYPES.includes(file.type)) throw new Error('Unsupported image format');
      if (file.size > this.MAX_SIZE) throw new Error('File too large. Max 5MB allowed');
    }
    
    // Conversion base64 commune
    async toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          // Retourner avec ou sans préfixe selon besoin
          const base64Data = result.split(',')[1]; // Sans préfixe
          const fullDataUrl = result; // Avec préfixe
          resolve({ base64Data, fullDataUrl, contentType: file.type });
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }
    
    // Upload générique (comme upload-addon.js)
    async uploadGeneric(file, options = {}) {
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
    }
    
    // Upload avec regionId (comme iw_finalize_upload_patch.js)
    async uploadForRegion(file, regionId) {
      this.validateFile(file);
      
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
    }
    
    // Helper pour lier image à région (de upload-addon.js)
    async linkImageToRegion(regionId, imageUrlOrPath) {
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
    }
  }
  
  // Export global
  window.UploadManager = new UploadManager();
})();