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
let savedTheme = safeStorage.getItem('mrt_theme');
if (!['paper', 'chalk', 'ceramic'].includes(savedTheme)) {
  savedTheme = 'paper';
}
let currentTheme = savedTheme;
let currentPendingCarryover = [];
let currentPendingCarryoverSourceDate = null;
let currentImportSourceDate = null;

const ALL_BLOCK_KEYS = [
  'health_workout', 'health_diet', 'health_habits', 'health_recovery',
  'part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4',
  'part2', 'productive', 'admin',
  'evening_huro', 'evening_kana', 'evening_bana',
  'evening_curio', 'evening_survivi', 'evening_random'
];

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

// Smart Task Carryover & Banner DOM Elements
const btnCarryoverCheck = document.getElementById('btn-carryover-check');
const carryoverBanner = document.getElementById('carryover-banner');
const carryoverTitle = document.getElementById('carryover-title');
const carryoverPreview = document.getElementById('carryover-preview');
const btnCarryoverApply = document.getElementById('btn-carryover-apply');
const btnCarryoverChoose = document.getElementById('btn-carryover-choose');
const btnCarryoverDismiss = document.getElementById('btn-carryover-dismiss');

// Roll Over & Import Day Modal Elements
const btnImportPlanner = document.getElementById('btn-import-planner');
const importModal = document.getElementById('import-planner-modal');
const btnCloseImportModal = document.getElementById('btn-close-import-modal');
const btnImportCancel = document.getElementById('btn-import-cancel');
const btnImportExecute = document.getElementById('btn-import-execute');
const importQuickChips = document.getElementById('import-quick-chips');
const importSourceDateInput = document.getElementById('import-source-date-input');
const previewDateBadge = document.getElementById('preview-date-badge');
const previewStatPill = document.getElementById('preview-stat-pill');
const previewContentSummary = document.getElementById('preview-content-summary');
const chkImportTasks = document.getElementById('chk-import-tasks');
const chkImportNotes = document.getElementById('chk-import-notes');
const chkImportTitles = document.getElementById('chk-import-titles');

// Phase Isolation & Lock-In Deep Work DOM Elements
let currentPhase = safeStorage.getItem('mrt_phase') || 'all';
const btnDeepWorkFocus = document.getElementById('btn-deep-work-focus');
const lockinModal = document.getElementById('lockin-focus-modal');
const lockinPhaseLabel = document.getElementById('lockin-phase-label');
const lockinBlockLabel = document.getElementById('lockin-block-label');
const lockinTimerDisplay = document.getElementById('lockin-timer-display');
const btnLockinTimerToggle = document.getElementById('btn-lockin-timer-toggle');
const btnLockinTimerReset = document.getElementById('btn-lockin-timer-reset');
const btnLockinExit = document.getElementById('btn-lockin-exit');
const btnLockinCheck = document.getElementById('btn-lockin-check');
const lockinTaskInput = document.getElementById('lockin-task-input');
const lockinNotesArea = document.getElementById('lockin-notes-area');

// Apply Initial Theme
setTheme(currentTheme, false);

function setTheme(theme, notify = true) {
  if (!['paper', 'chalk', 'ceramic'].includes(theme)) {
    theme = 'paper';
  }
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  safeStorage.setItem('mrt_theme', theme);

  if (notify) {
    const themeNames = {
      paper: 'Pen & Paper',
      chalk: 'Chalk & Blackboard',
      ceramic: 'Satin Clay'
    };
    showToast(`Theme: ${themeNames[theme] || theme}`);
  }
}

function cycleTheme() {
  if (currentTheme === 'paper') {
    setTheme('chalk');
  } else if (currentTheme === 'chalk') {
    setTheme('ceramic');
  } else {
    setTheme('paper');
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
    evening_random: "Random",
    health_workout: "Workout (5-6 AM)",
    health_diet: "Diet & Meals",
    health_habits: "Hydration & Supplements",
    health_recovery: "Body & Recovery"
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
    health_workout: getDefaultBlockData("Workout (5-6 AM)"),
    health_diet: getDefaultBlockData("Diet & Meals"),
    health_habits: getDefaultBlockData("Hydration & Supplements"),
    health_recovery: getDefaultBlockData("Body & Recovery"),
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
      const isSubtask = (line.startsWith('  ') || line.startsWith('\t')) && extractedTasks.length > 0;
      if (isSubtask) {
        if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
          const parent = extractedTasks[extractedTasks.length - 1];
          if (!Array.isArray(parent.subtasks)) parent.subtasks = [];
          parent.subtasks.push({ text: trimmed.replace(/^[-*]\s\[\s\]\s?/, ''), done: false });
          continue;
        } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]') || trimmed.startsWith('* [x]') || trimmed.startsWith('* [X]')) {
          const parent = extractedTasks[extractedTasks.length - 1];
          if (!Array.isArray(parent.subtasks)) parent.subtasks = [];
          parent.subtasks.push({ text: trimmed.replace(/^[-*]\s\[[xX]\]\s?/, ''), done: true });
          continue;
        }
      }

      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
        extractedTasks.push({ text: trimmed.replace(/^[-*]\s\[\s\]\s?/, ''), done: false, subtasks: [] });
      } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]') || trimmed.startsWith('* [x]') || trimmed.startsWith('* [X]')) {
        extractedTasks.push({ text: trimmed.replace(/^[-*]\s\[[xX]\]\s?/, ''), done: true, subtasks: [] });
      } else if (trimmed.length > 0) {
        extractedNotes.push(line);
      }
    }

    if (tasks === null) tasks = extractedTasks;
    if (notes === null) notes = extractedNotes.join('\n');
  }

  if (Array.isArray(tasks)) {
    tasks = tasks.map(t => ({
      text: t.text || '',
      done: !!t.done,
      notes: typeof t.notes === 'string' ? t.notes : '',
      subtasks: Array.isArray(t.subtasks)
        ? t.subtasks.map(s => ({
            text: typeof s === 'string' ? s : (s.text || ''),
            done: !!s.done
          }))
        : []
    }));
  } else {
    tasks = [];
  }

  // Generate serialized content for markdown export compatibility
  const contentParts = [];
  if (tasks.length > 0) {
    const taskLines = [];
    for (const t of tasks) {
      taskLines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
      if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
        for (const s of t.subtasks) {
          taskLines.push(`  - [${s.done ? 'x' : ' '}] ${s.text}`);
        }
      }
    }
    contentParts.push(taskLines.join('\n'));
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

  for (const k of ALL_BLOCK_KEYS) {
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
    const taskLines = [];
    for (const t of block.tasks) {
      taskLines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
      if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
        for (const s of t.subtasks) {
          taskLines.push(`  - [${s.done ? 'x' : ' '}] ${s.text}`);
        }
      }
    }
    parts.push(taskLines.join('\n'));
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
          const taskLines = [];
          for (const t of block.tasks) {
            taskLines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
            if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
              for (const s of t.subtasks) {
                taskLines.push(`  - [${s.done ? 'x' : ' '}] ${s.text}`);
              }
            }
          }
          parts.push(taskLines.join('\n'));
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
  listEl.onclick = null;

  if (tasks.length === 0) {
    updateCardTabBadges(card, blockKey);
    return;
  }

  tasks.forEach((task, idx) => {
    const row = document.createElement('div');
    row.className = `task-row ${task.done ? 'is-completed' : ''}`;
    row.dataset.taskIdx = idx;

    const hasNotes = typeof task.notes === 'string' && task.notes.trim().length > 0;
    const lockinBtnLabel = hasNotes ? '⏱ Notes •' : '⏱ Lock-in';
    const lockinBtnTitle = hasNotes ? 'Task-specific notes attached. Click to open focus & notes.' : 'Lock-in on this task (Time Block & Notes)';
    
    if (!Array.isArray(task.subtasks)) {
      task.subtasks = [];
    }
    const subTotal = task.subtasks.length;
    const subDone = task.subtasks.filter(s => s.done).length;
    const subBadgeHtml = subTotal > 0
      ? `<span class="task-subtasks-count ${subDone === subTotal ? 'completed' : ''}" title="${subDone}/${subTotal} subtasks done">${subDone}/${subTotal}</span>`
      : '';

    row.innerHTML = `
      <button type="button" class="task-checkbox-btn ${task.done ? 'checked' : ''}" title="${task.done ? 'Mark active' : 'Mark completed'}">
        <svg class="task-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
      <input type="text" class="task-row-input ${task.done ? 'task-done' : ''}" value="${escapeHtml(task.text)}" placeholder="Task..." spellcheck="false" />
      ${subBadgeHtml}
      <button type="button" class="task-row-add-sub" title="Add Subtask (or press Tab in task)">↳ Sub</button>
      <button type="button" class="task-row-lockin ${hasNotes ? 'has-notes' : ''}" title="${lockinBtnTitle}">${lockinBtnLabel}</button>
      <button type="button" class="task-row-del" title="Delete task">×</button>
    `;

    // Track active selection on focus and click
    const input = row.querySelector('.task-row-input');
    input.addEventListener('focus', () => {
      setActiveTaskSelection(blockKey, idx);
    });
    row.addEventListener('click', (e) => {
      if (!e.target.closest('.task-checkbox-btn') && !e.target.closest('.task-row-del') && !e.target.closest('.task-row-lockin') && !e.target.closest('.task-row-add-sub')) {
        setActiveTaskSelection(blockKey, idx);
      }
    });

    // 1. Toggle Checkbox (Dedicated, no misclicks)
    const checkBtn = row.querySelector('.task-checkbox-btn');
    checkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveTaskSelection(blockKey, idx);
      task.done = !task.done;
      row.classList.toggle('is-completed', task.done);
      checkBtn.classList.toggle('checked', task.done);
      if (input) input.classList.toggle('task-done', task.done);
      syncBlockContent(blockKey);
      updateCardTabBadges(card, blockKey);
      updateTotalProgress();
      triggerAutoSave();
    });

    // 2. Edit Task Text (NEVER toggles checkbox)
    input.addEventListener('input', () => {
      task.text = input.value;
      syncBlockContent(blockKey);
      triggerAutoSave();
    });

    // Enter to insert new task below; Tab to add subtask; Backspace on empty to delete
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tasks.splice(idx + 1, 0, { text: '', done: false, notes: '', subtasks: [] });
        syncBlockContent(blockKey);
        renderCardTasks(card, blockKey);
        updateCardTabBadges(card, blockKey);
        triggerAutoSave();
        setTimeout(() => {
          const nextRow = listEl.querySelector(`.task-row[data-task-idx="${idx + 1}"] .task-row-input`);
          if (nextRow) {
            nextRow.focus();
            setActiveTaskSelection(blockKey, idx + 1);
          }
        }, 20);
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        setActiveTaskSelection(blockKey, idx);
        if (!Array.isArray(task.subtasks)) task.subtasks = [];
        task.subtasks.push({ text: '', done: false });
        syncBlockContent(blockKey);
        renderCardTasks(card, blockKey);
        updateCardTabBadges(card, blockKey);
        triggerAutoSave();
        setTimeout(() => {
          const newSubInput = listEl.querySelector(`.task-subtasks-tree[data-parent-task-idx="${idx}"] .subtask-row[data-sub-idx="${task.subtasks.length - 1}"] .subtask-row-input`);
          if (newSubInput) newSubInput.focus();
        }, 25);
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
          if (prevRow) {
            prevRow.focus();
            setActiveTaskSelection(blockKey, Math.max(0, idx - 1));
          }
        }, 20);
      }
    });

    // 3. Add Subtask Button
    const addSubBtn = row.querySelector('.task-row-add-sub');
    if (addSubBtn) {
      addSubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveTaskSelection(blockKey, idx);
        if (!Array.isArray(task.subtasks)) task.subtasks = [];
        task.subtasks.push({ text: '', done: false });
        syncBlockContent(blockKey);
        renderCardTasks(card, blockKey);
        updateCardTabBadges(card, blockKey);
        triggerAutoSave();
        setTimeout(() => {
          const newSubInput = listEl.querySelector(`.task-subtasks-tree[data-parent-task-idx="${idx}"] .subtask-row[data-sub-idx="${task.subtasks.length - 1}"] .subtask-row-input`);
          if (newSubInput) newSubInput.focus();
        }, 25);
      });
    }

    // 4. Task-Specific Lock-In Action
    const lockinBtn = row.querySelector('.task-row-lockin');
    if (lockinBtn) {
      lockinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveTaskSelection(blockKey, idx);
        openLockInFocus(blockKey, idx);
      });
    }

    // 5. Delete Task Button
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

    // 6. Render Subtasks Tree branch if subtasks exist
    if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
      const subtasksTree = document.createElement('div');
      subtasksTree.className = 'task-subtasks-tree';
      subtasksTree.dataset.parentTaskIdx = idx;

      task.subtasks.forEach((sub, sIdx) => {
        const subRow = document.createElement('div');
        subRow.className = `subtask-row ${sub.done ? 'is-completed' : ''}`;
        subRow.dataset.subIdx = sIdx;
        subRow.innerHTML = `
          <span class="subtask-connector">↳</span>
          <button type="button" class="subtask-checkbox-btn ${sub.done ? 'checked' : ''}" title="${sub.done ? 'Mark active' : 'Mark completed'}">
            <svg class="subtask-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
          <input type="text" class="subtask-row-input ${sub.done ? 'task-done' : ''}" value="${escapeHtml(sub.text)}" placeholder="Subtask..." spellcheck="false" />
          <button type="button" class="subtask-row-del" title="Delete subtask">×</button>
        `;

        const subInput = subRow.querySelector('.subtask-row-input');
        const subCheck = subRow.querySelector('.subtask-checkbox-btn');
        const subDel = subRow.querySelector('.subtask-row-del');

        // Subtask checkbox
        subCheck.addEventListener('click', (e) => {
          e.stopPropagation();
          sub.done = !sub.done;
          subCheck.classList.toggle('checked', sub.done);
          subInput.classList.toggle('task-done', sub.done);
          subRow.classList.toggle('is-completed', sub.done);
          syncBlockContent(blockKey);
          updateCardTabBadges(card, blockKey);
          updateTotalProgress();
          renderCardTasks(card, blockKey);
          triggerAutoSave();
        });

        // Subtask input typing
        subInput.addEventListener('input', () => {
          sub.text = subInput.value;
          syncBlockContent(blockKey);
          triggerAutoSave();
        });

        // Subtask keyboard navigation: Enter creates next subtask, Backspace on empty deletes, Shift+Tab outdents
        subInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            task.subtasks.splice(sIdx + 1, 0, { text: '', done: false });
            syncBlockContent(blockKey);
            renderCardTasks(card, blockKey);
            updateCardTabBadges(card, blockKey);
            triggerAutoSave();
            setTimeout(() => {
              const nextSubInput = listEl.querySelector(`.task-subtasks-tree[data-parent-task-idx="${idx}"] .subtask-row[data-sub-idx="${sIdx + 1}"] .subtask-row-input`);
              if (nextSubInput) nextSubInput.focus();
            }, 20);
          } else if (e.key === 'Backspace' && subInput.value === '') {
            e.preventDefault();
            task.subtasks.splice(sIdx, 1);
            syncBlockContent(blockKey);
            renderCardTasks(card, blockKey);
            updateCardTabBadges(card, blockKey);
            updateTotalProgress();
            triggerAutoSave();
            setTimeout(() => {
              if (sIdx > 0) {
                const prevSubInput = listEl.querySelector(`.task-subtasks-tree[data-parent-task-idx="${idx}"] .subtask-row[data-sub-idx="${sIdx - 1}"] .subtask-row-input`);
                if (prevSubInput) prevSubInput.focus();
              } else {
                const parentInput = listEl.querySelector(`.task-row[data-task-idx="${idx}"] .task-row-input`);
                if (parentInput) parentInput.focus();
              }
            }, 20);
          } else if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            const textToPromote = sub.text;
            const doneToPromote = sub.done;
            task.subtasks.splice(sIdx, 1);
            tasks.splice(idx + 1, 0, { text: textToPromote, done: doneToPromote, notes: '', subtasks: [] });
            syncBlockContent(blockKey);
            renderCardTasks(card, blockKey);
            updateCardTabBadges(card, blockKey);
            triggerAutoSave();
            setTimeout(() => {
              const promotedInput = listEl.querySelector(`.task-row[data-task-idx="${idx + 1}"] .task-row-input`);
              if (promotedInput) promotedInput.focus();
            }, 20);
          }
        });

        // Subtask delete button
        subDel.addEventListener('click', (e) => {
          e.stopPropagation();
          task.subtasks.splice(sIdx, 1);
          syncBlockContent(blockKey);
          renderCardTasks(card, blockKey);
          updateCardTabBadges(card, blockKey);
          updateTotalProgress();
          triggerAutoSave();
        });

        subtasksTree.appendChild(subRow);
      });

      listEl.appendChild(subtasksTree);
    }
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
  let total = 0;
  let completed = 0;

  for (const t of tasks) {
    total++;
    if (t.done) completed++;
    if (Array.isArray(t.subtasks)) {
      for (const s of t.subtasks) {
        total++;
        if (s.done) completed++;
      }
    }
  }

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
  tasks.push({ text: taskText || '', done: false, notes: '', subtasks: [] });

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

// Active Selection State for Task-Specific Lock-In
let selectedBlockKey = 'part1_quad1';
let selectedTaskIdx = null;

function setActiveTaskSelection(blockKey, idx) {
  selectedBlockKey = blockKey;
  selectedTaskIdx = idx;

  document.querySelectorAll('.task-row.is-active-task').forEach(el => el.classList.remove('is-active-task'));
  document.querySelectorAll('.cool-card.is-active-card').forEach(el => el.classList.remove('is-active-card'));

  const card = document.querySelector(`.cool-card[data-block="${blockKey}"]`);
  if (card) {
    card.classList.add('is-active-card');
    const row = card.querySelector(`.task-row[data-task-idx="${idx}"]`);
    if (row) row.classList.add('is-active-task');
  }
}

function setActiveColumnSelection(blockKey) {
  selectedBlockKey = blockKey;
  document.querySelectorAll('.cool-card.is-active-card').forEach(el => el.classList.remove('is-active-card'));
  const card = document.querySelector(`.cool-card[data-block="${blockKey}"]`);
  if (card) {
    card.classList.add('is-active-card');
  }
}

// Insert a new bullet note properly at cursor position and continue writing
function insertBulletNote(card, blockKey) {
  setCardActiveTab(card, 'notes');
  const notesPanel = card.querySelector('.card-notes-panel');
  if (!notesPanel) return;
  const editor = notesPanel.querySelector('.card-notes-editor');
  if (!editor) return;

  const text = editor.value || '';
  const selStart = (editor.selectionStart !== undefined && editor.selectionStart !== null) ? editor.selectionStart : text.length;
  const selEnd = (editor.selectionEnd !== undefined && editor.selectionEnd !== null) ? editor.selectionEnd : text.length;

  let prefix = '';
  if (selStart > 0 && text[selStart - 1] !== '\n') {
    prefix = '\n';
  }
  const bulletStr = prefix + '• ';
  const newText = text.slice(0, selStart) + bulletStr + text.slice(selEnd);
  editor.value = newText;

  const newPos = selStart + bulletStr.length;
  editor.focus();
  editor.setSelectionRange(newPos, newPos);

  if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
  currentDayData[blockKey].notes = editor.value;
  syncBlockContent(blockKey);
  updateCardTabBadges(card, blockKey);
  triggerAutoSave();
}

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
        for (const t of block.tasks) {
          total++;
          if (t.done) completed++;
          if (Array.isArray(t.subtasks)) {
            for (const s of t.subtasks) {
              total++;
              if (s.done) completed++;
            }
          }
        }
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
          <div class="tasks-scroll-list"></div>
        </div>

        <!-- Independent Notes Panel -->
        <div class="card-notes-panel" style="display: none;">
          <textarea class="card-notes-editor" placeholder="" spellcheck="false"></textarea>
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

    // Card Selection Listener
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.task-row')) {
        setActiveColumnSelection(blockKey);
      }
    });
    card.addEventListener('focusin', () => {
      setActiveColumnSelection(blockKey);
    });

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

      // Smart bullet list continuation and backspace cleanup
      notesEditor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = notesEditor.value;
          const start = notesEditor.selectionStart;
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          const lineEnd = val.indexOf('\n', start);
          const currentLine = val.substring(lineStart, lineEnd === -1 ? val.length : lineEnd);

          const bulletMatch = currentLine.match(/^(\s*)(•|-|\*)\s+/);
          if (bulletMatch) {
            e.preventDefault();
            const prefix = bulletMatch[0];
            const content = currentLine.substring(prefix.length).trim();

            if (content.length === 0) {
              const updated = val.substring(0, lineStart) + val.substring(start);
              notesEditor.value = updated;
              notesEditor.setSelectionRange(lineStart, lineStart);
            } else {
              const insertText = '\n' + prefix;
              const updated = val.substring(0, start) + insertText + val.substring(start);
              notesEditor.value = updated;
              const nextPos = start + insertText.length;
              notesEditor.setSelectionRange(nextPos, nextPos);
            }

            if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
            currentDayData[blockKey].notes = notesEditor.value;
            syncBlockContent(blockKey);
            triggerAutoSave();
          }
        } else if (e.key === 'Backspace') {
          const val = notesEditor.value;
          const start = notesEditor.selectionStart;
          const end = notesEditor.selectionEnd;
          if (start === end) {
            const lineStart = val.lastIndexOf('\n', start - 1) + 1;
            const beforeCursor = val.substring(lineStart, start);
            if (/^(\s*)(•|-|\*)\s$/.test(beforeCursor)) {
              e.preventDefault();
              const updated = val.substring(0, lineStart) + val.substring(start);
              notesEditor.value = updated;
              notesEditor.setSelectionRange(lineStart, lineStart);
              if (!currentDayData[blockKey]) currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
              currentDayData[blockKey].notes = notesEditor.value;
              syncBlockContent(blockKey);
              triggerAutoSave();
            }
          }
        }
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
        setActiveColumnSelection(blockKey);
        insertCheckboxTask(card, blockKey, '');
      });
    }

    // 8. Header Bullet Button (•) -> Immediately insert bullet note at cursor!
    if (btnBullet) {
      btnBullet.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setActiveColumnSelection(blockKey);
        insertBulletNote(card, blockKey);
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

  // Dismiss / hide any active carryover banner for previous date
  if (carryoverBanner) carryoverBanner.style.display = 'none';
  currentPendingCarryover = [];

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

  // Check carryover for target date
  checkPendingCarryover(targetDateKey);

  // 4. Background fetch from native filesystem if available
  callTauri('get_day', { date: targetDateKey }).then(diskData => {
    if (formatDateKey(currentDate) === targetDateKey && diskData && typeof diskData === 'object') {
      currentDayData = normalizeDayData(diskData, targetDateKey);
      renderCurrentDay();
      checkPendingCarryover(targetDateKey);
    }
  });
}

// ==========================================================================
// Smart Task Carryover & Multi-Day Rollover Engine
// ==========================================================================

async function getAllStoredDates() {
  const dates = new Set(activeDatesSet);

  // 1. Fetch from Tauri filesystem if available
  try {
    const tauriDates = await callTauri('get_active_dates');
    if (Array.isArray(tauriDates)) {
      tauriDates.forEach(d => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
      });
    }
  } catch (e) {}

  // 2. Fetch from safeStorage cached active dates
  try {
    const cachedDates = safeStorage.getItem('mrt_active_dates');
    if (cachedDates) {
      const parsed = JSON.parse(cachedDates);
      if (Array.isArray(parsed)) parsed.forEach(d => dates.add(d));
    }
  } catch (e) {}

  // 3. Scan localStorage for any mrt_YYYY-MM-DD keys
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mrt_')) {
          const possibleDate = key.replace('mrt_', '');
          if (/^\d{4}-\d{2}-\d{2}$/.test(possibleDate)) {
            dates.add(possibleDate);
          }
        }
      }
    }
  } catch (e) {}

  activeDatesSet = dates;
  return Array.from(dates).sort().reverse();
}

async function findLatestActiveDayBefore(targetDateKey) {
  const allDates = await getAllStoredDates();
  
  // Find dates strictly before targetDateKey
  const pastDates = allDates.filter(d => d < targetDateKey);

  for (const dKey of pastDates) {
    const dData = await loadDay(dKey);
    if (hasContent(dData)) {
      return { dateKey: dKey, dayData: dData };
    }
  }

  // Fallback: Check yesterday directly even if not listed in active dates yet
  const [y, m, d] = targetDateKey.split('-').map(Number);
  const targetDateObj = new Date(y, m - 1, d);
  const yestDateObj = new Date(targetDateObj);
  yestDateObj.setDate(yestDateObj.getDate() - 1);
  const yestKey = formatDateKey(yestDateObj);

  if (!pastDates.includes(yestKey)) {
    const yestData = await loadDay(yestKey);
    if (hasContent(yestData)) {
      return { dateKey: yestKey, dayData: yestData };
    }
  }

  return null;
}

function analyzeSourceDay(dayData) {
  if (!dayData || typeof dayData !== 'object') {
    return {
      unfinishedTasks: [],
      completedTasksCount: 0,
      totalTasks: 0,
      notesCount: 0,
      blockNotes: {},
      blockTitles: {}
    };
  }

  const unfinishedTasks = [];
  let completedTasksCount = 0;
  let totalTasks = 0;
  let notesCount = 0;
  const blockNotes = {};
  const blockTitles = {};

  for (const k of ALL_BLOCK_KEYS) {
    const block = dayData[k];
    if (block) {
      if (block.title) {
        blockTitles[k] = block.title;
      }
      if (block.notes && block.notes.trim().length > 0) {
        notesCount++;
        blockNotes[k] = block.notes.trim();
      }
      if (Array.isArray(block.tasks)) {
        block.tasks.forEach(task => {
          if (!task || !task.text || task.text.trim().length === 0) return;
          totalTasks++;
          if (task.done) {
            completedTasksCount++;
          } else {
            unfinishedTasks.push({
              blockKey: k,
              blockTitle: block.title || getDefaultTitle(k),
              text: task.text.trim(),
              notes: task.notes || '',
              subtasks: Array.isArray(task.subtasks) ? JSON.parse(JSON.stringify(task.subtasks)) : []
            });
          }
        });
      }
    }
  }

  return {
    unfinishedTasks,
    completedTasksCount,
    totalTasks,
    notesCount,
    blockNotes,
    blockTitles
  };
}

function extractUnfinishedTasks(dayData) {
  return analyzeSourceDay(dayData).unfinishedTasks;
}

async function checkPendingCarryover(targetDateKey, forcePrompt = false) {
  if (!carryoverBanner) return;

  // If already dismissed for this day and not explicitly forced by user
  if (!forcePrompt && safeStorage.getItem(`mrt_carryover_dismissed_${targetDateKey}`) === 'true') {
    carryoverBanner.style.display = 'none';
    currentPendingCarryover = [];
    currentPendingCarryoverSourceDate = null;
    return;
  }

  carryoverBanner.style.display = 'none';
  currentPendingCarryover = [];
  currentPendingCarryoverSourceDate = null;

  // Find the latest active day before targetDateKey
  const activeDayResult = await findLatestActiveDayBefore(targetDateKey);
  if (!activeDayResult) {
    if (forcePrompt) {
      showToast("No earlier records found to roll over.");
    }
    return;
  }

  const { dateKey: sourceDateKey, dayData: sourceData } = activeDayResult;
  const analysis = analyzeSourceDay(sourceData);

  // Deduplicate against current target day's existing tasks
  const pendingTasks = analysis.unfinishedTasks.filter(item => {
    const currentBlock = currentDayData[item.blockKey];
    if (!currentBlock || !Array.isArray(currentBlock.tasks)) return true;
    return !currentBlock.tasks.some(t => t.text && t.text.trim().toLowerCase() === item.text.toLowerCase());
  });

  // Check if current day has any content
  const targetHasContent = hasContent(currentDayData);

  // If target day has no pending tasks AND already has content or source has no notes, nothing to prompt
  if (pendingTasks.length === 0 && (targetHasContent || analysis.notesCount === 0)) {
    if (forcePrompt) {
      showToast("All pending tasks already exist in today's planner! 👍");
    }
    return;
  }

  // Store active carryover candidate
  currentPendingCarryover = pendingTasks;
  currentPendingCarryoverSourceDate = sourceDateKey;

  const [y, m, d] = targetDateKey.split('-').map(Number);
  const targetDateObj = new Date(y, m - 1, d);
  const yestDateObj = new Date(targetDateObj);
  yestDateObj.setDate(yestDateObj.getDate() - 1);
  const yestKey = formatDateKey(yestDateObj);

  const isYesterday = (sourceDateKey === yestKey);
  const sourceName = isYesterday ? "Yesterday" : sourceDateKey;

  if (carryoverTitle) {
    if (pendingTasks.length > 0) {
      carryoverTitle.textContent = `${pendingTasks.length} Unfinished Task${pendingTasks.length > 1 ? 's' : ''} from ${sourceName}`;
    } else {
      carryoverTitle.textContent = `Inherit Notes & Setup from ${sourceName}`;
    }
  }

  if (carryoverPreview) {
    if (pendingTasks.length > 0) {
      const previewSummary = `${pendingTasks[0].blockTitle}: "${pendingTasks[0].text}"${pendingTasks.length > 1 ? ` (+${pendingTasks.length - 1} more)` : ''}${analysis.notesCount > 0 ? ' · Notes included' : ''}`;
      carryoverPreview.textContent = previewSummary;
    } else {
      carryoverPreview.textContent = `${analysis.notesCount} block notes ready to inherit without re-typing`;
    }
  }

  if (btnCarryoverApply) {
    btnCarryoverApply.textContent = "↳ Roll Over into Today";
  }

  carryoverBanner.style.display = 'flex';
  if (forcePrompt) {
    showToast(`Found records from ${sourceName} to roll over`);
  }
}

function applyPendingCarryover() {
  const sourceDate = currentPendingCarryoverSourceDate;
  if (!sourceDate) {
    openImportModal();
    return;
  }
  executeImport(sourceDate, {
    tasks: true,
    notes: true,
    titles: true
  });
}

function dismissCarryover() {
  const targetDateKey = formatDateKey(currentDate);
  safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
  if (carryoverBanner) {
    carryoverBanner.style.display = 'none';
  }
  currentPendingCarryover = [];
  currentPendingCarryoverSourceDate = null;
  showToast("Dismissed rollover for today");
}

function manualCheckCarryover() {
  openImportModal();
}

async function openImportModal(preferredDate = null) {
  if (!importModal) return;

  const targetDateKey = formatDateKey(currentDate);
  const [y, m, d] = targetDateKey.split('-').map(Number);
  const targetDateObj = new Date(y, m - 1, d);

  // Determine smart source candidate
  let initialDate = preferredDate;
  if (!initialDate) {
    const latestActive = await findLatestActiveDayBefore(targetDateKey);
    if (latestActive) {
      initialDate = latestActive.dateKey;
    } else {
      const yestObj = new Date(targetDateObj);
      yestObj.setDate(yestObj.getDate() - 1);
      initialDate = formatDateKey(yestObj);
    }
  }

  currentImportSourceDate = initialDate;

  // Set date picker constraints and value
  if (importSourceDateInput) {
    importSourceDateInput.value = initialDate;
    importSourceDateInput.max = targetDateKey;
  }

  // Populate smart quick chips
  if (importQuickChips) {
    importQuickChips.innerHTML = '';
    
    const chipDates = [];
    const allStored = await getAllStoredDates();
    const pastStored = allStored.filter(k => k < targetDateKey);

    const yestObj = new Date(targetDateObj);
    yestObj.setDate(yestObj.getDate() - 1);
    const yestKey = formatDateKey(yestObj);

    if (pastStored.length > 0) {
      const latestStored = pastStored[0];
      const isYest = (latestStored === yestKey);
      chipDates.push({
        key: latestStored,
        label: isYest ? `Yesterday (${latestStored})` : `Latest Active (${latestStored})`
      });
      if (!isYest) {
        chipDates.push({ key: yestKey, label: `Yesterday (${yestKey})` });
      }
    } else {
      chipDates.push({ key: yestKey, label: `Yesterday (${yestKey})` });
    }

    const twoDaysAgo = new Date(targetDateObj);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysKey = formatDateKey(twoDaysAgo);
    if (!chipDates.some(c => c.key === twoDaysKey)) {
      chipDates.push({ key: twoDaysKey, label: `2 Days Ago (${twoDaysKey})` });
    }

    const threeDaysAgo = new Date(targetDateObj);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threeDaysKey = formatDateKey(threeDaysAgo);
    if (!chipDates.some(c => c.key === threeDaysKey)) {
      chipDates.push({ key: threeDaysKey, label: `3 Days Ago (${threeDaysKey})` });
    }

    chipDates.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `import-chip-btn ${item.key === currentImportSourceDate ? 'active' : ''}`;
      btn.textContent = item.label;
      btn.setAttribute('data-date', item.key);
      btn.addEventListener('click', () => {
        selectImportSourceDate(item.key);
      });
      importQuickChips.appendChild(btn);
    });
  }

  // Render preview
  await updateImportPreview(currentImportSourceDate);

  // Show modal
  importModal.classList.add('open');
}

function selectImportSourceDate(dateKey) {
  if (!dateKey) return;
  currentImportSourceDate = dateKey;
  if (importSourceDateInput) importSourceDateInput.value = dateKey;

  if (importQuickChips) {
    importQuickChips.querySelectorAll('.import-chip-btn').forEach(btn => {
      if (btn.getAttribute('data-date') === dateKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  updateImportPreview(dateKey);
}

function closeImportModal() {
  if (importModal) importModal.classList.remove('open');
}

async function updateImportPreview(sourceDateKey) {
  if (!previewDateBadge || !previewContentSummary) return;

  const [y, m, d] = sourceDateKey.split('-').map(Number);
  const srcObj = new Date(y, m - 1, d);
  previewDateBadge.textContent = formatDateDisplay(srcObj);

  if (previewStatPill) {
    previewStatPill.textContent = "Scanning day...";
  }
  previewContentSummary.innerHTML = '<div class="preview-loading">Inspecting tasks & notes...</div>';

  const sourceData = await loadDay(sourceDateKey);
  const analysis = analyzeSourceDay(sourceData);

  const pendingTasks = analysis.unfinishedTasks.filter(item => {
    const curBlock = currentDayData[item.blockKey];
    if (!curBlock || !Array.isArray(curBlock.tasks)) return true;
    return !curBlock.tasks.some(t => t.text && t.text.trim().toLowerCase() === item.text.toLowerCase());
  });

  const notesList = Object.keys(analysis.blockNotes).map(k => {
    return analysis.blockTitles[k] || getDefaultTitle(k);
  });

  if (previewStatPill) {
    const statParts = [];
    statParts.push(`${pendingTasks.length} pending task${pendingTasks.length !== 1 ? 's' : ''}`);
    statParts.push(`${notesList.length} note block${notesList.length !== 1 ? 's' : ''}`);
    previewStatPill.textContent = statParts.join(' · ');
  }

  if (pendingTasks.length === 0 && notesList.length === 0) {
    previewContentSummary.innerHTML = `
      <div class="preview-empty">
        <p>No new tasks or notes found on <strong>${sourceDateKey}</strong>.</p>
        <span class="preview-sub-hint">Pick another date from the chips above or using the date picker.</span>
      </div>
    `;
    if (btnImportExecute) btnImportExecute.disabled = false;
    return;
  }

  let html = '';

  if (pendingTasks.length > 0) {
    html += `<div class="preview-group-header">Tasks to Roll Over (${pendingTasks.length}):</div>`;
    html += `<div class="preview-task-list">`;
    pendingTasks.forEach(item => {
      const subInfo = item.subtasks.length > 0 ? ` <span class="preview-sub-badge">${item.subtasks.length} subtask${item.subtasks.length > 1 ? 's' : ''}</span>` : '';
      const notesInfo = item.notes ? ` <span class="preview-task-notes-badge" title="Has task notes">📝</span>` : '';
      html += `
        <div class="preview-task-row">
          <span class="preview-block-tag">${escapeHtml(item.blockTitle)}</span>
          <span class="preview-task-text">${escapeHtml(item.text)}${subInfo}${notesInfo}</span>
        </div>
      `;
    });
    html += `</div>`;
  }

  if (analysis.completedTasksCount > 0) {
    html += `
      <div class="preview-archived-hint">
        ✓ ${analysis.completedTasksCount} completed task${analysis.completedTasksCount > 1 ? 's' : ''} on ${sourceDateKey} will remain safely recorded in past history.
      </div>
    `;
  }

  if (notesList.length > 0) {
    html += `<div class="preview-group-header">Notes & Routines Inherited (${notesList.length} blocks):</div>`;
    html += `<div class="preview-notes-pills">`;
    notesList.forEach(title => {
      html += `<span class="preview-note-pill">${escapeHtml(title)}</span>`;
    });
    html += `</div>`;
  }

  previewContentSummary.innerHTML = html;
  if (btnImportExecute) btnImportExecute.disabled = false;
}

async function executeImport(sourceDateKey, options = { tasks: true, notes: true, titles: true }) {
  if (!sourceDateKey) return;
  const sourceData = await loadDay(sourceDateKey);
  if (!sourceData) {
    showToast(`Could not load data for ${sourceDateKey}`);
    return;
  }

  let importedTasksCount = 0;
  let inheritedNotesCount = 0;
  let updatedTitlesCount = 0;

  for (const blockKey of ALL_BLOCK_KEYS) {
    if (!currentDayData[blockKey]) {
      currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
    }
    const currentBlock = currentDayData[blockKey];
    const sourceBlock = sourceData[blockKey];
    if (!sourceBlock) continue;

    // 1. Inherit Custom Block Titles
    if (options.titles && sourceBlock.title) {
      const defTitle = getDefaultTitle(blockKey);
      if (sourceBlock.title !== defTitle && currentBlock.title === defTitle) {
        currentBlock.title = sourceBlock.title;
        updatedTitlesCount++;
      }
    }

    // 2. Inherit Notes (Routines, Diet, Focus & Reference Notes)
    if (options.notes && sourceBlock.notes && sourceBlock.notes.trim().length > 0) {
      const srcNote = sourceBlock.notes.trim();
      const curNote = (currentBlock.notes || '').trim();
      if (!curNote) {
        currentBlock.notes = srcNote;
        inheritedNotesCount++;
      } else if (!curNote.includes(srcNote)) {
        currentBlock.notes = `${curNote}\n\n${srcNote}`;
        inheritedNotesCount++;
      }
    }

    // 3. Roll Over Unfinished Tasks & Subtasks
    if (options.tasks && Array.isArray(sourceBlock.tasks)) {
      if (!Array.isArray(currentBlock.tasks)) currentBlock.tasks = [];
      sourceBlock.tasks.forEach(srcTask => {
        if (!srcTask.done && srcTask.text && srcTask.text.trim().length > 0) {
          const taskText = srcTask.text.trim();
          const exists = currentBlock.tasks.some(
            t => t.text && t.text.trim().toLowerCase() === taskText.toLowerCase()
          );
          if (!exists) {
            currentBlock.tasks.push({
              text: taskText,
              done: false,
              notes: srcTask.notes || '',
              subtasks: Array.isArray(srcTask.subtasks) ? JSON.parse(JSON.stringify(srcTask.subtasks)) : []
            });
            importedTasksCount++;
          }
        }
      });
    }

    syncBlockContent(blockKey);
  }

  // Save changes
  isDirty = true;
  const targetDateKey = formatDateKey(currentDate);
  safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
  saveDay(targetDateKey, currentDayData);
  renderCurrentDay();

  // Hide banner if visible
  if (carryoverBanner) carryoverBanner.style.display = 'none';
  currentPendingCarryover = [];
  currentPendingCarryoverSourceDate = null;

  closeImportModal();

  // Feedback toast
  const parts = [];
  if (importedTasksCount > 0) parts.push(`${importedTasksCount} task${importedTasksCount > 1 ? 's' : ''}`);
  if (inheritedNotesCount > 0) parts.push(`${inheritedNotesCount} note block${inheritedNotesCount > 1 ? 's' : ''}`);
  if (parts.length === 0) {
    showToast(`Planner is already up to date with ${sourceDateKey}`);
  } else {
    showToast(`Rolled over ${parts.join(' & ')} from ${sourceDateKey}! 🎯`);
  }
}

// ==========================================================================
// Phase Isolation Controller (Anti-Task-Switching View)
// ==========================================================================

function setPhase(phase, notify = true) {
  currentPhase = phase;
  document.body.setAttribute('data-phase', phase);
  safeStorage.setItem('mrt_phase', phase);

  // Update Ribbon buttons
  const ribbonBtns = document.querySelectorAll('.phase-tab-btn');
  ribbonBtns.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-phase') === phase);
  });

  if (notify) {
    const phaseLabels = {
      all: 'All Phases: Full Day Overview (13 Tracks)',
      learning: 'Phase 4-9: Foundation & Learning (CS, AI, Apps, RSWE, Breadth)',
      productive: 'Phase 9-6: Productive & Admin (Deep Execution & Ops)',
      evening: 'Phase 6-11: Creative Evening (Huro, Kana, Bana, Curio, Survivo, Random)',
      health: 'Phase 5-6: Diet & Exercise (Workout, Meals, Supplements & Recovery)'
    };
    showToast(phaseLabels[phase] || phase);
  }
}

// ==========================================================================
// Lock-In Deep Work Focus Controller (Single-Task Attention Shield)
// ==========================================================================

let lockinActive = false;
let lockinBlockKey = null;
let lockinTaskIdx = null;
let currentLockinPresetMinutes = 25;
let lockinSeconds = 25 * 60;
let lockinTimerInterval = null;
let lockinTimerRunning = false;

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTimerDisplay() {
  if (lockinTimerDisplay) {
    lockinTimerDisplay.textContent = formatTimer(lockinSeconds);
  }
}

function startLockinTimer() {
  if (lockinTimerRunning) return;
  lockinTimerRunning = true;
  if (btnLockinTimerToggle) btnLockinTimerToggle.textContent = '⏸ Pause';
  clearInterval(lockinTimerInterval);
  lockinTimerInterval = setInterval(() => {
    if (lockinSeconds > 0) {
      lockinSeconds--;
      updateTimerDisplay();
    } else {
      pauseLockinTimer();
      showToast('⏱ Time Block Complete! Task progress saved.');
    }
  }, 1000);
}

function pauseLockinTimer() {
  lockinTimerRunning = false;
  if (btnLockinTimerToggle) btnLockinTimerToggle.textContent = '▶ Start';
  clearInterval(lockinTimerInterval);
}

function resetLockinTimer(defaultMinutes = 25) {
  pauseLockinTimer();
  currentLockinPresetMinutes = defaultMinutes;
  lockinSeconds = defaultMinutes * 60;
  updateTimerDisplay();
}

function setLockinTimeBlock(minutes) {
  currentLockinPresetMinutes = minutes;
  document.querySelectorAll('.timeblock-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mins, 10) === minutes);
  });
  resetLockinTimer(minutes);
  startLockinTimer();
  showToast(`⏱ Set ${minutes}-minute Time Block for this task`);
}

function getPhaseForBlock(blockKey) {
  if (['part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4', 'part2'].includes(blockKey)) {
    return 'Phase 4-9: Foundation & Learning';
  }
  if (['productive', 'admin'].includes(blockKey)) {
    return 'Phase 9-6: Productive & Admin';
  }
  if (blockKey.startsWith('health_')) {
    return 'Phase 5-6: Diet & Exercise';
  }
  return 'Phase 6-11: Creative Evening';
}

function renderLockinSubtasks(task, blockKey, taskIdx) {
  const container = document.getElementById('lockin-subtasks-container');
  const listEl = document.getElementById('lockin-subtasks-list');
  const titleEl = document.getElementById('lockin-subtasks-title');
  if (!container || !listEl) return;

  if (!task) {
    listEl.innerHTML = '<div style="font-size:11.5px;color:var(--text-dim);font-style:italic;padding:4px;">Type a task name above to add subtasks</div>';
    if (titleEl) titleEl.textContent = 'Subtasks & Milestones';
    return;
  }

  if (!Array.isArray(task.subtasks)) {
    task.subtasks = [];
  }
  const subtasks = task.subtasks;
  const subTotal = subtasks.length;
  const subDone = subtasks.filter(s => s.done).length;

  if (titleEl) {
    titleEl.textContent = subTotal > 0 ? `Subtasks & Milestones (${subDone}/${subTotal})` : 'Subtasks & Milestones';
  }

  listEl.innerHTML = '';

  if (subtasks.length === 0) {
    listEl.innerHTML = '<div style="font-size:11.5px;color:var(--text-dim);font-style:italic;padding:4px;">No subtasks yet. Click "+ Add Subtask" to break this task down.</div>';
    return;
  }

  subtasks.forEach((sub, sIdx) => {
    const item = document.createElement('div');
    item.className = 'lockin-subtask-item';
    item.innerHTML = `
      <button type="button" class="subtask-checkbox-btn ${sub.done ? 'checked' : ''}" title="${sub.done ? 'Mark active' : 'Mark done'}">
        <svg class="subtask-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
      <input type="text" class="${sub.done ? 'task-done' : ''}" value="${escapeHtml(sub.text)}" placeholder="Subtask milestone..." spellcheck="false" />
      <button type="button" class="subtask-row-del" title="Delete subtask" style="opacity:0.65;">×</button>
    `;

    const checkBtn = item.querySelector('.subtask-checkbox-btn');
    const input = item.querySelector('input');
    const delBtn = item.querySelector('.subtask-row-del');

    checkBtn.addEventListener('click', () => {
      sub.done = !sub.done;
      checkBtn.classList.toggle('checked', sub.done);
      input.classList.toggle('task-done', sub.done);
      syncBlockContent(blockKey);
      updateTotalProgress();
      renderLockinSubtasks(task, blockKey, taskIdx);
      triggerAutoSave();
    });

    input.addEventListener('input', () => {
      sub.text = input.value;
      syncBlockContent(blockKey);
      triggerAutoSave();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        subtasks.splice(sIdx + 1, 0, { text: '', done: false });
        syncBlockContent(blockKey);
        renderLockinSubtasks(task, blockKey, taskIdx);
        triggerAutoSave();
        setTimeout(() => {
          const nextInput = listEl.querySelectorAll('.lockin-subtask-item input')[sIdx + 1];
          if (nextInput) nextInput.focus();
        }, 20);
      } else if (e.key === 'Backspace' && input.value === '') {
        e.preventDefault();
        subtasks.splice(sIdx, 1);
        syncBlockContent(blockKey);
        renderLockinSubtasks(task, blockKey, taskIdx);
        updateTotalProgress();
        triggerAutoSave();
        setTimeout(() => {
          const prevInput = listEl.querySelectorAll('.lockin-subtask-item input')[Math.max(0, sIdx - 1)];
          if (prevInput) prevInput.focus();
        }, 20);
      }
    });

    delBtn.addEventListener('click', () => {
      subtasks.splice(sIdx, 1);
      syncBlockContent(blockKey);
      renderLockinSubtasks(task, blockKey, taskIdx);
      updateTotalProgress();
      triggerAutoSave();
    });

    listEl.appendChild(item);
  });
}

function openLockInFocus(blockKey, taskIdx = null) {
  if (!lockinModal) return;
  lockinActive = true;
  lockinBlockKey = blockKey;
  lockinTaskIdx = taskIdx;
  selectedBlockKey = blockKey;
  selectedTaskIdx = taskIdx;

  const block = currentDayData[blockKey] || getDefaultBlockData(getDefaultTitle(blockKey));
  const tasks = Array.isArray(block.tasks) ? block.tasks : [];
  let task = (taskIdx !== null && tasks[taskIdx]) ? tasks[taskIdx] : null;

  if (!task && tasks.length > 0) {
    const uncompletedIdx = tasks.findIndex(t => !t.done && t.text.trim().length > 0);
    if (uncompletedIdx !== -1) {
      lockinTaskIdx = uncompletedIdx;
      selectedTaskIdx = uncompletedIdx;
      task = tasks[uncompletedIdx];
    }
  }

  // Set Column & Phase Labels
  if (lockinPhaseLabel) lockinPhaseLabel.textContent = getPhaseForBlock(blockKey);
  if (lockinBlockLabel) lockinBlockLabel.textContent = block.title || getDefaultTitle(blockKey);

  // Set Task Number Badge
  const taskNumLabel = document.getElementById('lockin-task-num-label');
  if (taskNumLabel) {
    if (lockinTaskIdx !== null && tasks[lockinTaskIdx]) {
      taskNumLabel.textContent = `Task ${lockinTaskIdx + 1} of ${tasks.length}`;
      taskNumLabel.style.display = 'inline-block';
    } else {
      taskNumLabel.textContent = tasks.length > 0 ? `Task ${tasks.length + 1}` : `New Task`;
      taskNumLabel.style.display = 'inline-block';
    }
  }

  // Set Task Input
  if (lockinTaskInput) {
    lockinTaskInput.value = task ? task.text : '';
  }

  // Set Checkbox state
  if (btnLockinCheck) {
    btnLockinCheck.classList.toggle('completed', !!(task && task.done));
  }

  // Set Subtasks Breakdown for Deep Focus
  renderLockinSubtasks(task, blockKey, lockinTaskIdx);

  // Set Notes: Load notes specific to THIS task (never touch or overwrite column notes)
  if (lockinNotesArea) {
    lockinNotesArea.value = (task && typeof task.notes === 'string') ? task.notes : '';
  }

  // Update Time Block Presets
  document.querySelectorAll('.timeblock-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mins, 10) === currentLockinPresetMinutes);
  });

  // Reset & Start Time Block for this task
  resetLockinTimer(currentLockinPresetMinutes);
  startLockinTimer();

  lockinModal.style.display = 'flex';
  setTimeout(() => {
    if (lockinTaskInput) {
      if (!task || !task.text) lockinTaskInput.focus();
      else if (lockinNotesArea) lockinNotesArea.focus();
    }
  }, 40);
}

function closeLockInFocus() {
  if (!lockinModal) return;
  pauseLockinTimer();
  lockinActive = false;
  lockinModal.style.display = 'none';

  // Sync edits back to card
  if (lockinBlockKey) {
    syncBlockContent(lockinBlockKey);
    const card = document.querySelector(`.cool-card[data-block="${lockinBlockKey}"]`);
    if (card) {
      renderCardTasks(card, lockinBlockKey);
      renderCardNotes(card, lockinBlockKey);
      updateCardTabBadges(card, lockinBlockKey);
      if (lockinTaskIdx !== null) {
        setActiveTaskSelection(lockinBlockKey, lockinTaskIdx);
      } else {
        setActiveColumnSelection(lockinBlockKey);
      }
    }
    updateTotalProgress();
    saveDay(formatDateKey(currentDate), currentDayData);
  }
}

function completeLockInTask() {
  if (!lockinBlockKey) return;
  const block = currentDayData[lockinBlockKey];
  if (!block || !Array.isArray(block.tasks)) return;

  if (lockinTaskIdx !== null && block.tasks[lockinTaskIdx]) {
    const task = block.tasks[lockinTaskIdx];
    if (task.done) {
      task.done = false;
      if (btnLockinCheck) btnLockinCheck.classList.remove('completed');
      syncBlockContent(lockinBlockKey);
      updateTotalProgress();
      saveDay(formatDateKey(currentDate), currentDayData);
      showToast('Task marked active');
      return;
    }
    task.done = true;
  } else {
    const textVal = (lockinTaskInput ? lockinTaskInput.value : '').trim();
    if (textVal.length > 0) {
      block.tasks.push({
        text: textVal,
        done: true,
        notes: (lockinNotesArea ? lockinNotesArea.value : ''),
        subtasks: []
      });
      lockinTaskIdx = block.tasks.length - 1;
      selectedTaskIdx = lockinTaskIdx;
    }
  }

  if (btnLockinCheck) {
    btnLockinCheck.classList.add('completed');
  }

  syncBlockContent(lockinBlockKey);
  updateTotalProgress();
  saveDay(formatDateKey(currentDate), currentDayData);
  showToast('🎯 Task Crushed! Deep focus completed.');

  setTimeout(() => {
    const remainingIdx = block.tasks.findIndex(t => !t.done && t.text.trim().length > 0);
    if (remainingIdx !== -1) {
      lockinTaskIdx = remainingIdx;
      selectedTaskIdx = remainingIdx;
      if (lockinTaskInput) lockinTaskInput.value = block.tasks[remainingIdx].text;
      if (lockinNotesArea) lockinNotesArea.value = block.tasks[remainingIdx].notes || '';
      renderLockinSubtasks(block.tasks[remainingIdx], lockinBlockKey, remainingIdx);
      if (btnLockinCheck) btnLockinCheck.classList.remove('completed');
      const taskNumLabel = document.getElementById('lockin-task-num-label');
      if (taskNumLabel) {
        taskNumLabel.textContent = `Task ${remainingIdx + 1} of ${block.tasks.length}`;
      }
      resetLockinTimer(currentLockinPresetMinutes);
      startLockinTimer();
      showToast(`Next target loaded: "${block.tasks[remainingIdx].text}"`);
    } else {
      closeLockInFocus();
    }
  }, 350);
}

// Launch Task-Specific Lock-In based on User's Active Selection
function launchNextDeepWorkTask() {
  // 1. If user has actively selected a specific column and task:
  if (selectedBlockKey && selectedTaskIdx !== null) {
    const block = currentDayData[selectedBlockKey];
    if (block && Array.isArray(block.tasks) && block.tasks[selectedTaskIdx]) {
      openLockInFocus(selectedBlockKey, selectedTaskIdx);
      return;
    }
  }

  // 2. If user has selected a particular column:
  if (selectedBlockKey) {
    const block = currentDayData[selectedBlockKey];
    if (block && Array.isArray(block.tasks)) {
      const uncompletedIdx = block.tasks.findIndex(t => !t.done && t.text.trim().length > 0);
      if (uncompletedIdx !== -1) {
        openLockInFocus(selectedBlockKey, uncompletedIdx);
        return;
      }
    }
    openLockInFocus(selectedBlockKey, null);
    return;
  }

  // 3. Fallback to active phase blocks
  let candidateKeys = [];
  if (currentPhase === 'learning') {
    candidateKeys = ['part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4', 'part2'];
  } else if (currentPhase === 'productive') {
    candidateKeys = ['productive', 'admin'];
  } else if (currentPhase === 'evening') {
    candidateKeys = ['evening_huro', 'evening_kana', 'evening_bana', 'evening_curio', 'evening_survivi', 'evening_random'];
  } else if (currentPhase === 'health') {
    candidateKeys = ['health_workout', 'health_diet', 'health_habits', 'health_recovery'];
  } else {
    candidateKeys = ['part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4', 'part2', 'productive', 'admin'];
  }

  for (const k of candidateKeys) {
    const block = currentDayData[k];
    if (block && Array.isArray(block.tasks)) {
      const idx = block.tasks.findIndex(t => !t.done && t.text.trim().length > 0);
      if (idx !== -1) {
        openLockInFocus(k, idx);
        return;
      }
    }
  }

  const targetKey = candidateKeys[0] || 'part1_quad1';
  openLockInFocus(targetKey, null);
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

    md += `## 🏋️ 05:00 — 06:00 Diet & Exercise Phase (4 Tracks)\n\n`;
    md += `### ${currentDayData.health_workout?.title || 'Workout (5-6 AM)'}\n${currentDayData.health_workout?.content || ''}\n\n`;
    md += `### ${currentDayData.health_diet?.title || 'Diet & Meals'}\n${currentDayData.health_diet?.content || ''}\n\n`;
    md += `### ${currentDayData.health_habits?.title || 'Hydration & Supplements'}\n${currentDayData.health_habits?.content || ''}\n\n`;
    md += `### ${currentDayData.health_recovery?.title || 'Body & Recovery'}\n${currentDayData.health_recovery?.content || ''}\n\n`;

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

// Smart Task Carryover & Rollover Buttons
if (btnCarryoverApply) {
  btnCarryoverApply.addEventListener('click', applyPendingCarryover);
}
if (btnCarryoverChoose) {
  btnCarryoverChoose.addEventListener('click', () => {
    openImportModal(currentPendingCarryoverSourceDate);
  });
}
if (btnCarryoverDismiss) {
  btnCarryoverDismiss.addEventListener('click', dismissCarryover);
}
if (btnCarryoverCheck) {
  btnCarryoverCheck.addEventListener('click', manualCheckCarryover);
}

// Roll Over & Import Day Modal Event Bindings
if (btnImportPlanner) {
  btnImportPlanner.addEventListener('click', () => {
    openImportModal(currentPendingCarryoverSourceDate);
  });
}
if (btnCloseImportModal) {
  btnCloseImportModal.addEventListener('click', closeImportModal);
}
if (btnImportCancel) {
  btnImportCancel.addEventListener('click', closeImportModal);
}
if (importModal) {
  importModal.addEventListener('click', (e) => {
    if (e.target === importModal) closeImportModal();
  });
}
if (btnImportExecute) {
  btnImportExecute.addEventListener('click', () => {
    if (!currentImportSourceDate) return;
    executeImport(currentImportSourceDate, {
      tasks: chkImportTasks ? chkImportTasks.checked : true,
      notes: chkImportNotes ? chkImportNotes.checked : true,
      titles: chkImportTitles ? chkImportTitles.checked : true
    });
  });
}
if (importSourceDateInput) {
  importSourceDateInput.addEventListener('change', (e) => {
    if (e.target.value) {
      selectImportSourceDate(e.target.value);
    }
  });
  importSourceDateInput.addEventListener('input', (e) => {
    if (e.target.value && e.target.value.length === 10) {
      selectImportSourceDate(e.target.value);
    }
  });
}

// Phase Ribbon Interactive Buttons
const ribbonBtns = document.querySelectorAll('.phase-tab-btn');
ribbonBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const phase = btn.getAttribute('data-phase');
    if (phase) setPhase(phase);
  });
});

// Lock-In Deep Work Focus Controls
if (btnDeepWorkFocus) {
  btnDeepWorkFocus.addEventListener('click', launchNextDeepWorkTask);
}
if (btnLockinExit) {
  btnLockinExit.addEventListener('click', closeLockInFocus);
}
const lockinBackdrop = document.querySelector('.lockin-backdrop');
if (lockinBackdrop) {
  lockinBackdrop.addEventListener('click', closeLockInFocus);
}
if (btnLockinCheck) {
  btnLockinCheck.addEventListener('click', completeLockInTask);
}
if (btnLockinTimerToggle) {
  btnLockinTimerToggle.addEventListener('click', () => {
    if (lockinTimerRunning) pauseLockinTimer();
    else startLockinTimer();
  });
}
if (btnLockinTimerReset) {
  btnLockinTimerReset.addEventListener('click', () => resetLockinTimer(currentLockinPresetMinutes));
}

// Time Block Preset Buttons
document.querySelectorAll('.timeblock-preset-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const mins = parseInt(btn.dataset.mins, 10);
    if (!isNaN(mins)) {
      setLockinTimeBlock(mins);
    }
  });
});

// Add Subtask in Lock-In Focus
const btnLockinAddSubtask = document.getElementById('btn-lockin-add-subtask');
if (btnLockinAddSubtask) {
  btnLockinAddSubtask.addEventListener('click', () => {
    if (!lockinBlockKey) return;
    const block = currentDayData[lockinBlockKey];
    if (!block || !Array.isArray(block.tasks)) return;

    let task = (lockinTaskIdx !== null && block.tasks[lockinTaskIdx]) ? block.tasks[lockinTaskIdx] : null;
    if (!task) {
      const textVal = (lockinTaskInput ? lockinTaskInput.value : '').trim();
      if (!textVal) {
        if (lockinTaskInput) lockinTaskInput.focus();
        showToast('Type a task name first');
        return;
      }
      task = {
        text: textVal,
        done: false,
        notes: (lockinNotesArea ? lockinNotesArea.value : ''),
        subtasks: []
      };
      block.tasks.push(task);
      lockinTaskIdx = block.tasks.length - 1;
      selectedTaskIdx = lockinTaskIdx;
      const taskNumLabel = document.getElementById('lockin-task-num-label');
      if (taskNumLabel) taskNumLabel.textContent = `Task ${lockinTaskIdx + 1} of ${block.tasks.length}`;
    }

    if (!Array.isArray(task.subtasks)) task.subtasks = [];
    task.subtasks.push({ text: '', done: false });
    syncBlockContent(lockinBlockKey);
    renderLockinSubtasks(task, lockinBlockKey, lockinTaskIdx);
    triggerAutoSave();

    setTimeout(() => {
      const listEl = document.getElementById('lockin-subtasks-list');
      if (listEl) {
        const inputs = listEl.querySelectorAll('.lockin-subtask-item input');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }
    }, 25);
  });
}

// Live Sync for Lock-In Editors
if (lockinTaskInput) {
  lockinTaskInput.addEventListener('input', () => {
    if (!lockinBlockKey) return;
    const block = currentDayData[lockinBlockKey];
    if (!block) return;
    if (!Array.isArray(block.tasks)) block.tasks = [];
    if (lockinTaskIdx !== null && block.tasks[lockinTaskIdx]) {
      block.tasks[lockinTaskIdx].text = lockinTaskInput.value;
    } else if (lockinTaskInput.value.trim().length > 0) {
      block.tasks.push({
        text: lockinTaskInput.value,
        done: false,
        notes: (lockinNotesArea ? lockinNotesArea.value : ''),
        subtasks: []
      });
      lockinTaskIdx = block.tasks.length - 1;
      selectedTaskIdx = lockinTaskIdx;
      const taskNumLabel = document.getElementById('lockin-task-num-label');
      if (taskNumLabel) taskNumLabel.textContent = `Task ${lockinTaskIdx + 1} of ${block.tasks.length}`;
      renderLockinSubtasks(block.tasks[lockinTaskIdx], lockinBlockKey, lockinTaskIdx);
    }
    syncBlockContent(lockinBlockKey);
    triggerAutoSave();
  });

  lockinTaskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (lockinNotesArea) lockinNotesArea.focus();
    }
  });
}

if (lockinNotesArea) {
  lockinNotesArea.addEventListener('input', () => {
    if (!lockinBlockKey) return;
    if (!currentDayData[lockinBlockKey]) {
      currentDayData[lockinBlockKey] = getDefaultBlockData(getDefaultTitle(lockinBlockKey));
    }
    const block = currentDayData[lockinBlockKey];
    if (!Array.isArray(block.tasks)) block.tasks = [];

    // Save notes ONLY to the active task — NEVER to the column's block.notes!
    if (lockinTaskIdx !== null && block.tasks[lockinTaskIdx]) {
      block.tasks[lockinTaskIdx].notes = lockinNotesArea.value;
    } else if (lockinTaskInput && lockinTaskInput.value.trim().length > 0) {
      block.tasks.push({
        text: lockinTaskInput.value,
        done: false,
        notes: lockinNotesArea.value,
        subtasks: []
      });
      lockinTaskIdx = block.tasks.length - 1;
      selectedTaskIdx = lockinTaskIdx;
      const taskNumLabel = document.getElementById('lockin-task-num-label');
      if (taskNumLabel) taskNumLabel.textContent = `Task ${lockinTaskIdx + 1} of ${block.tasks.length}`;
      renderLockinSubtasks(block.tasks[lockinTaskIdx], lockinBlockKey, lockinTaskIdx);
    }

    syncBlockContent(lockinBlockKey);
    triggerAutoSave();
  });

  // Smart bullet list continuation and backspace exit for task notes
  lockinNotesArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = lockinNotesArea.value;
      const start = lockinNotesArea.selectionStart;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = val.indexOf('\n', start);
      const currentLine = val.substring(lineStart, lineEnd === -1 ? val.length : lineEnd);

      const bulletMatch = currentLine.match(/^(\s*)(•|-|\*)\s+/);
      if (bulletMatch) {
        const fullPrefix = bulletMatch[0];
        const indent = bulletMatch[1];
        const symbol = bulletMatch[2];
        const contentAfter = currentLine.substring(fullPrefix.length).trim();

        if (contentAfter.length === 0) {
          e.preventDefault();
          const before = val.substring(0, lineStart);
          const after = val.substring(start);
          lockinNotesArea.value = before + after;
          lockinNotesArea.setSelectionRange(lineStart, lineStart);
          lockinNotesArea.dispatchEvent(new Event('input'));
          return;
        }

        e.preventDefault();
        const nextBullet = '\n' + indent + symbol + ' ';
        const before = val.substring(0, start);
        const after = val.substring(start);
        lockinNotesArea.value = before + nextBullet + after;
        const newPos = start + nextBullet.length;
        lockinNotesArea.setSelectionRange(newPos, newPos);
        lockinNotesArea.dispatchEvent(new Event('input'));
      }
    }
  });
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  // 1. Shortcuts while inside Lock-In Focus Mode
  if (lockinActive) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLockInFocus();
      return;
    }
    // Ctrl+Enter or Cmd+Enter completes the current task
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      completeLockInTask();
      return;
    }
    // Space completes the task when not actively typing text or subtasks
    const isTyping = document.activeElement === lockinNotesArea || 
                     document.activeElement === lockinTaskInput || 
                     (document.activeElement && document.activeElement.closest('#lockin-subtasks-list'));
    if (e.key === ' ' && !isTyping) {
      e.preventDefault();
      completeLockInTask();
      return;
    }
    // Shield against background phase switching or day jumping while locked in
    if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        closeLockInFocus();
      }
      return;
    }
  }

  // 2. Ignore regular shortcuts if user is typing in any input/textarea
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    if (e.key === 'Escape') {
      document.activeElement.blur();
    }
    return;
  }

  // 3. Navigation and Phase Shortcuts
  if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (btnPrevDay) btnPrevDay.click();
  } else if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) {
    e.preventDefault();
    if (btnNextDay) btnNextDay.click();
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    if (btnToday) btnToday.click();
  } else if (e.key === '1') {
    e.preventDefault();
    setPhase('learning');
  } else if (e.key === '2') {
    e.preventDefault();
    setPhase('productive');
  } else if (e.key === '3') {
    e.preventDefault();
    setPhase('evening');
  } else if (e.key === '4') {
    e.preventDefault();
    setPhase('health');
  } else if (e.key === '0') {
    e.preventDefault();
    setPhase('all');
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    launchNextDeepWorkTask();
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    cycleTheme();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (importModal?.classList.contains('open')) {
      closeImportModal();
    } else {
      openImportModal();
    }
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    if (calendarModal?.classList.contains('open')) {
      calendarModal.classList.remove('open');
    } else {
      openCalendarModal();
    }
  } else if (e.key === 'Escape') {
    if (importModal?.classList.contains('open')) {
      closeImportModal();
      return;
    }
    if (calendarModal) calendarModal.classList.remove('open');
    if (lockinActive) closeLockInFocus();
  }
});

// Initialization (Instant Synchronous UI + Non-blocking Background Sync)
function init() {
  // 0. Pre-load cached active dates synchronously
  const cachedDates = safeStorage.getItem('mrt_active_dates');
  if (cachedDates) {
    try { activeDatesSet = new Set(JSON.parse(cachedDates)); } catch (e) {}
  }

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

  // Apply Phase Isolation
  setPhase(currentPhase, false);

  // Check pending carryover for today
  checkPendingCarryover(dateKey);

  // 4. Background non-blocking sync with native disk
  callTauri('get_day', { date: dateKey }).then(diskData => {
    if (formatDateKey(currentDate) === dateKey && diskData && typeof diskData === 'object') {
      currentDayData = normalizeDayData(diskData, dateKey);
      renderCurrentDay();
      checkPendingCarryover(dateKey);
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
      safeStorage.setItem('mrt_active_dates', JSON.stringify(activeDates));
      checkPendingCarryover(formatDateKey(currentDate));
    } else {
      const cached = safeStorage.getItem('mrt_active_dates');
      if (cached) {
        try { activeDatesSet = new Set(JSON.parse(cached)); } catch (e) {}
      }
    }
  });
}

// Start application immediately
init();
