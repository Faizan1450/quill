import { getSettings, saveSettings } from '../lib/storage.js';

const PALETTES = {
  teal: {
    base: '#0D9488',
    hover: '#0F766E',
    soft: '#CCFBF1',
    border: '#5EEAD4'
  },
  crimson: {
    base: '#BE123C',
    hover: '#9F1239',
    soft: '#FFE4E6',
    border: '#FDA4AF'
  },
  gold: {
    base: '#CA8A04',
    hover: '#A16207',
    soft: '#FEF9C3',
    border: '#FDE047'
  },
  ocean: {
    base: '#0369A1',
    hover: '#075985',
    soft: '#E0F2FE',
    border: '#7DD3FC'
  },
  pink: {
    base: '#EC4899',
    hover: '#DB2777',
    soft: '#FCE7F3',
    border: '#F9A8D4'
  }
};

// DOM elements
const form = document.getElementById('settings-form');
const apiKeyInput = document.getElementById('api-key');
const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility');
const apiKeyStatus = document.getElementById('api-key-status');
const emojiCheckbox = document.getElementById('emoji');
const questionCheckbox = document.getElementById('end-with-question');
const voiceContextTextarea = document.getElementById('voice-context');
const voiceCounterDisplay = document.getElementById('voice-counter-display');
const saveToast = document.getElementById('save-toast');

// Comment Examples DOM
const exampleCommentInput = document.getElementById('example-comment-input');
const btnAddExample = document.getElementById('btn-add-example');
const exampleLimitNote = document.getElementById('example-limit-note');
const exampleCharCounter = document.getElementById('example-char-counter');
const exampleCharLimitNote = document.getElementById('example-char-limit-note');
const examplesList = document.getElementById('examples-list');

// Sidebar Tabs DOM
const sidebarItems = document.querySelectorAll('.sidebar-item');
const settingsPanels = document.querySelectorAll('.settings-panel');

// Color swatches DOM
const swatches = document.querySelectorAll('.palette-swatch');

let currentThemeColor = 'teal';
let commentExamples = [];

/**
 * Applies the selected theme color variables to document root.
 * @param {string} colorName 
 */
function applyThemePalette(colorName) {
  const palette = PALETTES[colorName] || PALETTES.teal;
  const root = document.documentElement;
  root.style.setProperty('--draftly-accent', palette.base);
  root.style.setProperty('--draftly-accent-hover', palette.hover);
  root.style.setProperty('--draftly-accent-soft', palette.soft);
  root.style.setProperty('--draftly-accent-border', palette.border);

  // Update active class on swatches
  swatches.forEach(swatch => {
    if (swatch.dataset.color === colorName) {
      swatch.classList.add('active');
    } else {
      swatch.classList.remove('active');
    }
  });

  currentThemeColor = colorName;
}

/**
 * Handles Tab Switching
 */
sidebarItems.forEach(item => {
  item.addEventListener('click', () => {
    const tabName = item.dataset.tab;
    
    // Update sidebar active class
    sidebarItems.forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    
    // Show correct settings panel
    settingsPanels.forEach(panel => {
      if (panel.id === `panel-${tabName}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });
  });
});

/**
 * Updates the key status indicator without revealing the key value.
 * @param {'saved'|'empty'|'error'} state
 * @param {string} [message]
 */
function setKeyStatus(state, message) {
  apiKeyStatus.className = `key-status status-${state}`;
  const labels = {
    saved:  message || '✓ A key is saved',
    empty:  message || 'No key saved',
    error:  message || 'Error saving key',
  };
  apiKeyStatus.textContent = labels[state];
}

/**
 * Updates the voice context character counter.
 */
function updateCharCounter() {
  const currentLength = voiceContextTextarea.value.length;
  voiceCounterDisplay.textContent = `${currentLength}/1000`;
}

/**
 * Updates the example input character counter and warning note.
 */
function updateExampleCharCounter() {
  const text = exampleCommentInput.value;
  const charCount = text.length;
  exampleCharCounter.textContent = `${charCount}/300`;
  
  if (charCount > 300) {
    exampleCharLimitNote.style.display = 'block';
    exampleCharCounter.style.color = 'var(--draftly-danger)';
  } else {
    exampleCharLimitNote.style.display = 'none';
    exampleCharCounter.style.color = '';
  }
}

/**
 * Renders the list of comment examples.
 */
function renderExamplesList() {
  examplesList.innerHTML = '';
  
  commentExamples.forEach((exampleText, idx) => {
    const item = document.createElement('div');
    item.className = 'example-item-shell';
    
    const textSpan = document.createElement('span');
    textSpan.textContent = exampleText;
    item.appendChild(textSpan);
    
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-shell';
    removeBtn.innerHTML = '&times;';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      commentExamples.splice(idx, 1);
      renderExamplesList();
      await saveExamplesToStorage();
    });
    item.appendChild(removeBtn);
    
    examplesList.appendChild(item);
  });

  // Limit check (cap at 5)
  if (commentExamples.length >= 5) {
    exampleCommentInput.disabled = true;
    btnAddExample.disabled = true;
    exampleLimitNote.style.display = 'block';
    exampleCharLimitNote.style.display = 'none';
  } else {
    exampleCommentInput.disabled = false;
    btnAddExample.disabled = false;
    exampleLimitNote.style.display = 'none';
    updateExampleCharCounter();
  }
}

/**
 * Auto-saves commentExamples to chrome.storage.local.
 */
async function saveExamplesToStorage() {
  try {
    const settings = await getSettings();
    settings.commentExamples = commentExamples;
    await saveSettings(settings);
  } catch (error) {
    console.error('Failed to save comment examples:', error);
  }
}

/**
 * Handles adding a new comment example.
 */
async function handleAddExample() {
  const text = exampleCommentInput.value.trim();
  if (!text) return;
  if (commentExamples.length >= 5) return;
  
  # Exceeds 300 characters check
  if (text.length > 300) {
    return; // Block adding it
  }
  
  if (commentExamples.includes(text)) {
    exampleCommentInput.value = '';
    updateExampleCharCounter();
    return;
  }
  
  commentExamples.push(text);
  exampleCommentInput.value = '';
  updateExampleCharCounter();
  renderExamplesList();
  await saveExamplesToStorage();
}

// Bind example manager events
btnAddExample.addEventListener('click', (e) => {
  e.preventDefault();
  handleAddExample();
});

exampleCommentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleAddExample();
  }
});

exampleCommentInput.addEventListener('input', updateExampleCharCounter);

// Load settings on startup
async function init() {
  try {
    const settings = await getSettings();

    // Populate API key field (masked) and show key status
    if (settings.apiKey) {
      apiKeyInput.value = settings.apiKey;
      setKeyStatus('saved');
    } else {
      apiKeyInput.value = '';
      setKeyStatus('empty');
    }

    // Tone radios
    const toneVal = settings.tone || 'professional';
    const activeToneRadio = document.querySelector(`input[name="tone"][value="${toneVal}"]`);
    if (activeToneRadio) activeToneRadio.checked = true;

    // Length radios
    const lengthVal = settings.defaultLength || 'medium';
    const activeLengthRadio = document.querySelector(`input[name="default-length"][value="${lengthVal}"]`);
    if (activeLengthRadio) activeLengthRadio.checked = true;

    // Toggles
    emojiCheckbox.checked = !!settings.emoji;
    questionCheckbox.checked = !!settings.endWithQuestion;

    // Voice context & character counter
    voiceContextTextarea.value = settings.voiceContext || '';
    updateCharCounter();

    // Apply color palette
    const color = settings.themeColor || 'teal';
    applyThemePalette(color);

    // Theme Mode
    const themeVal = settings.themeMode || 'light';
    const activeThemeRadio = document.querySelector(`input[name="theme-mode"][value="${themeVal}"]`);
    if (activeThemeRadio) activeThemeRadio.checked = true;
    
    if (themeVal === 'dark') {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.remove('theme-dark');
    }

    // Populate and render comment examples
    commentExamples = settings.commentExamples || [];
    renderExamplesList();

  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// Live character counter for voice context
voiceContextTextarea.addEventListener('input', updateCharCounter);

// Handle key visibility toggle
toggleKeyVisibilityBtn.addEventListener('click', () => {
  const currentType = apiKeyInput.getAttribute('type');
  if (currentType === 'password') {
    apiKeyInput.setAttribute('type', 'text');
    toggleKeyVisibilityBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor">
        <path d="m644-428-58-58q9-47-27-83t-83-27l-58-58q9-4 18-5.5t18-1.5q83 0 141.5 58.5T654-516q0 9-1.5 18t-5.5 18Zm146 146-51-51q47-49 79-105t42-122q-43-107-144.5-172.5T480-738q-60 0-116 14t-105 41l-50-51q57-38 122-57t134-19q146 0 266 81.5T920-500q-26 53-61.5 99.5T790-282ZM480-320q-3 0-6-.5t-6-1.5q-83 0-141.5-58.5T268-522q0-3 1.5-6t.5-6l-50-50q-4 13-5 26t-1 26q0 146 101.5 247.5T562-190q13 0 26-1t26-5l-50-50q-3 0-6 .5t-6-1.5Zm-8-124Zm-86-86ZM36-864l78 78q-80 50-136 122.5T40-500q74-138 194-219t266-81q83 0 160.5 28.5T798-688l82 82-78 78-68-68-46-46-321-321-46-46-63-63-78-78-42 42Zm188 188q-21 16-39.5 35.5T150-500q43 107 144.5 172.5T480-262q41 0 79-8.5t71-23.5L528-396q-11 5-23 7.5t-25 2.5q-50 0-85-35t-35-85q0-13 2.5-25t7.5-23L224-676Zm256 176Z"/>
      </svg>
    `;
  } else {
    apiKeyInput.setAttribute('type', 'password');
    toggleKeyVisibilityBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor">
        <path d="M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q74-138 194-219t266-81q146 0 266 81.5T920-500q-74 138-194 219t-266 81Zm0-72q119 0 220.5-65.5T844-500q-43-107-144.5-172.5T480-738q-119 0-220.5 65.5T116-500q43 107 144.5 172.5T480-272Zm0-228Z"/>
      </svg>
    `;
  }
});

// Show success notification toast
let toastTimeout;
function showToast() {
  clearTimeout(toastTimeout);
  saveToast.classList.remove('hidden');
  toastTimeout = setTimeout(() => {
    saveToast.classList.add('hidden');
  }, 3000);
}

// Swatches interaction
swatches.forEach(swatch => {
  swatch.addEventListener('click', async () => {
    const color = swatch.dataset.color;
    applyThemePalette(color);
    
    // Save themeColor immediately on selection
    try {
      const settings = await getSettings();
      settings.themeColor = color;
      await saveSettings(settings);
      showToast();
    } catch (error) {
      console.error('Failed to save themeColor:', error);
    }
  });
});

// Theme mode interaction
const themeRadios = document.querySelectorAll('input[name="theme-mode"]');
themeRadios.forEach(radio => {
  radio.addEventListener('change', async () => {
    const mode = radio.value;
    if (mode === 'dark') {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.remove('theme-dark');
    }
    
    // Save themeMode immediately on selection
    try {
      const settings = await getSettings();
      settings.themeMode = mode;
      await saveSettings(settings);
      showToast();
    } catch (error) {
      console.error('Failed to save themeMode:', error);
    }
  });
});

// Handle form submit (General and Style settings save)
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const enteredKey = apiKeyInput.value.trim();

  // Empty-save guard: if the field is blank, don't silently wipe an existing key
  if (!enteredKey) {
    setKeyStatus('error', 'Enter a key first — save cancelled');
    setTimeout(() => {
      apiKeyInput.value ? setKeyStatus('saved') : setKeyStatus('empty');
    }, 2500);
    return;
  }

  const selectedTone = document.querySelector('input[name="tone"]:checked')?.value || 'professional';
  const selectedLength = document.querySelector('input[name="default-length"]:checked')?.value || 'medium';
  const selectedThemeMode = document.querySelector('input[name="theme-mode"]:checked')?.value || 'light';

  const settings = {
    apiKey: enteredKey,
    tone: selectedTone,
    defaultLength: selectedLength,
    emoji: emojiCheckbox.checked,
    endWithQuestion: questionCheckbox.checked,
    voiceContext: voiceContextTextarea.value.trim(),
    themeColor: currentThemeColor,
    commentExamples: commentExamples,
    themeMode: selectedThemeMode
  };

  try {
    await saveSettings(settings);
    setKeyStatus('saved', '✓ Saved — key is stored locally');
    showToast();
  } catch (error) {
    console.error('Failed to save settings:', error);
    setKeyStatus('error', 'Error saving — please try again');
  }
});

// Initialize form
document.addEventListener('DOMContentLoaded', init);
