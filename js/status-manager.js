// status-manager.js - Status polling and updates
(function() {
  'use strict';

  // Dependencies check
  if (!window.CoreManager || !window.AppState || !window.GridManager || !window.LockManager) {
    console.error('[StatusManager] Missing dependencies');
    return;
  }

  const { apiCall } = window.CoreManager;
  const AppState = window.AppState;
  const DOM = window.DOM;
  const GridManager = window.GridManager;

  // ===== STATUS MANAGEMENT =====
  const StatusManager = {
    lastUpdate: 0,
    pollingInterval: null,
    _pollingPaused: false,

    async load() {
      console.log('[StatusManager.load] Called at', performance.now().toFixed(2));
      try {
        const sinceParam = this.lastUpdate
          ? '?since=' + encodeURIComponent(this.lastUpdate)
          : '?ts=' + Date.now();

        const response = await apiCall('/status' + sinceParam);
        if (!response || !response.ok) return;

        // Update price
        if (typeof response.currentPrice === 'number') {
          AppState.globalPrice = response.currentPrice;
        }

        // Diff-based update
        const newSold = response.sold || {};
        const newLocks = response.locks || {};
        const changed = new Set();

        for (const k of Object.keys(AppState.sold || {})) changed.add(k);
        for (const k of Object.keys(newSold)) changed.add(k);
        for (const k of Object.keys(AppState.locks || {})) changed.add(k);
        for (const k of Object.keys(newLocks)) changed.add(k);

        AppState.sold = newSold;
        AppState.locks = window.LockManager.merge(newLocks);
        AppState.regions = response.regions || AppState.regions;

        // Paint only changed
        for (const k of changed) {
          const idx = parseInt(k, 10);
          if (!Number.isNaN(idx) && DOM.grid.children[idx]) {
            GridManager.paintCell(idx);
          }
        }

        if (window.renderRegions) {
          window.renderRegions();
        }

        GridManager.updateTopbar();

        if (typeof response.ts === 'number') {
          this.lastUpdate = response.ts;
        }

      } catch (e) {
        console.warn('[Status] Load failed:', e);
      }
    },

    pausePolling() {
      this._pollingPaused = true;
      console.log('[StatusManager] Polling paused');
    },

    resumePolling() {
      this._pollingPaused = false;
      console.log('[StatusManager] Polling resumed');
    },

    startPolling() {
      if (this.pollingInterval) {
        console.warn('[StatusManager] Polling already running!');
        return;
      }

      console.log('[StatusManager] Starting polling (3.5s)');
      this.pollingInterval = setInterval(async () => {
        // Skip ONLY if paused
        if (this._pollingPaused) {
          console.log('[StatusManager] Polling tick skipped (paused)');
          return;
        }

        console.log('[StatusManager] Polling tick');
        await this.load();
      }, 3500);
    }
  };

  // Export to global scope
  window.StatusManager = StatusManager;
})();
