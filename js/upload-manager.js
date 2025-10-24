// upload-manager.js — Gestionnaire unifié pour tous les uploads d'images (validation stricte + erreurs normalisées)
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
  function throwInvalidType() {
    if (window.Errors) throw window.Errors.create('INVALID_FILE_TYPE', 'Invalid file type', { retriable: false });
    throw new Error('Invalid file type');
  }
  function throwTooLarge() {
    if (window.Errors) throw window.Errors.create('FILE_TOO_LARGE', 'File too large', { retriable: false });
    throw new Error('File too large');
  }
  function throwNoFile() {
    if (window.Errors) throw window.Errors.create('NO_FILE', 'No file selected', { retriable: false });
    throw new Error('No file selected');
  }

  // Sniff des magic-bytes pour JPEG/PNG/GIF
  async function sniffMime(file) {
    const blob = file.slice(0, 12);
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // JPEG: FF D8 FF
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
        bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return 'image/png';
    // GIF: "GIF87a" ou "GIF89a"
    if (bytes.length >= 6) {
      const hdr = String.fromCharCode(...bytes.slice(0,6));
      if (hdr === 'GIF87a' || hdr === 'GIF89a') return 'image/gif';
    }
    // WEBP (non autorisé ici): RIFF....WEBP
    if (bytes.length >= 12) {
      const riff = String.fromCharCode(...bytes.slice(0,4));
      const webp = String.fromCharCode(...bytes.slice(8,12));
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    }
    return '';
  }

  class UploadManager {

    constructor() {
  this.MAX_SIZE = 1.5 * 1024 * 1024; // 1.5MB max
  this.ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
}


    // Validation stricte (async pour sniff)
    async validateFile(file) {
      if (!file) throwNoFile();

      // Taille brute côté navigateur
      if (file.size > this.MAX_SIZE) throwTooLarge();

      // Sniff du type réel
      const sniffed = await sniffMime(file);
      if (!this.ALLOWED_TYPES.includes(sniffed)) throwInvalidType();

      // Si le browser donne un type incohérent, on refuse
      if (file.type && file.type.length > 0 && file.type !== sniffed) throwInvalidType();

      return sniffed;
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
            resolve({ base64Data, fullDataUrl, contentType: file.type || '' });
          } catch {
            reject(new Error('Failed to read file'));
          }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    // Upload générique (ex: upload-addon.js)
    // --- upload-manager.js (patch) ---
async uploadGeneric(file, options = {}) {
  try {
    const sniffedType = await this.validateFile(file);
    const { base64Data } = await this.toBase64(file);

    const approxBytes = Math.floor((base64Data.length * 3) / 4);
    if (approxBytes > this.MAX_SIZE) throwTooLarge();

    const payload = {
      filename: file.name,
      contentType: sniffedType,
      contentBase64: base64Data,       // << was "data"
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

    // Normaliser la réponse
    return {
      ok: true,
      imageUrl: response.imageUrl || response.url || '',
      path: response.path || '',
      regionId: response.regionId || payload.regionId || ''
    };
  } catch (e) {
    rethrowUpload(e);
  }
}

async uploadForRegion(file, regionId) {
  try {
    if (!regionId) throw new Error('Missing regionId');
    const sniffedType = await this.validateFile(file);
    const { base64Data } = await this.toBase64(file);

    const approxBytes = Math.floor((base64Data.length * 3) / 4);
    if (approxBytes > this.MAX_SIZE) throwTooLarge();

    const payload = {
      regionId,
      filename: file.name,
      contentType: sniffedType,
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

    return {
      ok: true,
      imageUrl: response.imageUrl || response.url || '',
      path: response.path || '',
      regionId
    };
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
        if (window.Errors) {
          const n = window.Errors.normalize(e);
          throw window.Errors.create('LINK_FAILED', n.message, { status: n.status, retriable: false, details: n.details });
        }
        throw e;
      }
    }
  }

  // Export global
  window.UploadManager = new UploadManager();
})();