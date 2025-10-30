// app-state.js - Application state management
(function() {
  'use strict';

  // ===== STATE MANAGEMENT =====
  const AppState = {
    view: 'grid', // 'grid' | 'checkout'
    checkoutStep: 1, // 1: form, 2: payment, 3: success

    // Grid state
    sold: {},
    locks: {},
    regions: {},
    selected: new Set(),
    globalPrice: 1,

    // Checkout state
    currentOrder: null,
    orderData: {
      blocks: [],
      name: '',
      linkUrl: '',
      imageUrl: null,
      regionId: null,
      totalAmount: 0,
      unitPrice: 0
    },

    // Timer state
    lockTimer: null,
    lockCheckTimeout: null,
    lockCheckInterval: null,
    lockSecondsRemaining: 300,  // 5 minutes
    lockStartTime: 0,

    // Upload cache
    uploadedImageCache: null
  };

  // ===== DOM REFERENCES =====
  const DOM = {};

  // Export to global scope
  window.AppState = AppState;
  window.DOM = DOM;
})();
