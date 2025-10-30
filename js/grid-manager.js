// grid-manager.js - Grid management and selection
(function() {
  'use strict';

  // Dependencies check
  if (!window.CoreManager || !window.AppState) {
    console.error('[GridManager] Missing dependencies');
    return;
  }

  const { uid } = window.CoreManager;
  const AppState = window.AppState;
  const DOM = window.DOM;
  const N = 100;
  const locale = navigator.language || 'en-US';

  // ===== GRID MANAGEMENT =====
  const GridManager = {
    init() {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N * N; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.idx = i;
        frag.appendChild(cell);
      }
      DOM.grid.appendChild(frag);

      this.setupEvents();
    },

    setupEvents() {
      let isDragging = false;
      let dragStartIdx = -1;
      let lastDragIdx = -1;
      let suppressClick = false;

      const idxFromXY = (x, y) => {
        const rect = DOM.grid.getBoundingClientRect();
        const cell = DOM.grid.children[0];
        if (!cell) return -1;

        const cellRect = cell.getBoundingClientRect();
        const cellSize = cellRect.width;

        const col = Math.floor((x - rect.left) / cellSize);
        const row = Math.floor((y - rect.top) / cellSize);

        if (col < 0 || col >= N || row < 0 || row >= N) return -1;
        return row * N + col;
      };

      // Selection guide logic
      const selectionGuide = document.getElementById('selectionGuide');
      let hasUserDragged = false;
      let isMouseOverGrid = false;

      const updateGuidePosition = (e) => {
        if (hasUserDragged || !isMouseOverGrid || !selectionGuide) return;

        const rect = DOM.grid.getBoundingClientRect();
        const offsetX = 20;
        const offsetY = 20;

        selectionGuide.style.left = (e.clientX - rect.left + offsetX) + 'px';
        selectionGuide.style.top = (e.clientY - rect.top + offsetY) + 'px';
      };

      const dismissGuide = () => {
        hasUserDragged = true;
        if (selectionGuide) {
          selectionGuide.classList.add('dismissed');
          selectionGuide.classList.remove('show');
        }
      };

      // Mouse enter grid
      DOM.grid.addEventListener('mouseenter', (e) => {
        isMouseOverGrid = true;
        if (!hasUserDragged && AppState.selected.size === 0 && selectionGuide) {
          selectionGuide.classList.add('show');
          updateGuidePosition(e);
        }
      });

      // Mouse leave grid
      DOM.grid.addEventListener('mouseleave', () => {
        isMouseOverGrid = false;
        if (selectionGuide) {
          selectionGuide.classList.remove('show');
        }
      });

      // Mouse move on grid
      DOM.grid.addEventListener('mousemove', (e) => {
        updateGuidePosition(e);
      });

      DOM.grid.addEventListener('mousedown', (e) => {
        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx < 0) return;

        isDragging = true;
        dragStartIdx = idx;
        lastDragIdx = idx;
        this.selectRect(idx, idx);
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx < 0 || idx === lastDragIdx) return;

        lastDragIdx = idx;
        suppressClick = true;
        // Dismiss guide on first drag
        if (!hasUserDragged) {
          dismissGuide();
        }
        this.selectRect(dragStartIdx, idx);
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          dragStartIdx = -1;
          lastDragIdx = -1;
        }
      });

      DOM.grid.addEventListener('click', (e) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }

        const idx = idxFromXY(e.clientX, e.clientY);
        if (idx >= 0) this.toggleCell(idx);
      });
    },

    selectRect(startIdx, endIdx) {
      const [sr, sc] = [Math.floor(startIdx / N), startIdx % N];
      const [er, ec] = [Math.floor(endIdx / N), endIdx % N];

      const r0 = Math.min(sr, er), r1 = Math.max(sr, er);
      const c0 = Math.min(sc, ec), c1 = Math.max(sc, ec);

      // Check blocked
      let blocked = false;
      for (let r = r0; r <= r1 && !blocked; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * N + c;
          if (this.isBlocked(idx)) {
            blocked = true;
            break;
          }
        }
      }

      if (blocked) {
        this.clearSelection();
        this.showInvalidArea(r0, c0, r1, c1);
        return;
      }

      this.clearSelection();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * N + c;
          AppState.selected.add(idx);
          DOM.grid.children[idx].classList.add('sel');
        }
      }

      this.updateSelectionInfo();
    },

    toggleCell(idx) {
      if (this.isBlocked(idx)) return;

      if (AppState.selected.has(idx)) {
        AppState.selected.delete(idx);
        DOM.grid.children[idx].classList.remove('sel');
      } else {
        AppState.selected.add(idx);
        DOM.grid.children[idx].classList.add('sel');
      }

      this.updateSelectionInfo();
    },

    clearSelection() {
      for (const idx of AppState.selected) {
        DOM.grid.children[idx].classList.remove('sel');
      }
      AppState.selected.clear();
      this.updateSelectionInfo();
    },

    isBlocked(idx) {
      if (AppState.sold[idx]) return true;
      const lock = AppState.locks[idx];
      return !!(lock && lock.until > Date.now() && lock.uid !== uid);
    },

    paintCell(idx) {
      const cell = DOM.grid.children[idx];
      const sold = AppState.sold[idx];
      const lock = AppState.locks[idx];
      const lockedByOther = lock && lock.until > Date.now() && lock.uid !== uid;

      cell.classList.toggle('sold', !!sold);
      cell.classList.toggle('pending', !!lockedByOther);
      cell.classList.toggle('sel', AppState.selected.has(idx));

      if (sold) {
        cell.title = (sold.name || '') + ' • ' + (sold.linkUrl || '');
      } else {
        cell.title = '';
      }
    },

    paintAll() {
      for (let i = 0; i < N * N; i++) {
        this.paintCell(i);
      }
      this.updateTopbar();
    },

    updateSelectionInfo() {
      if (AppState.view === 'checkout') {
        DOM.selectionInfo.classList.remove('show');
        return;
      }

      const count = AppState.selected.size * 100;

      if (count === 0) {
        DOM.selectionInfo.classList.remove('show');
        return;
      }

      const total = this.calculateTotal(AppState.selected.size * 100);

      // Update content
      const detailsEl = DOM.selectionInfo.querySelector('.selection-details');
      if (detailsEl) {
        detailsEl.innerHTML =
          `<span class="count">${count.toLocaleString(locale)}</span> pixels • $${total.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      // Fixed position in CSS
      DOM.selectionInfo.classList.add('show');
    },

    updateTopbar() {
      const priceEl = DOM.priceLine;
      if (priceEl) {
        // Format with 2 decimals according to locale
        priceEl.textContent = `$${AppState.globalPrice.toLocaleString(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}/px`;
      }
      DOM.pixelsLeft.textContent = '1M PIXELs';
      this.updateSelectionInfo();
    },

    calculateTotal(pixels) {
      const STEP = 1000;
      const INCREMENT = 0.01;
      let total = 0;
      let tierIndex = 0;

      const fullSteps = Math.floor(pixels / STEP);
      for (let i = 0; i < fullSteps; i++) {
        total += (AppState.globalPrice + (INCREMENT * tierIndex)) * STEP;
        tierIndex++;
      }

      const remainder = pixels % STEP;
      if (remainder > 0) {
        total += (AppState.globalPrice + (INCREMENT * tierIndex)) * remainder;
      }

      return Math.round(total * 100) / 100;
    },

    showInvalidArea(r0, c0, r1, c1) {
      const cell = DOM.grid.children[0];
      const cellSize = cell.getBoundingClientRect().width;

      const overlay = document.createElement('div');
      overlay.className = 'invalid-overlay';
      overlay.style.cssText = `
        position: absolute;
        left: ${c0 * cellSize}px;
        top: ${r0 * cellSize}px;
        width: ${(c1 - c0 + 1) * cellSize}px;
        height: ${(r1 - r0 + 1) * cellSize}px;
        background: rgba(239, 68, 68, 0.2);
        border: 2px solid #ef4444;
        pointer-events: none;
        z-index: 1000;
      `;

      DOM.grid.appendChild(overlay);
      setTimeout(() => overlay.remove(), 800);
    }
  };

  // Export to global scope
  window.GridManager = GridManager;
})();
