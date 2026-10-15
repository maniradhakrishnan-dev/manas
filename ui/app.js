// ==========================================================================
// Manas — Daily Planner & Thinking Space
// High-Performance Resilient Daily Planner & 365 Diary Controller
// ==========================================================================

// Safe in-memory storage fallback if localStorage is restricted
const memoryCache = {};
const safeStorage = {
  getItem: (key) => {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : (memoryCache[key] || null);
    } catch (e) {
      return memoryCache[key] || null;
    }
  },
  setItem: (key, val) => {
    memoryCache[key] = val;
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      console.warn("localStorage restricted, using memory cache:", e);
    }
  }
};

// Safe Tauri 2.0 IPC Invocation with strict 1-second timeout
async function callTauri(command, args = {}) {
  try {
    let invoker = null;
    if (typeof window.__TAURI__ !== 'undefined') {
      invoker = window.__TAURI__.core?.invoke || window.__TAURI__.invoke;
    }
    if (invoker) {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tauri IPC timeout')), 1200)
      );
      return await Promise.race([invoker(command, args), timeoutPromise]);
    }
  } catch (err) {
    console.warn(`Tauri command '${command}' fallback:`, err);
  }
  return null;
}

// State
let currentDate = new Date();
let currentDayData = {};
let activeDatesSet = new Set();
let isDirty = false;
let autoSaveTimer = null;
let currentTheme = safeStorage.getItem('mrt_theme') || 'dark';

// DOM Elements
const currentDateLabel = document.getElementById('current-date-label');
const btnPrevDay = document.getElementById('btn-prev-day');
const btnNextDay = document.getElementById('btn-next-day');
const btnToday = document.getElementById('btn-today');
const btnTheme = document.getElementById('btn-theme');
const btnExport = document.getElementById('btn-export');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnCalendarToggle = document.getElementById('btn-calendar-toggle');
const btnCloseCalendar = document.getElementById('btn-close-calendar');
const calendarModal = document.getElementById('calendar-modal');
const calendarYearTitle = document.getElementById('calendar-year-title');
const calendarMonthsGrid = document.getElementById('calendar-months-grid');
const footerStoragePath = document.getElementById('footer-storage-path');
const statusDot = document.querySelector('.status-pulse-dot');
const statusLabel = document.getElementById('status-label');
const progressText = document.getElementById('progress-text');
const progressCircle = document.getElementById('progress-circle');
const toastEl = document.getElementById('toast');

// Apply Initial Theme
setTheme(currentTheme, false);

function setTheme(theme, notify = true) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  safeStorage.setItem('mrt_theme', theme);

  if (notify) {
    const themeNames = {
      dark: 'Obsidian Cyber (Dark)',
      paper: 'Warm Paper (Moleskine)',
      nordic: 'Nordic Slate'
    };
    showToast(`Theme: ${themeNames[theme] || theme}`);
  }
}

function cycleTheme() {
  if (currentTheme === 'dark') {
    setTheme('paper');
  } else if (currentTheme === 'paper') {
    setTheme('nordic');
  } else {
    setTheme('dark');
  }
}

// Date formatting helpers
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateDisplay(date) {
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

function getDefaultTitle(blockKey) {
  const titles = {
    part1_quad1: "CS & SWE",
    part1_quad2: "Core AI",
    part1_quad3: "Applications",
    part1_quad4: "RSWE",
    part2: "Breadth",
    productive: "Productive (Get Things Done)",
    admin: "Admin & Operations",
    evening_huro: "Huro",
    evening_kana: "Kana",
    evening_bana: "Bana",
    evening_curio: "Curio",
    evening_survivi: "Survivo",
    evening_random: "Random"
  };
  return titles[blockKey] || "";
}

// Default Block Data Structure (Tasks & Notes are completely independent)
function getDefaultBlockData(defaultTitle) {
  return {
    title: defaultTitle,
    tasks: [],
    notes: "",
    content: ""
  };
}

// Default Data Structure
function getDefaultDayData(dateKey) {
  return {
    date: dateKey,
    part1_quad1: getDefaultBlockData("CS & SWE"),
    part1_quad2: getDefaultBlockData("Core AI"),
    part1_quad3: getDefaultBlockData("Applications"),
    part1_quad4: getDefaultBlockData("RSWE"),
    part2: getDefaultBlockData("Breadth"),
    productive: getDefaultBlockData("Productive (Get Things Done)"),
    admin: getDefaultBlockData("Admin & Operations"),
    evening_huro: getDefaultBlockData("Huro"),
    evening_kana: getDefaultBlockData("Kana"),
    evening_bana: getDefaultBlockData("Bana"),
    evening_curio: getDefaultBlockData("Curio"),
    evening_survivi: getDefaultBlockData("Survivo"),
    evening_random: getDefaultBlockData("Random"),
    updatedAt: new Date().toISOString()
  };
}

// Normalize a block, separating tasks and notes cleanly and ensuring backward compatibility
function normalizeBlockData(rawBlock, defaultTitle) {
  if (!rawBlock || typeof rawBlock !== 'object') {
    return getDefaultBlockData(defaultTitle);
  }

  let title = rawBlock.title !== undefined ? rawBlock.title : defaultTitle;
  let tasks = Array.isArray(rawBlock.tasks) ? JSON.parse(JSON.stringify(rawBlock.tasks)) : null;
  let notes = typeof rawBlock.notes === 'string' ? rawBlock.notes : null;

  // Auto-migrate legacy content string if tasks or notes not yet segregated
  if (tasks === null || notes === null) {
    const rawContent = rawBlock.content || "";
    const lines = rawContent.split('\n');
    const extractedTasks = [];
    const extractedNotes = [];

    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
        extractedTasks.push({ text: trimmed.replace(/^[-*]\s\[\s\]\s?/, ''), done: false });
      } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]') || trimmed.startsWith('* [x]') || trimmed.startsWith('* [X]')) {
        extractedTasks.push({ text: trimmed.replace(/^[-*]\s\[[xX]\]\s?/, ''), done: true });
      } else if (trimmed.length > 0) {
        extractedNotes.push(line);
      }
    }

    if (tasks === null) tasks = extractedTasks;
    if (notes === null) notes = extractedNotes.join('\n');
  }

  // Generate serialized content for markdown export compatibility
  const contentParts = [];
  if (tasks.length > 0) {
    contentParts.push(tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'));
  }
  if (notes.trim().length > 0) {
    contentParts.push(notes.trim());
  }
  const content = contentParts.join('\n\n');

  return {
    title,
    tasks,
    notes,
    content
  };
}

// Normalize entry data across legacy schemas and enforce consistent titles
function normalizeDayData(raw, dateKey) {
  const normalized = getDefaultDayData(dateKey);
  if (!raw || typeof raw !== 'object') {
    return normalized;
  }

  // Handle legacy nested part1
  if (raw.part1 && typeof raw.part1 === 'object') {
    if (raw.part1.quad1) raw.part1_quad1 = raw.part1.quad1;
    if (raw.part1.quad2) raw.part1_quad2 = raw.part1.quad2;
    if (raw.part1.quad3) raw.part1_quad3 = raw.part1.quad3;
    if (raw.part1.quad4) raw.part1_quad4 = raw.part1.quad4;
  }

  // Handle legacy nested evening
  if (raw.evening && typeof raw.evening === 'object') {
    if (raw.evening.huro) raw.evening_huro = raw.evening.huro;
    if (raw.evening.kana) raw.evening_kana = raw.evening.kana;
    if (raw.evening.bana) raw.evening_bana = raw.evening.bana;
    if (raw.evening.curio) raw.evening_curio = raw.evening.curio;
    if (raw.evening.survivi) raw.evening_survivi = raw.evening.survivi;
    if (raw.evening.random) raw.evening_random = raw.evening.random;
  }

  const blockKeys = [
    'part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4',
    'part2', 'productive', 'admin',
    'evening_huro', 'evening_kana', 'evening_bana',
    'evening_curio', 'evening_survivi', 'evening_random'
  ];

  for (const k of blockKeys) {
    normalized[k] = normalizeBlockData(raw[k], getDefaultTitle(k));
  }

  normalized.date = dateKey || raw.date || formatDateKey(new Date());
  normalized.updatedAt = raw.updatedAt || new Date().toISOString();

  // Strict normalization for Part 2 (Breadth)
  const p2Title = (normalized.part2.title || '').trim().toLowerCase();
  if (!p2Title || p2Title.includes('electronics') || p2Title.includes('motors') || p2Title.includes('part - 2') || p2Title.includes('part-2') || p2Title.includes('part 2')) {
    normalized.part2.title = "Breadth";
  }

  // Strict normalization for Evening Survivo
  const survTitle = (normalized.evening_survivi.title || '').trim().toLowerCase();
  if (!survTitle || survTitle.includes('survivi')) {
    normalized.evening_survivi.title = "Survivo";
  }

  return normalized;
}

// Storage Operations
async function loadDay(dateKey) {
  const data = await callTauri('get_day', { date: dateKey });
  if (data && typeof data === 'object') {
    return normalizeDayData(data, dateKey);
  }

  const localStr = safeStorage.getItem(`mrt_${dateKey}`);
  if (localStr) {
    try {
      return normalizeDayData(JSON.parse(localStr), dateKey);
    } catch (e) {
      console.warn("Parse error for local entry:", e);
    }
  }

  return getDefaultDayData(dateKey);
}

function syncBlockContent(blockKey) {
  const block = currentDayData[blockKey];
  if (!block) return;
  const parts = [];
  if (Array.isArray(block.tasks) && block.tasks.length > 0) {
    parts.push(block.tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'));
  }
  if (block.notes && block.notes.trim().length > 0) {
    parts.push(block.notes.trim());
  }
  block.content = parts.join('\n\n');
}

function saveDay(targetDateKey = null, targetData = null) {
  if (!isDirty && !targetData) return;
  const dateKey = targetDateKey || formatDateKey(currentDate);
  const dataToSave = targetData ? JSON.parse(JSON.stringify(targetData)) : JSON.parse(JSON.stringify(currentDayData));
  dataToSave.date = dateKey;
  dataToSave.updatedAt = new Date().toISOString();

  // Sync content strings for all blocks
  for (const k of Object.keys(dataToSave)) {
    if (k !== 'date' && k !== 'updatedAt') {
      const block = dataToSave[k];
      if (block) {
        const parts = [];
        if (Array.isArray(block.tasks) && block.tasks.length > 0) {
          parts.push(block.tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'));
        }
        if (block.notes && block.notes.trim().length > 0) {
          parts.push(block.notes.trim());
        }
        block.content = parts.join('\n\n');
      }
    }
  }

  if (statusDot) statusDot.classList.add('pulsing');
  if (statusLabel) statusLabel.textContent = "Saving...";

  safeStorage.setItem(`mrt_${dateKey}`, JSON.stringify(dataToSave));
  callTauri('save_day', { entry: dataToSave });

  if (hasContent(dataToSave)) {
    activeDatesSet.add(dateKey);
    safeStorage.setItem('mrt_active_dates', JSON.stringify(Array.from(activeDatesSet)));
  }

  isDirty = false;
  setTimeout(() => {
    if (statusDot) statusDot.classList.remove('pulsing');
    if (statusLabel) statusLabel.textContent = "Saved";
  }, 300);
}

function hasContent(data) {
  for (const key of Object.keys(data)) {
    if (key !== 'date' && key !== 'updatedAt') {
      const b = data[key];
      if (b) {
        if (Array.isArray(b.tasks) && b.tasks.length > 0) return true;
        if (b.notes && b.notes.trim().length > 0) return true;
        if (b.content && b.content.trim().length > 0) return true;
      }
    }
  }
  return false;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Switch between independent Tasks panel and Notes panel inside a card
function setCardActiveTab(card, tabName) {
  card.dataset.activeTab = tabName;
  const blockKey = card.getAttribute('data-block');
  const tasksPanel = card.querySelector('.card-tasks-panel');
  const notesPanel = card.querySelector('.card-notes-panel');
  const btnTasks = card.querySelector('.tab-tasks');
  const btnNotes = card.querySelector('.tab-notes');

  if (tabName === 'tasks') {
    if (tasksPanel) tasksPanel.style.display = 'flex';
    if (notesPanel) notesPanel.style.display = 'none';
    if (btnTasks) btnTasks.classList.add('active');
    if (btnNotes) btnNotes.classList.remove('active');
    renderCardTasks(card, blockKey);
  } else {
    if (tasksPanel) tasksPanel.style.display = 'none';
    if (notesPanel) notesPanel.style.display = 'flex';
    if (btnNotes) btnNotes.classList.add('active');
    if (btnTasks) btnTasks.classList.remove('active');
    renderCardNotes(card, blockKey);
  }
}

// Render Tasks List for a Card
function renderCardTasks(card, blockKey) {
  const tasksPanel = card.querySelector('.card-tasks-panel');
  if (!tasksPanel) return;
  const listEl = tasksPanel.querySelector('.tasks-scroll-list');
  if (!listEl) return;

  const block = currentDayData[blockKey] || { tasks: [], notes: "" };
  const tasks = Array.isArray(block.tasks) ? block.tasks : [];
  listEl.innerHTML = '';

  if (tasks.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'tasks-empty-hint';
    hint.innerHTML = '<span>No tasks yet. Click here or press <b>☐</b> to insert task.</span>';
    hint.style.cursor = 'pointer';
    hint.title = 'Click to insert checkbox task';
    hint.addEventListener('click', () => insertCheckboxTask(card, blockKey, ''));
    listEl.appendChild(hint);
    updateCardTabBadges(card, blockKey);
    return;
  }

  tasks.forEach((task, idx) => {
    const row = document.createElement('div');
    row.className = `task-row ${task.done ? 'is-completed' : ''}`;
    row.dataset.taskIdx = idx;

    row.innerHTML = `
      <button type="button" class="task-checkbox-btn ${task.done ? 'checked' : ''}" title="${task.done ? 'Mark active' : 'Mark completed'}">
        <svg class="task-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
      <input type="text" class="task-row-input ${task.done ? 'task-done' : ''}" value="${escapeHtml(task.text)}" placeholder="Task..." spellcheck="false" />
      <button type="button" class="task-row-del" title="Delete task">×</button>
    `;

    // 1. Toggle Checkbox (Dedicated, no misclicks)
    const checkBtn = row.querySelector('.task-checkbox-btn');
    checkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      task.done = !task.done;
      row.classList.toggle('is-completed', task.done);
      checkBtn.classList.toggle('checked', task.done);
      const input = row.querySelector('.task-row-input');
      if (input) input.classList.toggle('task-done', task.done);
      syncBlockContent(blockKey);
      updateCardTabBadges(card, blockKey);
      updateTotalProgress();
      triggerAutoSave();
    });

    // 2. Edit Task Text (NEVER toggles checkbox)
    const input = row.querySelector('.task-row-input');
    input.addEventListener('input', () => {
      task.text = input.value;
      syncBlockContent(blockKey);
      triggerAutoSave();
    });

    // Enter to insert new task below; Backspace on empty to delete
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tasks.splice(idx + 1, 0, { text: '', done: false });
        syncBlockContent(blockKey);
        renderCardTasks(card, blockKey);
        updateCardTabBadges(card, blockKey);
        triggerAutoSave();
        setTimeout(() => {
          const nextRow = listEl.querySelector(`.task-row[data-task-idx="${idx + 1}"] .task-row-input`);
          if (nextRow) nextRow.focus();
        }, 20);
      } else if (e.key === 'Backspace' && input.value === '') {
        e.preventDefault();
        tasks.splice(idx, 1);
        syncBlockContent(blockKey);
        renderCardTasks(card, blockKey);
        updateCardTabBadges(card, blockKey);
        updateTotalProgress();
        triggerAutoSave();
        setTimeout(() => {
          const prevRow = listEl.querySelector(`.task-row[data-task-idx="${Math.max(0, idx - 1)}"] .task-row-input`);
          if (prevRow) prevRow.focus();
        }, 20);
      }
    });

    // 3. Delete Task Button
    const delBtn = row.querySelector('.task-row-del');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tasks.splice(idx, 1);
      syncBlockContent(blockKey);
      renderCardTasks(card, blockKey);
      updateCardTabBadges(card, blockKey);
      updateTotalProgress();
      triggerAutoSave();
    });

    listEl.appendChild(row);
  });

  updateCardTabBadges(card, blockKey);
}

// Render Notes Editor for a Card
function renderCardNotes(card, blockKey) {
  const notesPanel = card.querySelector('.card-notes-panel');
  if (!notesPanel) return;
  const editor = notesPanel.querySelector('.card-notes-editor');
  if (!editor) return;

  const block = currentDayData[blockKey] || { tasks: [], notes: "" };
  editor.value = block.notes || "";
}

// Update badges on the Tasks / Notes tabs
function updateCardTabBadges(card, blockKey) {
  const block = currentDayData[blockKey] || { tasks: [], notes: "" };
  const tasks = Array.isArray(block.tasks) ? block.tasks : [];
  const total = tasks.length;
  const completed = tasks.filter(t => t.done).length;

  const badge = card.querySelector('.tab-task-badge');
  if (badge) {
    if (total > 0) {
      badge.textContent = `${completed}/${total}`;
      badge.style.display = 'inline-block';
      if (completed === total) {
        badge.classList.add('completed');
      } else {
        badge.classList.remove('completed');
      }
    } else {
      badge.textContent = '0';
      badge.style.display = 'none';
      badge.classList.remove('completed');
    }
  }

  // Update Notes tab indicator dot
  const notesTab = card.querySelector('.tab-notes');
  if (notesTab) {
    let dot = notesTab.querySelector('.tab-notes-dot');
    const hasNotes = block.notes && block.notes.trim().length > 0;
    if (hasNotes) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'tab-notes-dot';
        notesTab.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }
}

// Insert a new checkbox task directly into the card block
function insertCheckboxTask(card, blockKey, taskText = '') {
  if (!currentDayData[blockKey]) {
    currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
  }
  if (!Array.isArray(currentDayData[blockKey].tasks)) {
    currentDayData[blockKey].tasks = [];
  }

  const tasks = currentDayData[blockKey].tasks;
  const newIdx = tasks.length;
  tasks.push({ text: taskText || '', done: false });

  syncBlockContent(blockKey);
  setCardActiveTab(card, 'tasks');
  renderCardTasks(card, blockKey);
  updateCardTabBadges(card, blockKey);
  updateTotalProgress();
  triggerAutoSave();

  setTimeout(() => {
    const tasksPanel = card.querySelector('.card-tasks-panel');
    if (tasksPanel) {
      const listEl = tasksPanel.querySelector('.tasks-scroll-list');
      if (listEl) {
        listEl.scrollTop = listEl.scrollHeight;
        const newRowInput = listEl.querySelector(`.task-row[data-task-idx="${newIdx}"] .task-row-input`);
        if (newRowInput) {
          newRowInput.focus();
        }
      }
    }
  }, 25);
}

// Backward-compatible alias
const addTaskToBlock = insertCheckboxTask;

// Populate UI from State
function renderCurrentDay() {
  if (currentDateLabel) {
    currentDateLabel.textContent = formatDateDisplay(currentDate);
  }

  const todayKey = formatDateKey(new Date());
  const currentKey = formatDateKey(currentDate);
  if (btnToday) {
    if (todayKey === currentKey) btnToday.classList.add('active-today');
    else btnToday.classList.remove('active-today');
  }

  // Populate each card
  document.querySelectorAll('.cool-card, .block-card').forEach(card => {
    const blockKey = card.getAttribute('data-block');
    if (!currentDayData[blockKey]) {
      currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
    }
    const blockData = currentDayData[blockKey];

    // Enforce Breadth and Survivo normalization
    if (blockKey === 'part2') {
      const p2 = (blockData.title || '').trim().toLowerCase();
      if (!p2 || p2.includes('electronics') || p2.includes('motors') || p2.includes('part - 2') || p2.includes('part-2') || p2.includes('part 2')) {
        blockData.title = 'Breadth';
      }
    }
    if (blockKey === 'evening_survivi') {
      const surv = (blockData.title || '').trim().toLowerCase();
      if (!surv || surv.includes('survivi')) {
        blockData.title = 'Survivo';
      }
    }

    const titleInput = card.querySelector('.card-title-input');
    if (titleInput) {
      titleInput.value = blockData.title || getDefaultTitle(blockKey);
    }

    // Pre-populate notes editor so switching tabs is instant
    renderCardNotes(card, blockKey);

    // Default tab: tasks tab (tasks and notes are independent)
    const currentTab = card.dataset.activeTab || 'tasks';
    setCardActiveTab(card, currentTab);
    updateCardTabBadges(card, blockKey);
  });

  updateTotalProgress();
}

function updateTotalProgress() {
  let total = 0;
  let completed = 0;

  for (const key of Object.keys(currentDayData)) {
    if (key !== 'date' && key !== 'updatedAt') {
      const block = currentDayData[key];
      if (block && Array.isArray(block.tasks)) {
        total += block.tasks.length;
        completed += block.tasks.filter(t => t.done).length;
      }
    }
  }

  if (total > 0) {
    if (progressText) progressText.textContent = `${completed}/${total}`;
    if (progressCircle) {
      const circumference = 50.26;
      const offset = circumference - (completed / total) * circumference;
      progressCircle.style.strokeDashoffset = offset;
    }
  } else {
    if (progressText) progressText.textContent = "0/0";
    if (progressCircle) progressCircle.style.strokeDashoffset = 50.26;
  }
}

// Event Listeners for Card Inputs
function bindCardEvents() {
  document.querySelectorAll('.cool-card, .block-card').forEach(card => {
    const blockKey = card.getAttribute('data-block');
    const titleInput = card.querySelector('.card-title-input');
    const btnCheck = card.querySelector('.btn-check-insert, .btn-insert-check');
    const btnBullet = card.querySelector('.btn-bullet-insert, .btn-insert-bullet');

    // 1. Inject Tab Switcher in Card Header if not present
    let tabSwitcher = card.querySelector('.card-tab-switcher');
    if (!tabSwitcher) {
      tabSwitcher = document.createElement('div');
      tabSwitcher.className = 'card-tab-switcher';
      tabSwitcher.innerHTML = `
        <button type="button" class="tab-btn tab-tasks active" title="Tasks Checklist">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
          <span>Tasks</span>
          <span class="tab-task-badge" style="display:none;">0</span>
        </button>
        <button type="button" class="tab-btn tab-notes" title="Independent Notes">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          <span>Notes</span>
        </button>
      `;
      const barRight = card.querySelector('.card-bar-right');
      if (barRight) {
        barRight.prepend(tabSwitcher);
      }
    }

    // 2. Inject Independent Panels in Editor Area
    const editorArea = card.querySelector('.card-editor-area');
    if (editorArea) {
      // Clear out legacy textareas or old containers
      editorArea.innerHTML = `
        <!-- Independent Tasks Panel -->
        <div class="card-tasks-panel">
          <div class="task-add-row">
            <span class="task-add-icon">+</span>
            <input type="text" class="task-add-input" placeholder="Add task (press Enter)..." spellcheck="false" />
            <button type="button" class="btn-task-add-confirm">Add</button>
          </div>
          <div class="tasks-scroll-list"></div>
        </div>

        <!-- Independent Notes Panel -->
        <div class="card-notes-panel" style="display: none;">
          <textarea class="card-notes-editor" placeholder="Notes, thoughts, research notes..." spellcheck="false"></textarea>
        </div>
      `;
    }

    // 3. Tab Button Events
    const btnTasks = card.querySelector('.tab-tasks');
    const btnNotes = card.querySelector('.tab-notes');
    if (btnTasks) {
      btnTasks.addEventListener('click', () => setCardActiveTab(card, 'tasks'));
    }
    if (btnNotes) {
      btnNotes.addEventListener('click', () => setCardActiveTab(card, 'notes'));
    }

    // 4. Task Add Input & Button Events (Add tasks directly in task tab!)
    const addInput = card.querySelector('.task-add-input');
    const addConfirmBtn = card.querySelector('.btn-task-add-confirm');
    const addIcon = card.querySelector('.task-add-icon');

    const handleAddTask = () => {
      const val = (addInput ? addInput.value : '').trim();
      insertCheckboxTask(card, blockKey, val);
      if (addInput) {
        addInput.value = '';
      }
    };

    if (addInput) {
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddTask();
        }
      });
    }

    if (addConfirmBtn) {
      addConfirmBtn.addEventListener('click', handleAddTask);
    }

    if (addIcon) {
      addIcon.style.cursor = 'pointer';
      addIcon.title = 'Insert new checkbox task';
      addIcon.addEventListener('click', handleAddTask);
    }

    // 5. Notes Textarea Input Event (Independent notes editor)
    const notesEditor = card.querySelector('.card-notes-editor');
    if (notesEditor) {
      notesEditor.addEventListener('input', () => {
        if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
        currentDayData[blockKey].notes = notesEditor.value;
        syncBlockContent(blockKey);
        updateCardTabBadges(card, blockKey);
        triggerAutoSave();
      });
    }

    // 6. Title Edit
    if (titleInput) {
      titleInput.addEventListener('input', () => {
        if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
        currentDayData[blockKey].title = titleInput.value;
        triggerAutoSave();
      });
    }

    // 7. Header Checkbox Button (☐) -> Immediately insert a new checkbox task!
    if (btnCheck) {
      btnCheck.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertCheckboxTask(card, blockKey, '');
      });
    }

    // 8. Header Bullet Button (•) -> Immediately switch to Notes and append bullet!
    if (btnBullet) {
      btnBullet.addEventListener('click', () => {
        setCardActiveTab(card, 'notes');
        if (notesEditor) {
          const val = notesEditor.value;
          const prefix = val.length > 0 && !val.endsWith('\n') ? '\n' : '';
          notesEditor.value = val + prefix + '• ';
          notesEditor.focus();
          if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
          currentDayData[blockKey].notes = notesEditor.value;
          syncBlockContent(blockKey);
          updateCardTabBadges(card, blockKey);
          triggerAutoSave();
        }
      });
    }
  });
}

function triggerAutoSave() {
  isDirty = true;
  if (statusDot) statusDot.classList.add('pulsing');
  if (statusLabel) statusLabel.textContent = "Typing...";
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveDay, 700);
}

// Instant Non-Blocking Date Navigation
function changeDate(newDate) {
  // 1. Immediately save current dirty buffer
  if (isDirty) {
    saveDay(formatDateKey(currentDate), currentDayData);
  }

  // 2. Update current date and IMMEDIATELY render date header
  currentDate = new Date(newDate);
  const targetDateKey = formatDateKey(currentDate);

  if (currentDateLabel) {
    currentDateLabel.textContent = formatDateDisplay(currentDate);
  }

  // Highlight Today badge immediately
  const todayKey = formatDateKey(new Date());
  if (btnToday) {
    if (todayKey === targetDateKey) {
      btnToday.classList.add('active-today');
    } else {
      btnToday.classList.remove('active-today');
    }
  }

  // 3. Instant cache render (0ms response)
  const localCached = safeStorage.getItem(`mrt_${targetDateKey}`);
  if (localCached) {
    try {
      currentDayData = normalizeDayData(JSON.parse(localCached), targetDateKey);
    } catch (e) {
      currentDayData = getDefaultDayData(targetDateKey);
    }
  } else {
    currentDayData = getDefaultDayData(targetDateKey);
  }
  renderCurrentDay();

  // 4. Background fetch from native filesystem if available
  callTauri('get_day', { date: targetDateKey }).then(diskData => {
    if (formatDateKey(currentDate) === targetDateKey && diskData && typeof diskData === 'object') {
      currentDayData = normalizeDayData(diskData, targetDateKey);
      renderCurrentDay();
    }
  });
}

// Button Bindings
if (btnPrevDay) {
  btnPrevDay.addEventListener('click', () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    changeDate(d);
  });
}

if (btnNextDay) {
  btnNextDay.addEventListener('click', () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    changeDate(d);
  });
}

if (btnToday) {
  btnToday.addEventListener('click', () => {
    changeDate(new Date());
  });
}

if (currentDateLabel) {
  currentDateLabel.style.cursor = 'pointer';
  currentDateLabel.title = "Click to open 365 Diary Navigator";
  currentDateLabel.addEventListener('click', openCalendarModal);
}

// Theme Button
if (btnTheme) {
  btnTheme.addEventListener('click', () => {
    cycleTheme();
  });
}

// Export Markdown Button
if (btnExport) {
  btnExport.addEventListener('click', () => {
    const dateKey = formatDateKey(currentDate);
    let md = `# MRT Daily Planner — ${formatDateDisplay(currentDate)}\n\n`;

    md += `## 🌅 04:00 — 09:00 (Learning & Core Tracks)\n\n`;
    md += `### ${currentDayData.part1_quad1?.title || 'CS & SWE'}\n${currentDayData.part1_quad1?.content || ''}\n\n`;
    md += `### ${currentDayData.part1_quad2?.title || 'Core AI'}\n${currentDayData.part1_quad2?.content || ''}\n\n`;
    md += `### ${currentDayData.part1_quad3?.title || 'Applications'}\n${currentDayData.part1_quad3?.content || ''}\n\n`;
    md += `### ${currentDayData.part1_quad4?.title || 'RSWE'}\n${currentDayData.part1_quad4?.content || ''}\n\n`;

    md += `## ⚡ ${currentDayData.part2?.title || 'Breadth'}\n${currentDayData.part2?.content || ''}\n\n`;
    md += `## 🚀 ${currentDayData.productive?.title || 'Productive (09:00 - 14:00)'}\n${currentDayData.productive?.content || ''}\n\n`;
    md += `## 📋 ${currentDayData.admin?.title || 'Admin & Chores (14:00 - 18:00)'}\n${currentDayData.admin?.content || ''}\n\n`;

    md += `## 🌙 18:00 — 23:00 Evening Phase (6 Tracks)\n\n`;
    md += `### ${currentDayData.evening_huro?.title || 'Huro'}\n${currentDayData.evening_huro?.content || ''}\n\n`;
    md += `### ${currentDayData.evening_kana?.title || 'Kana'}\n${currentDayData.evening_kana?.content || ''}\n\n`;
    md += `### ${currentDayData.evening_bana?.title || 'Bana'}\n${currentDayData.evening_bana?.content || ''}\n\n`;
    md += `### ${currentDayData.evening_curio?.title || 'Curio'}\n${currentDayData.evening_curio?.content || ''}\n\n`;
    md += `### ${currentDayData.evening_survivi?.title || 'Survivo'}\n${currentDayData.evening_survivi?.content || ''}\n\n`;
    md += `### ${currentDayData.evening_random?.title || 'Random'}\n${currentDayData.evening_random?.content || ''}\n\n`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mrt_${dateKey}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported mrt_${dateKey}.md`);
  });
}

// Open Data Folder Button
if (btnOpenFolder) {
  btnOpenFolder.addEventListener('click', async () => {
    const res = await callTauri('open_data_folder');
    if (res !== null) {
      showToast("Opened data folder in file manager");
    } else {
      showToast("Storage: ~/.local/share/mrt/entries");
    }
  });
}

// Toast Helper
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// 365 Calendar Modal
if (btnCalendarToggle) {
  btnCalendarToggle.addEventListener('click', openCalendarModal);
}
if (btnCloseCalendar) {
  btnCloseCalendar.addEventListener('click', () => calendarModal && calendarModal.classList.remove('open'));
}
if (calendarModal) {
  calendarModal.addEventListener('click', (e) => {
    if (e.target === calendarModal) calendarModal.classList.remove('open');
  });
}

function openCalendarModal() {
  if (!calendarModal) return;
  if (calendarYearTitle) {
    calendarYearTitle.textContent = `📅 365-Day Diary Navigator (${currentDate.getFullYear()})`;
  }
  renderCalendarMonths(currentDate.getFullYear());
  calendarModal.classList.add('open');
}

function renderCalendarMonths(year) {
  if (!calendarMonthsGrid) return;
  calendarMonthsGrid.innerHTML = '';
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const weekdays = ["M", "T", "W", "T", "F", "S", "S"];

  months.forEach((monthName, mIdx) => {
    const monthBox = document.createElement('div');
    monthBox.className = 'month-box';

    const title = document.createElement('div');
    title.className = 'month-title';
    title.textContent = monthName;
    monthBox.appendChild(title);

    const weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'weekdays-row';
    weekdays.forEach(w => {
      const span = document.createElement('span');
      span.textContent = w;
      weekdaysRow.appendChild(span);
    });
    monthBox.appendChild(weekdaysRow);

    const daysGrid = document.createElement('div');
    daysGrid.className = 'days-grid';

    const firstDay = new Date(year, mIdx, 1);
    const lastDay = new Date(year, mIdx + 1, 0);
    const startWeekday = (firstDay.getDay() + 6) % 7; // Monday = 0

    for (let i = 0; i < startWeekday; i++) {
      const blank = document.createElement('div');
      daysGrid.appendChild(blank);
    }

    const currentKey = formatDateKey(currentDate);

    for (let day = 1; day <= lastDay.getDate(); day++) {
      const d = new Date(year, mIdx, day);
      const dKey = formatDateKey(d);
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.textContent = day;

      if (dKey === currentKey) {
        cell.classList.add('current-view');
      }
      if (activeDatesSet.has(dKey)) {
        cell.classList.add('has-entry');
        cell.title = "Has journal notes";
      }

      cell.addEventListener('click', () => {
        changeDate(d);
        calendarModal.classList.remove('open');
      });

      daysGrid.appendChild(cell);
    }

    monthBox.appendChild(daysGrid);
    calendarMonthsGrid.appendChild(monthBox);
  });
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    if (e.key === 'Escape') {
      document.activeElement.blur();
    }
    return;
  }

  if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (btnPrevDay) btnPrevDay.click();
  } else if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) {
    e.preventDefault();
    if (btnNextDay) btnNextDay.click();
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    if (btnToday) btnToday.click();
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    cycleTheme();
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    if (calendarModal?.classList.contains('open')) {
      calendarModal.classList.remove('open');
    } else {
      openCalendarModal();
    }
  } else if (e.key === 'Escape') {
    if (calendarModal) calendarModal.classList.remove('open');
  }
});

// Initialization (Instant Synchronous UI + Non-blocking Background Sync)
function init() {
  // 1. Immediately bind cards and inputs
  bindCardEvents();

  // 2. Synchronously display current day
  const dateKey = formatDateKey(currentDate);
  if (currentDateLabel) {
    currentDateLabel.textContent = formatDateDisplay(currentDate);
  }
  const todayKey = formatDateKey(new Date());
  if (btnToday) {
    if (todayKey === dateKey) btnToday.classList.add('active-today');
    else btnToday.classList.remove('active-today');
  }

  // 3. Immediately render cached data or defaults
  const localCached = safeStorage.getItem(`mrt_${dateKey}`);
  if (localCached) {
    try {
      currentDayData = normalizeDayData(JSON.parse(localCached), dateKey);
    } catch (e) {
      currentDayData = getDefaultDayData(dateKey);
    }
  } else {
    currentDayData = getDefaultDayData(dateKey);
  }
  renderCurrentDay();

  // 4. Background non-blocking sync with native disk
  callTauri('get_day', { date: dateKey }).then(diskData => {
    if (formatDateKey(currentDate) === dateKey && diskData && typeof diskData === 'object') {
      currentDayData = normalizeDayData(diskData, dateKey);
      renderCurrentDay();
    }
  });

  // 5. Query active dates & storage directory in background
  callTauri('get_data_folder_path').then(folderPath => {
    if (folderPath && footerStoragePath) {
      footerStoragePath.textContent = `Storage: ${folderPath}`;
    }
  });

  callTauri('get_active_dates').then(activeDates => {
    if (Array.isArray(activeDates)) {
      activeDatesSet = new Set(activeDates);
    } else {
      const cachedDates = safeStorage.getItem('mrt_active_dates');
      if (cachedDates) {
        try { activeDatesSet = new Set(JSON.parse(cachedDates)); } catch (e) {}
      }
    }
  });
}

// Start application immediately
init();
