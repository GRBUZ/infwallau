// Constantes globales - VOS VALEURS ORIGINALES
const N = 100;
const TOTAL_PIXELS = 1_000_000;
const CELL_SIZE = 8;
const CANVAS_WIDTH = N * CELL_SIZE;
const CANVAS_HEIGHT = N * CELL_SIZE;

// Configuration API
const API_BASE = '/.netlify/functions';

// État global
let canvas, ctx, tooltipDiv;
let currentState = { sold: {}, locks: {}, regions: {} };
let selectedCells = new Set();
let isSelecting = false;
let startCell = null;

// Variables d'authentification
let authToken = null;
let currentUser = null;

// ===================
// GESTION AUTHENTIFICATION
// ===================

function getAuthToken() {
  if (!authToken) {
    authToken = localStorage.getItem('authToken');
  }
  return authToken;
}

function setAuthToken(token) {
  authToken = token;
  if (token) {
    localStorage.setItem('authToken', token);
  } else {
    localStorage.removeItem('authToken');
  }
}

function clearAuth() {
  authToken = null;
  currentUser = null;
  setAuthToken(null);
  updateUIForAuth();
}

async function checkAuthStatus() {
  const token = getAuthToken();
  if (!token) {
    updateUIForAuth();
    return false;
  }

  try {
    // Décoder le JWT pour vérifier s'il est expiré
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      console.log('Token expiré');
      clearAuth();
      return false;
    }
    
    currentUser = { uid: payload.uid, username: payload.username };
    updateUIForAuth();
    return true;
  } catch (error) {
    console.error('Erreur lors de la vérification du token:', error);
    clearAuth();
    return false;
  }
}

function updateUIForAuth() {
  const authSection = document.getElementById('auth-section');
  const gameSection = document.getElementById('game-section');
  const userInfo = document.getElementById('user-info');
  const usernameSpan = document.getElementById('username');

  if (currentUser) {
    authSection.style.display = 'none';
    gameSection.style.display = 'block';
    userInfo.style.display = 'block';
    usernameSpan.textContent = currentUser.username;
  } else {
    authSection.style.display = 'block';
    gameSection.style.display = 'none';
    userInfo.style.display = 'none';
  }
}

async function login() {
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;

  if (!username || !password) {
    alert('Veuillez remplir tous les champs');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const result = await response.json();

    if (result.ok) {
      setAuthToken(result.token);
      currentUser = { uid: result.uid, username: result.username };
      updateUIForAuth();
      await loadStatus(); // Recharger l'état après connexion
    } else {
      alert(result.error || 'Erreur de connexion');
    }
  } catch (error) {
    console.error('Erreur login:', error);
    alert('Erreur de connexion');
  }
}

function logout() {
  clearAuth();
  selectedCells.clear();
  drawGrid();
}

// ===================
// UTILITAIRES API
// ===================

async function apiCall(endpoint, options = {}) {
  const token = getAuthToken();
  
  const config = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...(options.headers || {})
    }
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, config);
    const result = await response.json();
    
    if (response.status === 401) {
      console.log('Token invalide, déconnexion');
      clearAuth();
      return null;
    }
    
    return result;
  } catch (error) {
    console.error('Erreur API:', error);
    return null;
  }
}

// Spécifique multipart (FormData) avec gestion 401 comme apiCall
async function apiCallMultipart(endpoint, formData, options = {}) {
  const token = getAuthToken();
  const config = {
    method: 'POST',
    ...options,
    headers: {
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...(options.headers || {})
    },
    body: formData
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, config);
    const result = await response.json();
    if (response.status === 401) {
      console.log('Token invalide, déconnexion');
      clearAuth();
      return null;
    }
    return result;
  } catch (error) {
    console.error('Erreur API (multipart):', error);
    return null;
  }
}

// ===================
// GESTION ÉTAT DU JEU
// ===================

async function loadStatus() {
  try {
    // Status est public, mais on ajoute un cache-buster pour éviter d'éventuels caches
    const response = await fetch(`${API_BASE}/status?ts=${Date.now()}`);
    const result = await response.json();
    
    if (result.ok) {
      currentState = {
        sold: result.sold || {},
        locks: result.locks || {},
        regions: result.regions || {}
      };
      drawGrid();
    }
  } catch (error) {
    console.error('Erreur lors du chargement du statut:', error);
  }
}

// ===================
// GESTION DU CANVAS - VOS FONCTIONS ORIGINALES
// ===================

function xyToIndex(x, y) {
  return y * N + x;
}

function indexToXY(index) {
  return {
    x: index % N,
    y: Math.floor(index / N)
  };
}

function canvasToGrid(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / CELL_SIZE);
  const y = Math.floor((clientY - rect.top) / CELL_SIZE);
  return { x, y };
}

function getCellState(index) {
  if (currentState.sold[index]) return 'sold';
  if (currentState.locks[index]) return 'locked';
  return 'free';
}

function drawGrid() {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const index = xyToIndex(x, y);
      const state = getCellState(index);
      const isSelected = selectedCells.has(index);
      
      let color;
      if (isSelected) {
        color = '#0066ff';
      } else if (state === 'sold') {
        color = '#ff4444';
      } else if (state === 'locked') {
        color = '#ffaa00';
      } else {
        color = '#eeeeee';
      }
      
      ctx.fillStyle = color;
      ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
    }
  }
}

// ===================
// GESTION SÉLECTION
// ===================

function selectRectangle(x1, y1, x2, y2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  
  selectedCells.clear();
  
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (x >= 0 && x < N && y >= 0 && y < N) {
        const index = xyToIndex(x, y);
        if (getCellState(index) === 'free') {
          selectedCells.add(index);
        }
      }
    }
  }
  
  drawGrid();
  updateUI();
}

// ===================
// ACTIONS DU JEU
// ===================

async function reserveSelectedCells() {
  if (!currentUser) {
    alert('Veuillez vous connecter');
    return;
  }
  
  if (selectedCells.size === 0) {
    alert('Aucune cellule sélectionnée');
    return;
  }

  const blocks = Array.from(selectedCells);
  const result = await apiCall('/reserve', {
    method: 'POST',
    body: JSON.stringify({ blocks })
  });

  if (result && result.ok) {
    await loadStatus();
    selectedCells.clear();
    updateUI();
  } else {
    alert(result?.error || 'Erreur lors de la réservation');
  }
}

async function unlockSelectedCells() {
  if (!currentUser) {
    alert('Veuillez vous connecter');
    return;
  }
  
  if (selectedCells.size === 0) {
    alert('Aucune cellule sélectionnée');
    return;
  }

  const blocks = Array.from(selectedCells);
  const result = await apiCall('/unlock', {
    method: 'POST',
    body: JSON.stringify({ blocks })
  });

  if (result && result.ok) {
    await loadStatus();
    selectedCells.clear();
    updateUI();
  } else {
    alert(result?.error || 'Erreur lors du déverrouillage');
  }
}

async function finalizeSelection() {
  if (!currentUser) {
    alert('Veuillez vous connecter');
    return;
  }
  
  if (selectedCells.size === 0) {
    alert('Aucune cellule sélectionnée');
    return;
  }

  const name = document.getElementById('name-input').value.trim();
  const linkUrl = document.getElementById('url-input').value.trim();

  if (!name || !linkUrl) {
    alert('Veuillez remplir le nom et l\'URL');
    return;
  }

  const blocks = Array.from(selectedCells);
  const result = await apiCall('/finalize', {
    method: 'POST',
    body: JSON.stringify({ name, linkUrl, blocks })
  });

  if (result && result.ok) {
    alert(`Achat réussi ! ${result.soldCount} cellules achetées`);
    await loadStatus();
    selectedCells.clear();
    document.getElementById('name-input').value = '';
    document.getElementById('url-input').value = '';
    updateUI();
  } else {
    alert(result?.error || 'Erreur lors de l\'achat');
  }
}

// ===================
// GESTION UPLOAD
// ===================

async function uploadImage() {
  if (!currentUser) {
    alert('Veuillez vous connecter');
    return;
  }
  
  const fileInput = document.getElementById('image-upload');
  const file = fileInput.files[0];
  
  if (!file) {
    alert('Veuillez sélectionner une image');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);

  const result = await apiCallMultipart('/upload', formData);

  if (result && result.ok) {
    alert(`Image uploadée avec succès : ${result.filename || result.imageUrl || 'OK'}`);
    fileInput.value = '';
  } else if (result === null) {
    // déjà géré: clearAuth() sur 401 dans apiCallMultipart
  } else {
    alert(result?.error || 'Erreur lors de l\'upload');
  }
}

// ===================
// GESTION ÉVÉNEMENTS
// ===================

function setupEventListeners() {
  // Auth
  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('logout-btn').addEventListener('click', logout);
  
  // Enter pour login
  document.getElementById('password-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
  });

  // Canvas
  canvas.addEventListener('mousedown', (e) => {
    if (!currentUser) return;
    
    const gridPos = canvasToGrid(e.clientX, e.clientY);
    if (gridPos.x >= 0 && gridPos.x < N && gridPos.y >= 0 && gridPos.y < N) {
      isSelecting = true;
      startCell = gridPos;
      selectedCells.clear();
      drawGrid();
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!currentUser) return;
    
    if (isSelecting && startCell) {
      const gridPos = canvasToGrid(e.clientX, e.clientY);
      selectRectangle(startCell.x, startCell.y, gridPos.x, gridPos.y);
    }
    
    // Tooltip
    const gridPos = canvasToGrid(e.clientX, e.clientY);
    if (gridPos.x >= 0 && gridPos.x < N && gridPos.y >= 0 && gridPos.y < N) {
      const index = xyToIndex(gridPos.x, gridPos.y);
      showTooltip(e.clientX, e.clientY, index);
    } else {
      hideTooltip();
    }
  });

  canvas.addEventListener('mouseup', () => {
    isSelecting = false;
    startCell = null;
    updateUI();
  });

  canvas.addEventListener('mouseleave', () => {
    isSelecting = false;
    startCell = null;
    hideTooltip();
  });

  // Actions
  document.getElementById('reserve-btn').addEventListener('click', reserveSelectedCells);
  document.getElementById('unlock-btn').addEventListener('click', unlockSelectedCells);
  document.getElementById('finalize-btn').addEventListener('click', finalizeSelection);
  document.getElementById('upload-btn').addEventListener('click', uploadImage);
}

// ===================
// TOOLTIP
// ===================

function showTooltip(x, y, index) {
  const state = getCellState(index);
  const pos = indexToXY(index);
  
  let content = `Cellule ${index} (${pos.x}, ${pos.y})`;
  
  if (state === 'sold') {
    const cellData = currentState.sold[index];
    content += `<br>Vendu à: ${cellData.name}`;
    if (cellData.linkUrl) {
      content += `<br>URL: <a href="${cellData.linkUrl}" target="_blank">${cellData.linkUrl}</a>`;
    }
  } else if (state === 'locked') {
    const lockData = currentState.locks[index];
    content += `<br>Réservé par: ${lockData.uid}`;
    if (lockData.until) {
      const until = new Date(lockData.until);
      content += `<br>Jusqu'à: ${until.toLocaleString()}`;
    }
  } else {
    content += '<br>Libre';
  }

  tooltipDiv.innerHTML = content;
  tooltipDiv.style.left = (x + 10) + 'px';
  tooltipDiv.style.top = (y + 10) + 'px';
  tooltipDiv.style.display = 'block';
}

function hideTooltip() {
  tooltipDiv.style.display = 'none';
}

// ===================
// UI
// ===================

function updateUI() {
  const selectedCount = selectedCells.size;
  document.getElementById('selected-count').textContent = selectedCount;
  
  const reserveBtn = document.getElementById('reserve-btn');
  const unlockBtn = document.getElementById('unlock-btn');
  const finalizeBtn = document.getElementById('finalize-btn');
  
  reserveBtn.disabled = selectedCount === 0 || !currentUser;
  unlockBtn.disabled = selectedCount === 0 || !currentUser;
  finalizeBtn.disabled = selectedCount === 0 || !currentUser;
}

// ===================
// INITIALISATION
// ===================

async function init() {
  canvas = document.getElementById('grid-canvas');
  ctx = canvas.getContext('2d');
  tooltipDiv = document.getElementById('tooltip');
  
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  
  setupEventListeners();
  
  await checkAuthStatus();
  await loadStatus();
  
  updateUI();
  
  // Refresh automatique toutes les 10 secondes
  setInterval(loadStatus, 10000);
}

// Démarrage
document.addEventListener('DOMContentLoaded', init);