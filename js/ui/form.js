(function(window){
  'use strict';
  const form = document.getElementById('form');
  const nameInput = document.getElementById('name');
  const linkInput = document.getElementById('link');
  const fileInput = document.getElementById('image') || document.querySelector('input[type="file"]');
  function isFormValid(){
    const name = (nameInput?.value || '').trim();
    const link = (linkInput?.value || '').trim();
    const uploaded = window._uploadedImageCache || null;
    const blocks = (typeof window.getSelectedIndices === 'function') ? window.getSelectedIndices() : document.querySelectorAll('.cell.sel').length;
    return !!(name && link && uploaded && blocks);
  }
  function attach(){
    if (!form) return;
    form.addEventListener('input', ()=>{
      document.dispatchEvent(new CustomEvent('form:change'));
    });
    if (fileInput){
      fileInput.addEventListener('change', async (e)=>{
        try {
          if (!e.target.files || !e.target.files[0]) return;
          const f = e.target.files[0];
          await window.App.upload.validateFile(f);
          // delegate actual upload to UploadManager (existing) — we just keep uploaded cache
          const regionId = 'r-' + Date.now();
          const res = await window.App.upload.uploadForRegion(f, regionId);
          if (!res || !res.ok) throw new Error(res && res.error || 'upload failed');
          window._uploadedImageCache = { imageUrl: res.imageUrl, regionId: res.regionId || regionId, uploadedAt: Date.now() };
          document.dispatchEvent(new CustomEvent('upload:done'));
        } catch (err){
          console.error('[form] upload failed', err);
          document.dispatchEvent(new CustomEvent('upload:failed', { detail: err }));
        }
      });
    }
  }
  window.App = window.App || {};
  window.App.ui = window.App.ui || {};
  window.App.ui.form = { attach, isFormValid };
  // auto attach
  setTimeout(()=>{ try{ attach(); }catch(e){} }, 50);
})(window);
