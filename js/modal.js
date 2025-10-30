// modal.js - Modal confirmation system
(function() {
  'use strict';

  // ===== MODAL CONFIRMATION SYSTEM =====
  const Modal = {
    show(options) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
          background: white;
          border-radius: 16px;
          padding: 28px;
          max-width: 440px;
          width: 90%;
          box-shadow: 0 20px 50px rgba(0,0,0,0.3);
          transform: scale(0.9);
          transition: transform 0.2s;
        `;

        const title = options.title || 'Confirm';
        const message = options.message || 'Are you sure?';
        const confirmText = options.confirmText || 'Confirm';
        const cancelText = options.cancelText || 'Cancel';
        const type = options.type || 'warning'; // 'warning' | 'danger' | 'info'

        const colors = {
          warning: '#f59e0b',
          danger: '#ef4444',
          info: '#3b82f6'
        };

        modal.innerHTML = `
          <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600; color: #111827;">${title}</h3>
          <p style="margin: 0 0 24px 0; color: #6b7280; line-height: 1.6; font-size: 15px;">${message}</p>
          <div style="display: flex; gap: 12px; justify-content: flex-end;">
            <button id="modal-cancel" style="
              padding: 10px 20px;
              border: 2px solid #e5e7eb;
              background: white;
              color: #374151;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            ">${cancelText}</button>
            <button id="modal-confirm" style="
              padding: 10px 20px;
              border: none;
              background: ${colors[type]};
              color: white;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            ">${confirmText}</button>
          </div>
        `;

        const confirmBtn = modal.querySelector('#modal-confirm');
        const cancelBtn = modal.querySelector('#modal-cancel');

        confirmBtn.addEventListener('mouseover', () => {
          confirmBtn.style.transform = 'translateY(-2px)';
          confirmBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        });
        confirmBtn.addEventListener('mouseout', () => {
          confirmBtn.style.transform = '';
          confirmBtn.style.boxShadow = '';
        });

        cancelBtn.addEventListener('mouseover', () => {
          cancelBtn.style.background = '#f3f4f6';
        });
        cancelBtn.addEventListener('mouseout', () => {
          cancelBtn.style.background = 'white';
        });

        const close = (result) => {
          overlay.style.opacity = '0';
          modal.style.transform = 'scale(0.9)';
          setTimeout(() => {
            overlay.remove();
            resolve(result);
          }, 200);
        };

        confirmBtn.addEventListener('click', () => close(true));
        cancelBtn.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close(false);
        });

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          modal.style.transform = 'scale(1)';
        });
      });
    },

    confirm(message, title = 'Confirm') {
      return this.show({ message, title, type: 'warning' });
    },

    danger(message, title = 'Warning') {
      return this.show({ message, title, type: 'danger', confirmText: 'Yes, continue' });
    }
  };

  // Export to global scope
  window.Modal = Modal;
})();
