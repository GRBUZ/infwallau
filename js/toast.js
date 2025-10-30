// toast.js - Toast notification system
(function() {
  'use strict';

  // ===== TOAST NOTIFICATION SYSTEM =====
  const Toast = {
    container: null,

    init() {
      if (this.container) return;

      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 12px;
        pointer-events: none;
      `;
      document.body.appendChild(this.container);
    },

    show(message, type = 'info', duration = 3000) {
      this.init();

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;

      const icons = {
        success: '✓',
        error: '!',
        warning: '⚠',
        info: 'i'
      };

      const colors = {
        success: '#10b981',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
      };

      const color = colors[type] || colors.info;

      toast.style.cssText = `
        background: #ffffff;
        color: #1f2937;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 320px;
        max-width: 500px;
        font-size: 15px;
        pointer-events: auto;
        opacity: 0;
        transform: scale(0.9);
        transition: all 0.2s ease;
        border-left: 4px solid ${color};
      `;

      toast.innerHTML = `
        <div style="
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: ${color};
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
          flex-shrink: 0;
        ">${icons[type]}</div>
        <span style="flex: 1; line-height: 1.4; font-weight: 500;">${message}</span>
      `;

      const close = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'scale(0.9)';
        setTimeout(() => toast.remove(), 200);
      };

      toast.addEventListener('click', close);

      this.container.appendChild(toast);

      // Animate in
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'scale(1)';
      });

      // Auto remove
      if (duration > 0) {
        setTimeout(close, duration);
      }
    },

    success(message, duration) {
      this.show(message, 'success', duration);
    },

    error(message, duration) {
      this.show(message, 'error', duration);
    },

    warning(message, duration) {
      this.show(message, 'warning', duration);
    },

    info(message, duration) {
      this.show(message, 'info', duration);
    }
  };

  // Export to global scope
  window.Toast = Toast;
})();
