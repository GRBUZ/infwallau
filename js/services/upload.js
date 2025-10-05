(function(window){
  'use strict';
  // Lightweight service: prefer existing UploadManager, else minimal fallback.
  async function validateFile(file){
    if (window.UploadManager && typeof window.UploadManager.validateFile === 'function') {
      return window.UploadManager.validateFile(file);
    }
    // naive checks
    if (!file || !file.type || !file.size) throw new Error('Invalid file');
    return true;
  }

  async function uploadForRegion(file, regionId){
    if (window.UploadManager && typeof window.UploadManager.uploadForRegion === 'function') {
      return window.UploadManager.uploadForRegion(file, regionId);
    }
    // fallback: not implemented
    throw new Error('UploadManager unavailable');
  }

  // export
  window.App = window.App || {};
  window.App.upload = { validateFile, uploadForRegion };
})(window);
