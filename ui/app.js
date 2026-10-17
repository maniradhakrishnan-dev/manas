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
  },
  removeItem: (key) => {
    delete memoryCache[key];
    try {
      localStorage.removeItem(key);
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

let defaultWorkspaceHTML = '';
let currentEditingLayout = null;

const PRESETS = {
  default_polymath: {
    id: "default_polymath",
    name: "Polymath Golden Routine (Default)",
    description: "4-9 Foundation (4 quads) + 9-6 + 6-11 + Health",
    phases: [
      {
        id: "phase_learning",
        title: "Foundation & Learning",
        timeRange: "04:00 — 09:00",
        colorClass: "amber",
        tracks: [
          { key: "part1_quad1", title: "CS & SWE", placeholder: "Data structures, algorithms, system design..." },
          { key: "part1_quad2", title: "Core AI", placeholder: "Math, transformers, LLM architectures..." },
          { key: "part1_quad3", title: "Applications", placeholder: "Web apps, backends, products..." },
          { key: "part1_quad4", title: "RSWE", placeholder: "Reliability, observability, metrics..." },
          { key: "part2", title: "Breadth", placeholder: "Adjacent disciplines, cross-domain knowledge..." }
        ]
      },
      {
        id: "phase_productive",
        title: "Productive & Admin",
        timeRange: "09:00 — 18:00",
        colorClass: "violet",
        tracks: [
          { key: "productive", title: "Productive (Get Things Done)", placeholder: "High impact work, core deliverables..." },
          { key: "admin", title: "Admin & Operations", placeholder: "Logistics, operations, emails..." }
        ]
      },
      {
        id: "phase_evening",
        title: "Creative Evening",
        timeRange: "18:00 — 23:00",
        colorClass: "emerald",
        tracks: [
          { key: "evening_huro", title: "Huro", placeholder: "Huro development & creative..." },
          { key: "evening_kana", title: "Kana", placeholder: "Kana clothing & store..." },
          { key: "evening_bana", title: "Bana", placeholder: "Bana projects..." },
          { key: "evening_curio", title: "Curio", placeholder: "Curio research..." },
          { key: "evening_survivi", title: "Survivo", placeholder: "Survivo survival tools..." },
          { key: "evening_random", title: "Random", placeholder: "Spontaneous thoughts & tests..." }
        ]
      },
      {
        id: "phase_health",
        title: "Diet & Exercise",
        timeRange: "05:00 — 06:00",
        colorClass: "emerald",
        tracks: [
          { key: "health_workout", title: "Workout (5-6 AM)", placeholder: "Push/Pull/Legs, Cardio..." },
          { key: "health_diet", title: "Diet & Meals", placeholder: "Nutrition, macro targets, meal timing..." },
          { key: "health_habits", title: "Hydration & Supplements", placeholder: "Water, vitamins, minerals, creatine..." },
          { key: "health_recovery", title: "Body & Recovery", placeholder: "Mobility, stretching, sleep prep..." }
        ]
      }
    ]
  },

  freelancer_builder: {
    id: "freelancer_builder",
    name: "Freelancer & Builder",
    description: "Client Deliverables, Own Products, Growth, Invoicing & Reset",
    phases: [
      {
        id: "free_client",
        title: "Deep Client Deliverables",
        timeRange: "08:00 — 12:00",
        colorClass: "amber",
        tracks: [
          { key: "free_client_core", title: "Main Client Project", placeholder: "Core feature deliverables, pull requests..." },
          { key: "free_client_qa", title: "Secondary Client / QA", placeholder: "Fixes, staging deployments, client reviews..." }
        ]
      },
      {
        id: "free_product",
        title: "Own Products & Growth",
        timeRange: "13:00 — 17:00",
        colorClass: "violet",
        tracks: [
          { key: "free_saas_build", title: "Product Dev & Features", placeholder: "SaaS architecture, user onboarding, database..." },
          { key: "free_marketing", title: "Marketing & Lead Gen", placeholder: "Content, Twitter/X, outreach, demos..." }
        ]
      },
      {
        id: "free_ops",
        title: "Operations & Admin",
        timeRange: "17:00 — 20:00",
        colorClass: "cyan",
        tracks: [
          { key: "free_invoicing", title: "Invoicing & Client Comms", placeholder: "Slack, emails, proposals, bookkeeping..." },
          { key: "free_learning", title: "Skill Upgrades & Reading", placeholder: "New frameworks, books, tech exploration..." }
        ]
      },
      {
        id: "free_health",
        title: "Health & Wind Down",
        timeRange: "Evening / Morning",
        colorClass: "emerald",
        tracks: [
          { key: "free_workout", title: "Fitness & Movement", placeholder: "Gym, run, mobility..." },
          { key: "free_reflection", title: "Daily Review & Wins", placeholder: "Daily retro, tomorrow's 3 big wins..." }
        ]
      }
    ]
  },

  deep_work_research: {
    id: "deep_work_research",
    name: "Deep Work & Research",
    description: "Math, Theory, Implementation, Experiments & Technical Writing",
    phases: [
      {
        id: "res_theory",
        title: "Math & Deep Theory",
        timeRange: "06:00 — 11:00",
        colorClass: "amber",
        tracks: [
          { key: "res_math", title: "Mathematical Derivations", placeholder: "Proofs, linear algebra, probability, loss surfaces..." },
          { key: "res_papers", title: "ArXiv & Paper Deep Dives", placeholder: "Latest architectures, benchmarks, paper notes..." }
        ]
      },
      {
        id: "res_impl",
        title: "Implementation & Compute",
        timeRange: "12:00 — 17:00",
        colorClass: "violet",
        tracks: [
          { key: "res_experiments", title: "Model Training & Eval", placeholder: "PyTorch/JAX pipelines, training runs, metrics..." },
          { key: "res_infra", title: "Infrastructure & Compute", placeholder: "GPU clusters, CUDA kernels, data pipelines..." }
        ]
      },
      {
        id: "res_synthesis",
        title: "Writing & Physical Training",
        timeRange: "18:00 — 22:00",
        colorClass: "emerald",
        tracks: [
          { key: "res_writing", title: "Technical Writing & Docs", placeholder: "Blog posts, research writeups, documentation..." },
          { key: "res_fitness", title: "Physical Training & Sleep", placeholder: "Workout, sauna, sleep prep..." }
        ]
      }
    ]
  },

  simple_3_flow: {
    id: "simple_3_flow",
    name: "Simple 3-Phase Flow",
    description: "Morning High Priority, Afternoon Execution, Evening Wind-Down",
    phases: [
      {
        id: "flow_morning",
        title: "Morning Most Important Tasks",
        timeRange: "Morning Focus",
        colorClass: "amber",
        tracks: [
          { key: "flow_mit_1", title: "#1 Most Important Task", placeholder: "The one thing that makes today a win..." },
          { key: "flow_mit_2", title: "#2 High-Value Focus", placeholder: "Second major milestone..." }
        ]
      },
      {
        id: "flow_afternoon",
        title: "Afternoon Momentum",
        timeRange: "Afternoon Execution",
        colorClass: "violet",
        tracks: [
          { key: "flow_execution", title: "Tasks & Deliverables", placeholder: "Batching execution tasks..." },
          { key: "flow_admin", title: "Comms & Quick Tasks", placeholder: "Replies, coordination, errands..." }
        ]
      },
      {
        id: "flow_evening",
        title: "Evening Reset & Reflection",
        timeRange: "Evening Reset",
        colorClass: "emerald",
        tracks: [
          { key: "flow_personal", title: "Personal Projects & Reading", placeholder: "Unstructured creative time..." },
          { key: "flow_reflection", title: "Daily Review & Habits", placeholder: "Gratitude, workout check, tomorrow plan..." }
        ]
      }
    ]
  }
};

const ALL_BLOCK_KEYS = [
  'health_workout', 'health_diet', 'health_habits', 'health_recovery',
  'part1_quad1', 'part1_quad2', 'part1_quad3', 'part1_quad4',
  'part2', 'productive', 'admin',
  'evening_huro', 'evening_kana', 'evening_bana',
  'evening_curio', 'evening_survivi', 'evening_random'
];

function getActiveBlockKeys() {
  const keys = new Set(ALL_BLOCK_KEYS);
  document.querySelectorAll('.cool-card, .block-card').forEach(card => {
    const k = card.getAttribute('data-block');
    if (k) keys.add(k);
  });
  if (currentDayData && typeof currentDayData === 'object') {
    Object.keys(currentDayData).forEach(k => {
      if (k !== 'date' && k !== 'updatedAt' && k !== 'importedFrom' && k !== 'importedAt') {
        keys.add(k);
      }
    });
  }
  return Array.from(keys);
}

function getActiveLayout() {
  try {
    const saved = safeStorage.getItem('mrt_custom_layout');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.phases) && parsed.phases.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Could not load custom layout:", e);
  }
  return PRESETS.default_polymath;
}

function applyLayout(layout) {
  const workspaceEl = document.querySelector('.planner-workspace');
  if (!workspaceEl) return;

  if (!layout || layout.id === 'default_polymath') {
    safeStorage.removeItem('mrt_custom_layout');
    if (defaultWorkspaceHTML) {
      workspaceEl.innerHTML = defaultWorkspaceHTML;
    }
  } else {
    safeStorage.setItem('mrt_custom_layout', JSON.stringify(layout));
    renderCustomWorkspace(layout, workspaceEl);
  }

  // Re-bind events to all cards and populate current day
  bindCardEvents();
  renderCurrentDay();
}

function renderCustomWorkspace(layout, workspaceEl) {
  const bannerHTML = `
    <div id="carryover-banner" class="carryover-banner" style="display: none;">
      <div class="carryover-left">
        <div class="carryover-icon-box">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
        </div>
        <div class="carryover-info">
          <span class="carryover-title" id="carryover-title">Pending Tasks from Yesterday</span>
          <span class="carryover-subtitle" id="carryover-preview">Unfinished items ready to roll over</span>
        </div>
      </div>
      <div class="carryover-actions">
        <button id="btn-carryover-apply" class="carryover-btn btn-primary" title="Roll all pending tasks and inherit notes into today">↳ Roll Over into Today</button>
        <button id="btn-carryover-choose" class="carryover-btn btn-secondary" title="Pick another date to import from">Pick Date...</button>
        <button id="btn-carryover-dismiss" class="carryover-btn btn-ghost" title="Start blank today without importing past tasks">Start Blank (No Import)</button>
      </div>
    </div>
  `;

  const phases = layout.phases || [];
  const half = Math.ceil(phases.length / 2);
  const topPhases = phases.slice(0, half);
  const bottomPhases = phases.slice(half);

  function renderPhaseCol(p, pIdx) {
    const color = p.colorClass || 'amber';
    const tracks = p.tracks || [];
    return `
      <div class="planner-col phase-col-custom" style="flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px;">
        <div class="col-master-banner banner-${color}-master">
          <div class="master-banner-left">
            <span class="column-time-pill pill-${color}">${escapeHtml(p.timeRange || '')}</span>
            <span class="column-name">${escapeHtml(p.title)}</span>
          </div>
        </div>
        <div class="cards-grid-dynamic">
          ${tracks.map((t, tIdx) => `
            <div class="cool-card dynamic-col-card" data-block="${t.key || ('custom_' + p.id + '_' + tIdx)}">
              <div class="card-bar">
                <div class="card-bar-left">
                  <span class="track-indicator dot-${color}"></span>
                  <input type="text" class="card-title-input" value="${escapeHtml(t.title)}" placeholder="${escapeHtml(t.title)}" spellcheck="false" title="Click to rename this column" />
                </div>
                <div class="card-bar-right">
                  <span class="card-checklist-stat"></span>
                  <button class="btn-check-insert" title="Insert Checkbox">☐</button>
                  <button class="btn-bullet-insert" title="Insert Bullet">•</button>
                </div>
              </div>
              <div class="card-editor-area">
                <textarea class="card-text-editor" placeholder="${escapeHtml(t.placeholder || 'Tasks and notes...')}"></textarea>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  const topRowHTML = `
    <section class="planner-row row-top" id="planner-row-top" style="display: flex; gap: 20px; align-items: stretch;">
      ${topPhases.map((p, i) => renderPhaseCol(p, i)).join('')}
    </section>
  `;

  const dividerHTML = `
    <div class="phase-transition-fold phase-fold-divider" id="phase-fold-divider">
      <span class="neon-line"></span>
      <div class="phase-pill-glow">
        <span class="pill-sparkle">✦</span>
        <span>WORKSPACE FLOW</span>
        <span class="pill-sparkle">✦</span>
      </div>
      <span class="neon-line"></span>
    </div>
  `;

  const bottomRowHTML = bottomPhases.length > 0 ? `
    <section class="planner-row row-bottom phase-row-evening" id="phase-row-evening" style="display: flex; gap: 20px; align-items: stretch;">
      ${bottomPhases.map((p, i) => renderPhaseCol(p, half + i)).join('')}
    </section>
  ` : '';

  workspaceEl.innerHTML = bannerHTML + topRowHTML + dividerHTML + bottomRowHTML;

  // Re-bind carryover banner buttons
  const bApply = document.getElementById('btn-carryover-apply');
  if (bApply) bApply.addEventListener('click', applyPendingCarryover);
  const bChoose = document.getElementById('btn-carryover-choose');
  if (bChoose) bChoose.addEventListener('click', () => openImportModal(currentPendingCarryoverSourceDate));
  const bDismiss = document.getElementById('btn-carryover-dismiss');
  if (bDismiss) bDismiss.addEventListener('click', dismissCarryover);
}

function openCustomizeModal() {
  const modal = document.getElementById('customize-layout-modal');
  if (!modal) return;
  currentEditingLayout = JSON.parse(JSON.stringify(getActiveLayout()));
  renderPresetCards();
  renderPhaseCustomizer();
  modal.classList.add('open');
}

function closeCustomizeModal() {
  const modal = document.getElementById('customize-layout-modal');
  if (modal) modal.classList.remove('open');
}

function renderPresetCards() {
  const grid = document.getElementById('preset-cards-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const presetList = [
    { id: 'default_polymath', icon: '🌟', name: "Polymath Golden Routine", desc: "4-9 Foundation (4 quads) + 9-6 + 6-11 + Health" },
    { id: 'freelancer_builder', icon: '💼', name: "Freelancer & Builder", desc: "Client Deliverables, Own Products, Growth, Ops" },
    { id: 'deep_work_research', icon: '🔬', name: "Deep Work & Research", desc: "Math & Theory, Implementation, Writing & Gym" },
    { id: 'simple_3_flow', icon: '🎯', name: "Simple 3-Phase Flow", desc: "Morning #1 Focus, Afternoon Momentum, Evening Reset" }
  ];

  presetList.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-card-btn ${currentEditingLayout.id === p.id ? 'active' : ''}`;
    btn.innerHTML = `
      <div class="preset-card-title">
        <span>${p.icon}</span>
        <span>${escapeHtml(p.name)}</span>
      </div>
      <div class="preset-card-desc">${escapeHtml(p.desc)}</div>
    `;
    btn.addEventListener('click', () => {
      const selected = PRESETS[p.id];
      if (selected) {
        currentEditingLayout = JSON.parse(JSON.stringify(selected));
        renderPresetCards();
        renderPhaseCustomizer();
      }
    });
    grid.appendChild(btn);
  });
}

function renderPhaseCustomizer() {
  const container = document.getElementById('phase-customizer-container');
  if (!container) return;
  container.innerHTML = '';

  const phases = currentEditingLayout.phases || [];
  phases.forEach((phase, phaseIdx) => {
    const box = document.createElement('div');
    box.className = 'phase-customizer-box';

    // Header: phase title and time
    const header = document.createElement('div');
    header.className = 'phase-customizer-header';
    header.innerHTML = `
      <input type="text" class="phase-customizer-title-input" value="${escapeHtml(phase.title || '')}" placeholder="Phase Title (e.g. Morning Focus)" />
      <input type="text" class="phase-customizer-time-input" value="${escapeHtml(phase.timeRange || '')}" placeholder="Time (09:00 — 18:00)" />
    `;

    const titleInput = header.querySelector('.phase-customizer-title-input');
    titleInput.addEventListener('input', () => {
      phase.title = titleInput.value;
      currentEditingLayout.id = 'custom';
    });
    const timeInput = header.querySelector('.phase-customizer-time-input');
    timeInput.addEventListener('input', () => {
      phase.timeRange = timeInput.value;
      currentEditingLayout.id = 'custom';
    });
    box.appendChild(header);

    // Tracks list
    const trackList = document.createElement('div');
    trackList.className = 'track-edit-list';

    (phase.tracks || []).forEach((track, trackIdx) => {
      const row = document.createElement('div');
      row.className = 'track-edit-row';
      row.innerHTML = `
        <span class="track-indicator dot-${phase.colorClass || 'cyan'}"></span>
        <input type="text" class="track-edit-input" value="${escapeHtml(track.title || '')}" placeholder="Column Title" />
        <input type="text" class="track-edit-sub-input" value="${escapeHtml(track.placeholder || '')}" placeholder="Subtitle / details hint..." />
        ${(phase.tracks.length > 1) ? `<button type="button" class="track-edit-del-btn" title="Remove Column">✕</button>` : ''}
      `;

      const tInput = row.querySelector('.track-edit-input');
      tInput.addEventListener('input', () => {
        track.title = tInput.value;
        currentEditingLayout.id = 'custom';
      });
      const sInput = row.querySelector('.track-edit-sub-input');
      sInput.addEventListener('input', () => {
        track.placeholder = sInput.value;
        currentEditingLayout.id = 'custom';
      });

      const delBtn = row.querySelector('.track-edit-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          phase.tracks.splice(trackIdx, 1);
          currentEditingLayout.id = 'custom';
          renderPhaseCustomizer();
        });
      }

      trackList.appendChild(row);
    });
    box.appendChild(trackList);

    // Add track button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-add-track-col';
    addBtn.innerHTML = `<span>+</span> <span>Add Column to ${escapeHtml(phase.title || 'Phase')}</span>`;
    addBtn.addEventListener('click', () => {
      if (!Array.isArray(phase.tracks)) phase.tracks = [];
      const newKey = `custom_${phase.id || 'phase'}_${Date.now()}`;
      phase.tracks.push({
        key: newKey,
        title: `Column ${phase.tracks.length + 1}`,
        placeholder: "Tasks, research, notes..."
      });
      currentEditingLayout.id = 'custom';
      renderPhaseCustomizer();
    });
    box.appendChild(addBtn);

    container.appendChild(box);
  });
}

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
const btnQuickSync = document.getElementById('btn-quick-sync');
const btnImportPlanner = document.getElementById('btn-import-planner');
const importModal = document.getElementById('import-planner-modal');
const btnCloseImportModal = document.getElementById('btn-close-import-modal');
const btnImportCancel = document.getElementById('btn-import-cancel');
const btnImportExecute = document.getElementById('btn-import-execute');
const btnImportResetBlank = document.getElementById('btn-import-reset-blank');
const importQuickChips = document.getElementById('import-quick-chips');
const importSourceDateInput = document.getElementById('import-source-date-input');
const previewDateBadge = document.getElementById('preview-date-badge');
const previewStatPill = document.getElementById('preview-stat-pill');
const previewContentSummary = document.getElementById('preview-content-summary');
const chkImportTasks = document.getElementById('chk-import-tasks');
const chkImportNotes = document.getElementById('chk-import-notes');
const chkImportTitles = document.getElementById('chk-import-titles');

// Customize Layout Modal DOM Elements
const btnCustomizeLayout = document.getElementById('btn-customize-layout');
const customizeLayoutModal = document.getElementById('customize-layout-modal');
const btnCloseCustomizeModal = document.getElementById('btn-close-customize-modal');
const btnCancelCustomize = document.getElementById('btn-cancel-customize');
const btnSaveCustomLayout = document.getElementById('btn-save-custom-layout');
const btnResetDefaultLayout = document.getElementById('btn-reset-default-layout');

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
  if (titles[blockKey]) return titles[blockKey];

  // Check card title in active DOM
  const domInput = document.querySelector(`.cool-card[data-block="${blockKey}"] .card-title-input`);
  if (domInput && domInput.value && domInput.value.trim()) {
    return domInput.value.trim();
  }

  // Check active layout presets / phases
  try {
    const layout = getActiveLayout();
    if (layout && Array.isArray(layout.phases)) {
      for (const p of layout.phases) {
        for (const t of (p.tracks || [])) {
          if (t.key === blockKey && t.title) return t.title;
        }
      }
    }
  } catch (e) { }

  // Fallback to formatted key
  return blockKey.replace(/^custom_/, '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
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
  const data = {
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

  // Also initialize any custom tracks from active layout if present
  try {
    const layout = getActiveLayout();
    if (layout && Array.isArray(layout.phases)) {
      layout.phases.forEach(p => {
        (p.tracks || []).forEach(t => {
          if (t.key && !data[t.key]) {
            data[t.key] = getDefaultBlockData(t.title || getDefaultTitle(t.key));
          }
        });
      });
    }
  } catch (e) { }

  return data;
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
        : [],
      importedFrom: t.importedFrom || null,
      sourceTaskId: t.sourceTaskId || null
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

  const allKeys = new Set(ALL_BLOCK_KEYS);
  for (const k of Object.keys(raw)) {
    if (!['date', 'updatedAt', 'importedFrom', 'importedAt', 'evening', 'part1', 'health'].includes(k)) {
      allKeys.add(k);
    }
  }

  for (const k of allKeys) {
    normalized[k] = normalizeBlockData(raw[k], getDefaultTitle(k));
  }

  normalized.date = dateKey || raw.date || formatDateKey(new Date());
  normalized.updatedAt = raw.updatedAt || new Date().toISOString();
  if (raw.importedFrom) normalized.importedFrom = raw.importedFrom;
  if (raw.importedAt) normalized.importedAt = raw.importedAt;

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
  // If requesting current active day, flush dirty state and return currentDayData
  if (formatDateKey(currentDate) === dateKey && currentDayData && currentDayData.date === dateKey) {
    if (isDirty) {
      saveDay(dateKey, currentDayData);
    }
    return normalizeDayData(currentDayData, dateKey);
  }

  let localData = null;
  const localStr = safeStorage.getItem(`mrt_${dateKey}`);
  if (localStr) {
    try {
      localData = normalizeDayData(JSON.parse(localStr), dateKey);
    } catch (e) {
      console.warn("Parse error for local entry:", e);
    }
  }

  let diskData = null;
  const data = await callTauri('get_day', { date: dateKey });
  if (data && typeof data === 'object') {
    diskData = normalizeDayData(data, dateKey);
  }

  // Always prefer the freshest record between safeStorage and disk
  if (localData && diskData) {
    const localTime = new Date(localData.updatedAt || 0).getTime();
    const diskTime = new Date(diskData.updatedAt || 0).getTime();
    return (localTime >= diskTime) ? localData : diskData;
  }

  if (localData) return localData;
  if (diskData) return diskData;

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
  clearTimeout(autoSaveTimer);
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
    const lockinBtnLabel = hasNotes ? '⏱ Notes •' : '⏱';
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
      // When parent is toggled, cascade state to all subtasks
      if (Array.isArray(task.subtasks)) {
        task.subtasks.forEach(s => s.done = task.done);
      }
      row.classList.toggle('is-completed', task.done);
      checkBtn.classList.toggle('checked', task.done);
      if (input) input.classList.toggle('task-done', task.done);
      syncBlockContent(blockKey);
      updateCardTabBadges(card, blockKey);
      updateTotalProgress();
      renderCardTasks(card, blockKey);
      isDirty = true;
      saveDay(); // Immediately persist checkbox state
    });

    // 2. Edit Task Text (NEVER toggles checkbox)
    input.addEventListener('input', () => {
      task.text = input.value;
      syncBlockContent(blockKey);
      triggerAutoSave();
      // If user is actively typing new tasks on this day, dismiss carryover banner so it doesn't get in their way
      if (carryoverBanner && carryoverBanner.style.display !== 'none' && !safeStorage.getItem(`mrt_imported_${formatDateKey(currentDate)}`)) {
        carryoverBanner.style.display = 'none';
        safeStorage.setItem(`mrt_carryover_dismissed_${formatDateKey(currentDate)}`, 'true');
      }
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
          // If all non-empty subtasks are done, auto-mark parent task done; if any subtask unchecked, uncheck parent
          const nonBlankSubs = task.subtasks.filter(s => s.text && s.text.trim().length > 0);
          if (nonBlankSubs.length > 0 && nonBlankSubs.every(s => s.done)) {
            task.done = true;
          } else if (!sub.done && task.done) {
            task.done = false;
          }
          syncBlockContent(blockKey);
          updateCardTabBadges(card, blockKey);
          updateTotalProgress();
          renderCardTasks(card, blockKey);
          isDirty = true;
          saveDay(); // Immediately persist subtask state
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

  // Update Sync action button title in Header
  const targetDateKey = formatDateKey(currentDate);
  const activeSourceDate = currentDayData.importedFrom || safeStorage.getItem(`mrt_last_imported_source_${targetDateKey}`);
  const hasImport = !!(currentDayData.importedFrom || (activeSourceDate && safeStorage.getItem(`mrt_imported_${targetDateKey}`)));

  const syncBtn = document.getElementById('btn-quick-sync');
  const syncBtnLabel = document.getElementById('sync-btn-label');
  if (syncBtn) {
    syncBtn.title = hasImport && activeSourceDate
      ? `Sync with ${activeSourceDate} (Shortcut: S) — Updates unfinished tasks without altering today's custom tasks`
      : `Sync with previous day (Shortcut: S)`;
  }
  if (syncBtnLabel) {
    syncBtnLabel.textContent = 'Sync';
  }
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

  // If day has an active import link, sync unfinished tasks from source day
  if (currentDayData.importedFrom) {
    quickSync(currentDayData.importedFrom, true);
  }

  // Check carryover for target date
  checkPendingCarryover(targetDateKey);

  // 4. Background fetch from native filesystem if available
  callTauri('get_day', { date: targetDateKey }).then(diskData => {
    if (formatDateKey(currentDate) === targetDateKey && diskData && typeof diskData === 'object') {
      const diskTime = new Date(diskData.updatedAt || 0).getTime();
      const curTime = new Date(currentDayData.updatedAt || 0).getTime();
      if (diskTime > curTime) {
        currentDayData = normalizeDayData(diskData, targetDateKey);
        renderCurrentDay();
        if (currentDayData.importedFrom) {
          quickSync(currentDayData.importedFrom, true);
        }
        checkPendingCarryover(targetDateKey);
      }
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
  } catch (e) { }

  // 2. Fetch from safeStorage cached active dates
  try {
    const cachedDates = safeStorage.getItem('mrt_active_dates');
    if (cachedDates) {
      const parsed = JSON.parse(cachedDates);
      if (Array.isArray(parsed)) parsed.forEach(d => dates.add(d));
    }
  } catch (e) { }

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
  } catch (e) { }

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

function isTaskDone(task) {
  if (!task || typeof task !== 'object') return true;
  return Boolean(task.done);
}

function analyzeSourceDay(dayData) {
  if (!dayData || typeof dayData !== 'object') {
    return {
      unfinishedTasks: [],
      finishedTasks: [],
      completedTasksCount: 0,
      totalTasks: 0,
      notesCount: 0,
      blockNotes: {},
      blockTitles: {}
    };
  }

  const unfinishedTasks = [];
  const finishedTasks = [];
  let completedTasksCount = 0;
  let totalTasks = 0;
  let notesCount = 0;
  const blockNotes = {};
  const blockTitles = {};

  for (const k of getActiveBlockKeys()) {
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
          if (isTaskDone(task)) {
            completedTasksCount++;
            finishedTasks.push({
              blockKey: k,
              blockTitle: block.title || getDefaultTitle(k),
              text: task.text.trim()
            });
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
    finishedTasks,
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

  // 1. If user explicitly chose to start blank for this day, respect it completely and stay quiet
  if (!forcePrompt && safeStorage.getItem(`mrt_start_blank_${targetDateKey}`) === 'true') {
    carryoverBanner.style.display = 'none';
    currentPendingCarryover = [];
    currentPendingCarryoverSourceDate = null;
    return;
  }

  carryoverBanner.style.display = 'none';
  currentPendingCarryover = [];
  currentPendingCarryoverSourceDate = null;

  // Find the latest active day before targetDateKey (or check previous import source)
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

  // Check if any finished tasks from source day are lingering as active in today
  const tasksToClear = [];
  if (analysis.finishedTasks && Array.isArray(analysis.finishedTasks)) {
    analysis.finishedTasks.forEach(item => {
      const curBlock = currentDayData[item.blockKey];
      if (curBlock && Array.isArray(curBlock.tasks)) {
        if (curBlock.tasks.some(t => t.text && t.text.trim().toLowerCase() === item.text.toLowerCase() && !t.done)) {
          tasksToClear.push(item);
        }
      }
    });
  }

  // 2. If already dismissed for this day and there are no newly finished tasks to clear, stay hidden
  if (!forcePrompt && safeStorage.getItem(`mrt_carryover_dismissed_${targetDateKey}`) === 'true' && tasksToClear.length === 0) {
    carryoverBanner.style.display = 'none';
    currentPendingCarryover = [];
    currentPendingCarryoverSourceDate = null;
    return;
  }

  // Check if current day has any content
  const targetHasContent = hasContent(currentDayData);

  // If nothing to add, nothing to clear, and (target already has content or source has no notes), nothing to prompt
  if (pendingTasks.length === 0 && tasksToClear.length === 0 && (targetHasContent || analysis.notesCount === 0)) {
    if (forcePrompt) {
      showToast("All tasks are already in sync with previous days! 👍");
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
    if (tasksToClear.length > 0 && pendingTasks.length === 0) {
      carryoverTitle.textContent = `Sync Tasks from ${sourceName} (${tasksToClear.length} completed)`;
    } else if (pendingTasks.length > 0) {
      carryoverTitle.textContent = `${pendingTasks.length} Unfinished Task${pendingTasks.length > 1 ? 's' : ''} from ${sourceName}`;
    } else {
      carryoverTitle.textContent = `Inherit Notes & Setup from ${sourceName}`;
    }
  }

  if (carryoverPreview) {
    if (tasksToClear.length > 0 && pendingTasks.length === 0) {
      carryoverPreview.textContent = `⚡ ${tasksToClear.length} task${tasksToClear.length > 1 ? 's' : ''} marked completed on ${sourceName} will be cleared from today`;
    } else if (pendingTasks.length > 0) {
      const clearSuffix = tasksToClear.length > 0 ? ` · ${tasksToClear.length} completed to clear` : '';
      const previewSummary = `${pendingTasks[0].blockTitle}: "${pendingTasks[0].text}"${pendingTasks.length > 1 ? ` (+${pendingTasks.length - 1} more)` : ''}${analysis.notesCount > 0 ? ' · Notes included' : ''}${clearSuffix}`;
      carryoverPreview.textContent = previewSummary;
    } else {
      carryoverPreview.textContent = `${analysis.notesCount} block notes ready to inherit without re-typing`;
    }
  }

  if (btnCarryoverApply) {
    if (tasksToClear.length > 0 && pendingTasks.length === 0) {
      btnCarryoverApply.textContent = "↳ Sync Completed into Today";
    } else {
      btnCarryoverApply.textContent = "↳ Roll Over into Today";
    }
  }

  carryoverBanner.style.display = 'flex';
  if (forcePrompt) {
    showToast(`Found records from ${sourceName} to sync`);
  }
}

function applyPendingCarryover() {
  const sourceDate = currentPendingCarryoverSourceDate;
  if (!sourceDate) {
    quickSync();
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
  safeStorage.setItem(`mrt_start_blank_${targetDateKey}`, 'true');
  safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
  if (carryoverBanner) {
    carryoverBanner.style.display = 'none';
  }
  currentPendingCarryover = [];
  currentPendingCarryoverSourceDate = null;
  showToast("Blank day setup. No tasks will be auto-imported today. (Use Sync or Import Date anytime)");
}

// Revert last accidental import or wipe day to completely blank
function handleUndoOrResetBlank() {
  const targetDateKey = formatDateKey(currentDate);
  const backupStr = safeStorage.getItem(`mrt_pre_import_${targetDateKey}`);

  if (backupStr && backupStr !== 'null' && backupStr !== 'undefined') {
    try {
      const backupData = JSON.parse(backupStr);
      currentDayData = normalizeDayData(backupData, targetDateKey);
      safeStorage.removeItem(`mrt_pre_import_${targetDateKey}`);
      safeStorage.removeItem(`mrt_imported_${targetDateKey}`);
      safeStorage.removeItem(`mrt_last_imported_source_${targetDateKey}`);
      safeStorage.setItem(`mrt_start_blank_${targetDateKey}`, 'true');
      safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
      isDirty = true;
      saveDay(targetDateKey, currentDayData);
      renderCurrentDay();
      closeImportModal();
      if (carryoverBanner) carryoverBanner.style.display = 'none';
      showToast("Import undone! Reverted to state before import.", null, null, 3500);
      return;
    } catch (e) {
      console.error("Failed to restore backup snapshot:", e);
    }
  }

  // If no snapshot exists or user wants fresh blank start
  safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));
  currentDayData = getDefaultDayData(targetDateKey);
  safeStorage.removeItem(`mrt_imported_${targetDateKey}`);
  safeStorage.removeItem(`mrt_last_imported_source_${targetDateKey}`);
  safeStorage.setItem(`mrt_start_blank_${targetDateKey}`, 'true');
  safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
  isDirty = true;
  saveDay(targetDateKey, currentDayData);
  renderCurrentDay();
  closeImportModal();
  if (carryoverBanner) carryoverBanner.style.display = 'none';
  showToast("Day reset to blank. Auto-import disabled.", "Undo", handleUndoOrResetBlank, 6000);
}

// Remove all tasks that were imported from a linked date, preserving custom tasks
async function removeImport() {
  const targetDateKey = formatDateKey(currentDate);
  const sourceDateKey = currentDayData.importedFrom || safeStorage.getItem(`mrt_last_imported_source_${targetDateKey}`);

  // Take backup snapshot so user can undo
  safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));

  let removedCount = 0;
  let customKeptCount = 0;

  // Build task text set from source day to also catch any legacy untagged imports
  const sourceTaskSet = new Set();
  if (sourceDateKey) {
    try {
      const srcData = await loadDay(sourceDateKey);
      if (srcData) {
        for (const k of getActiveBlockKeys()) {
          if (srcData[k] && Array.isArray(srcData[k].tasks)) {
            srcData[k].tasks.forEach(t => {
              if (t && typeof t.text === 'string' && t.text.trim()) {
                sourceTaskSet.add(`${k}:::${t.text.trim().toLowerCase()}`);
              }
            });
          }
        }
      }
    } catch (e) {
      console.warn("Could not load source day for removeImport verification:", e);
    }
  }

  for (const blockKey of getActiveBlockKeys()) {
    const curBlock = currentDayData[blockKey];
    if (curBlock && Array.isArray(curBlock.tasks)) {
      const remaining = [];
      for (const t of curBlock.tasks) {
        if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
        const key = `${blockKey}:::${t.text.trim().toLowerCase()}`;
        const isImported = (t.importedFrom && (t.importedFrom === sourceDateKey || !sourceDateKey)) ||
          (sourceDateKey && sourceTaskSet.has(key));

        if (isImported) {
          removedCount++;
        } else {
          remaining.push(t);
          customKeptCount++;
        }
      }
      curBlock.tasks = remaining;
      syncBlockContent(blockKey);
    }
  }

  // Clear import link metadata
  delete currentDayData.importedFrom;
  delete currentDayData.importedAt;
  safeStorage.removeItem(`mrt_imported_${targetDateKey}`);
  safeStorage.removeItem(`mrt_last_imported_source_${targetDateKey}`);
  safeStorage.setItem(`mrt_start_blank_${targetDateKey}`, 'true');
  safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');

  isDirty = true;
  saveDay(targetDateKey, currentDayData);
  renderCurrentDay();

  if (carryoverBanner) carryoverBanner.style.display = 'none';
  closeImportModal();

  const sourceName = sourceDateKey || "previous day";
  if (removedCount > 0) {
    showToast(`Removed ${removedCount} imported task${removedCount > 1 ? 's' : ''} from ${sourceName}. (${customKeptCount} custom today tasks kept)`, "Undo", handleUndoOrResetBlank, 6000);
  } else {
    showToast(`Import link removed. Today is now an independent blank day.`, "Undo", handleUndoOrResetBlank, 6000);
  }
}

// 1-Click Smart Sync with Linked Date (or previous active day)
async function quickSync(preferredSourceDate = null, silent = false) {
  const targetDateKey = formatDateKey(currentDate);

  if (btnQuickSync) {
    btnQuickSync.classList.add('is-syncing');
  }

  try {
    // 1. Determine source date: check linked date on day, or last imported source, or yesterday
    let sourceDateKey = preferredSourceDate || currentDayData.importedFrom || safeStorage.getItem(`mrt_last_imported_source_${targetDateKey}`);

    if (!sourceDateKey) {
      const [y, m, d] = targetDateKey.split('-').map(Number);
      const targetDateObj = new Date(y, m - 1, d);
      const yestDateObj = new Date(targetDateObj);
      yestDateObj.setDate(yestDateObj.getDate() - 1);
      const yestKey = formatDateKey(yestDateObj);

      const yestData = await loadDay(yestKey);
      if (hasContent(yestData)) {
        sourceDateKey = yestKey;
      } else {
        const latestActive = await findLatestActiveDayBefore(targetDateKey);
        sourceDateKey = latestActive ? latestActive.dateKey : yestKey;
      }
    }

    if (!sourceDateKey || sourceDateKey >= targetDateKey) {
      if (!silent) showToast("No earlier records found to sync with.");
      return;
    }

    // 2. Fetch freshest source data
    const sourceData = await loadDay(sourceDateKey);
    if (!sourceData) {
      if (!silent) showToast(`Could not load data for ${sourceDateKey}`);
      return;
    }

    // Store pre-sync backup snapshot so accidental sync can be undone
    safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));

    // 3. Reconcile with current target day
    let clearedCount = 0;
    let addedCount = 0;
    let updatedCount = 0;
    let preservedCustomCount = 0;

    for (const blockKey of getActiveBlockKeys()) {
      if (!currentDayData[blockKey]) {
        currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
      }
      const curBlock = currentDayData[blockKey];
      const srcBlock = sourceData[blockKey];
      if (!Array.isArray(curBlock.tasks)) curBlock.tasks = [];

      if (!srcBlock || !Array.isArray(srcBlock.tasks)) {
        preservedCustomCount += curBlock.tasks.filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0).length;
        continue;
      }

      // Check tasks on source
      const srcFinished = srcBlock.tasks.filter(t => t && isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);
      const srcUnfinished = srcBlock.tasks.filter(t => t && !isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);

      // A. Finished tasks on source day: remove from today's pending tasks
      srcFinished.forEach(fTask => {
        const fText = fTask.text.trim().toLowerCase();
        const matchIdx = curBlock.tasks.findIndex(
          t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === fText && !t.done
        );
        if (matchIdx !== -1) {
          curBlock.tasks.splice(matchIdx, 1);
          clearedCount++;
        }
      });

      // B. Unfinished tasks on source day: import or sync subtasks & notes
      srcUnfinished.forEach(uTask => {
        const uText = uTask.text.trim();
        const existing = curBlock.tasks.find(
          t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === uText.toLowerCase()
        );

        if (!existing) {
          curBlock.tasks.push({
            text: uText,
            done: false,
            notes: uTask.notes || '',
            subtasks: Array.isArray(uTask.subtasks) ? JSON.parse(JSON.stringify(uTask.subtasks)) : [],
            importedFrom: sourceDateKey
          });
          addedCount++;
        } else {
          // If task exists on today, sync any changes to its notes or subtasks from source day!
          let modified = false;
          if (uTask.notes && existing.notes !== uTask.notes) {
            existing.notes = uTask.notes;
            modified = true;
          }
          if (Array.isArray(uTask.subtasks)) {
            const newSubsStr = JSON.stringify(uTask.subtasks);
            if (JSON.stringify(existing.subtasks || []) !== newSubsStr) {
              existing.subtasks = JSON.parse(newSubsStr);
              modified = true;
            }
          }
          if (!existing.importedFrom) {
            existing.importedFrom = sourceDateKey;
          }
          if (modified) updatedCount++;
        }
      });

      // C. Tasks deleted from source day: if a task was imported from sourceDateKey but is no longer on source, remove it
      curBlock.tasks = curBlock.tasks.filter(t => {
        if (t && t.importedFrom === sourceDateKey) {
          const inUnfinished = srcUnfinished.some(st => st.text.trim().toLowerCase() === t.text.trim().toLowerCase());
          const inFinished = srcFinished.some(st => st.text.trim().toLowerCase() === t.text.trim().toLowerCase());
          if (!inUnfinished && !inFinished) {
            clearedCount++;
            return false;
          }
        }
        return true;
      });

      // Count custom tasks created today (never existed in source block)
      curBlock.tasks.forEach(t => {
        if (!t || typeof t.text !== 'string' || !t.text.trim()) return;
        const existsInSrc = srcBlock.tasks.some(st => st && typeof st.text === 'string' && st.text.trim().toLowerCase() === t.text.trim().toLowerCase());
        if (!existsInSrc) {
          preservedCustomCount++;
        }
      });

      // Clean up empty tasks
      curBlock.tasks = curBlock.tasks.filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0);
      syncBlockContent(blockKey);
    }

    // Save and re-render
    isDirty = true;
    currentDayData.importedFrom = sourceDateKey;
    currentDayData.importedAt = new Date().toISOString();
    safeStorage.setItem(`mrt_last_imported_source_${targetDateKey}`, sourceDateKey);
    safeStorage.setItem(`mrt_imported_${targetDateKey}`, 'true');
    safeStorage.removeItem(`mrt_start_blank_${targetDateKey}`);
    saveDay(targetDateKey, currentDayData);
    renderCurrentDay();

    if (carryoverBanner) carryoverBanner.style.display = 'none';
    currentPendingCarryover = [];
    currentPendingCarryoverSourceDate = null;

    // Source date label
    const [ty, tm, td] = targetDateKey.split('-').map(Number);
    const targetDateObj = new Date(ty, tm - 1, td);
    const yestDateObj = new Date(targetDateObj);
    yestDateObj.setDate(yestDateObj.getDate() - 1);
    const isYesterday = (sourceDateKey === formatDateKey(yestDateObj));
    const label = isYesterday ? "Yesterday" : sourceDateKey;

    const parts = [];
    if (clearedCount > 0) parts.push(`cleared ${clearedCount} completed`);
    if (addedCount > 0) parts.push(`+${addedCount} new task${addedCount > 1 ? 's' : ''}`);
    if (updatedCount > 0) parts.push(`${updatedCount} updated`);
    if (preservedCustomCount > 0) parts.push(`${preservedCustomCount} custom today task${preservedCustomCount > 1 ? 's' : ''} kept`);

    if (clearedCount === 0 && addedCount === 0 && updatedCount === 0) {
      if (!silent) {
        if (preservedCustomCount > 0) {
          showToast(`In sync with ${label}. All ${preservedCustomCount} custom today tasks preserved. 👍`);
        } else {
          showToast(`Already fully in sync with ${label} 👍`);
        }
      }
    } else {
      showToast(`Synced with ${label}: ${parts.join(', ')} ⚡`, "Undo", handleUndoOrResetBlank, 6000);
    }

  } catch (err) {
    console.error("quickSync error:", err);
    if (!silent) showToast(`Sync error: ${err?.message || err}`);
  } finally {
    if (btnQuickSync) {
      setTimeout(() => btnQuickSync.classList.remove('is-syncing'), 450);
    }
  }
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

  // Update Active Import Banner and Undo / Reset Blank button label
  const activeNotice = document.getElementById('modal-active-import-notice');
  const activeDateSpan = document.getElementById('modal-active-import-date');
  const hasImport = currentDayData.importedFrom || safeStorage.getItem(`mrt_imported_${targetDateKey}`);
  const importSource = currentDayData.importedFrom || safeStorage.getItem(`mrt_last_imported_source_${targetDateKey}`);

  if (activeNotice && activeDateSpan) {
    if (hasImport && importSource) {
      activeNotice.style.display = 'flex';
      activeDateSpan.textContent = importSource;
    } else {
      activeNotice.style.display = 'none';
    }
  }

  if (btnImportResetBlank) {
    btnImportResetBlank.textContent = hasImport ? "✕ Remove Imported Tasks" : "↺ Start Blank Day";
    btnImportResetBlank.title = hasImport ? "Remove all imported tasks and keep custom today tasks" : "Clear all tasks to start clean";
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

  const unfinishedList = analysis.unfinishedTasks || [];

  const notesList = Object.keys(analysis.blockNotes).map(k => {
    return analysis.blockTitles[k] || getDefaultTitle(k);
  });

  if (previewStatPill) {
    const statParts = [];
    if (unfinishedList.length > 0) statParts.push(`${unfinishedList.length} unfinished task${unfinishedList.length !== 1 ? 's' : ''}`);
    if (notesList.length > 0) statParts.push(`${notesList.length} note block${notesList.length !== 1 ? 's' : ''}`);
    previewStatPill.textContent = statParts.join(' · ') || 'No unfinished items';
  }

  if (unfinishedList.length === 0 && notesList.length === 0) {
    previewContentSummary.innerHTML = `
      <div class="preview-empty">
        <p>No unfinished tasks or notes found on <strong>${sourceDateKey}</strong>.</p>
        <span class="preview-sub-hint">All tasks on ${sourceDateKey} are completed or empty.</span>
      </div>
    `;
    if (btnImportExecute) btnImportExecute.disabled = false;
    return;
  }

  let html = '';

  // Unfinished tasks only - NO finished tasks ever shown in import!
  if (unfinishedList.length > 0) {
    html += `<div class="preview-group-header">Tasks to Roll Over (${unfinishedList.length}):</div>`;
    html += `<div class="preview-task-list">`;
    unfinishedList.forEach(item => {
      const curBlock = currentDayData[item.blockKey];
      const isInToday = curBlock && Array.isArray(curBlock.tasks) && curBlock.tasks.some(
        t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === item.text.toLowerCase()
      );
      const subInfo = item.subtasks.length > 0 ? ` <span class="preview-sub-badge">${item.subtasks.length} subtask${item.subtasks.length > 1 ? 's' : ''}</span>` : '';
      const notesInfo = item.notes ? ` <span class="preview-task-notes-badge" title="Has task notes">📝</span>` : '';
      const syncBadge = isInToday ? ` <span class="preview-status-badge in-today" title="Already in today's planner">In Today</span>` : '';

      html += `
        <div class="preview-task-row">
          <span class="preview-block-tag">${escapeHtml(item.blockTitle)}</span>
          <span class="preview-task-text">${escapeHtml(item.text)}${subInfo}${notesInfo}</span>
          ${syncBadge}
        </div>
      `;
    });
    html += `</div>`;
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
  if (btnImportExecute) {
    btnImportExecute.disabled = false;
    btnImportExecute.textContent = "↳ Roll Over into Today";
  }
}

async function executeImport(sourceDateKey, options = { tasks: true, notes: true, titles: true }) {
  if (!sourceDateKey) return;
  try {
    const sourceData = await loadDay(sourceDateKey);
    if (!sourceData) {
      showToast(`Could not load data for ${sourceDateKey}`);
      return;
    }

    const targetDateKey = formatDateKey(currentDate);
    // Store backup snapshot before importing so user can redo/undo
    safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));

    let importedTasksCount = 0;
    let removedFinishedCount = 0;
    let updatedTasksCount = 0;
    let inheritedNotesCount = 0;
    let updatedTitlesCount = 0;
    let preservedCustomCount = 0;

    for (const blockKey of getActiveBlockKeys()) {
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
      if (options.notes && sourceBlock.notes && typeof sourceBlock.notes === 'string' && sourceBlock.notes.trim().length > 0) {
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

      // 3. Iterative Task Rollover & Synchronization
      if (options.tasks && Array.isArray(sourceBlock.tasks)) {
        if (!Array.isArray(currentBlock.tasks)) currentBlock.tasks = [];

        // A. Finished Tasks on Source Day:
        // If a task is COMPLETED on source day, ensure it does NOT linger as an active/uncompleted task in today!
        const finishedOnSource = sourceBlock.tasks.filter(t => t && isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);
        finishedOnSource.forEach(finishedTask => {
          const textKey = finishedTask.text.trim().toLowerCase();
          // Look for any uncompleted instance of this finished task in today's planner
          const matchIdx = currentBlock.tasks.findIndex(
            t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === textKey && !t.done
          );
          if (matchIdx !== -1) {
            currentBlock.tasks.splice(matchIdx, 1);
            removedFinishedCount++;
          }
        });

        // B. Unfinished Tasks on Source Day:
        const unfinishedOnSource = sourceBlock.tasks.filter(t => t && !isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);
        unfinishedOnSource.forEach(srcTask => {
          const taskText = srcTask.text.trim();
          const existingTask = currentBlock.tasks.find(
            t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === taskText.toLowerCase()
          );

          if (!existingTask) {
            // Brand new unfinished task: import it
            currentBlock.tasks.push({
              text: taskText,
              done: false,
              notes: srcTask.notes || '',
              subtasks: Array.isArray(srcTask.subtasks) ? JSON.parse(JSON.stringify(srcTask.subtasks)) : [],
              importedFrom: sourceDateKey
            });
            importedTasksCount++;
          } else if (!existingTask.done) {
            // Task is already in today and still pending: sync subtasks & notes if today's are empty
            let modified = false;
            if ((!existingTask.notes || existingTask.notes.trim().length === 0) && srcTask.notes) {
              existingTask.notes = srcTask.notes;
              modified = true;
            }
            if ((!Array.isArray(existingTask.subtasks) || existingTask.subtasks.length === 0) && Array.isArray(srcTask.subtasks) && srcTask.subtasks.length > 0) {
              existingTask.subtasks = JSON.parse(JSON.stringify(srcTask.subtasks));
              modified = true;
            }
            if (!existingTask.importedFrom) {
              existingTask.importedFrom = sourceDateKey;
            }
            if (modified) updatedTasksCount++;
          }
        });

        // Count custom tasks created today (never existed in source block)
        currentBlock.tasks.forEach(t => {
          if (!t || typeof t.text !== 'string' || !t.text.trim()) return;
          const existsInSrc = sourceBlock.tasks.some(st => st && typeof st.text === 'string' && st.text.trim().toLowerCase() === t.text.trim().toLowerCase());
          if (!existsInSrc) {
            preservedCustomCount++;
          }
        });

        // Clean up any empty stray tasks in today
        currentBlock.tasks = currentBlock.tasks.filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0);
      }

      syncBlockContent(blockKey);
    }

    // Save changes immediately
    isDirty = true;
    currentDayData.importedFrom = sourceDateKey;
    currentDayData.importedAt = new Date().toISOString();
    safeStorage.setItem(`mrt_last_imported_source_${targetDateKey}`, sourceDateKey);
    safeStorage.setItem(`mrt_imported_${targetDateKey}`, 'true');
    safeStorage.removeItem(`mrt_start_blank_${targetDateKey}`);
    safeStorage.setItem(`mrt_carryover_dismissed_${targetDateKey}`, 'true');
    saveDay(targetDateKey, currentDayData);
    renderCurrentDay();

    // Hide banner if visible
    if (carryoverBanner) carryoverBanner.style.display = 'none';
    currentPendingCarryover = [];
    currentPendingCarryoverSourceDate = null;

    closeImportModal();

    // Informative feedback toast
    const parts = [];
    if (importedTasksCount > 0) parts.push(`+${importedTasksCount} new task${importedTasksCount > 1 ? 's' : ''}`);
    if (removedFinishedCount > 0) parts.push(`cleared ${removedFinishedCount} completed`);
    if (preservedCustomCount > 0) parts.push(`${preservedCustomCount} custom today task${preservedCustomCount > 1 ? 's' : ''} kept`);
    if (inheritedNotesCount > 0) parts.push(`${inheritedNotesCount} note block${inheritedNotesCount > 1 ? 's' : ''}`);
    if (parts.length === 0) {
      showToast(`Planner is already in sync with ${sourceDateKey} 👍`);
    } else {
      showToast(`Synced with ${sourceDateKey}: ${parts.join(', ')} 🎯`, "Remove Import", removeImport, 6000);
    }
  } catch (err) {
    console.error("executeImport error:", err);
    showToast(`Import error: ${err?.message || err}`);
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
  if (blockKey.startsWith('evening_')) {
    return 'Phase 6-11: Creative Evening';
  }
  try {
    const layout = getActiveLayout();
    if (layout && Array.isArray(layout.phases)) {
      for (const p of layout.phases) {
        if ((p.tracks || []).some(t => t.key === blockKey)) {
          return `${p.title}${p.timeRange ? ' (' + p.timeRange + ')' : ''}`;
        }
      }
    }
  } catch (e) { }
  return 'Focused Work Track';
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
      if (Array.isArray(task.subtasks)) task.subtasks.forEach(s => s.done = false);
      if (btnLockinCheck) btnLockinCheck.classList.remove('completed');
      syncBlockContent(lockinBlockKey);
      updateTotalProgress();
      saveDay(formatDateKey(currentDate), currentDayData);
      showToast('Task marked active');
      return;
    }
    task.done = true;
    if (Array.isArray(task.subtasks)) task.subtasks.forEach(s => s.done = true);
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

    const activeLayout = getActiveLayout();
    if (activeLayout && activeLayout.id !== 'default_polymath' && Array.isArray(activeLayout.phases)) {
      activeLayout.phases.forEach(phase => {
        md += `## ${phase.title}${phase.timeRange ? ' (' + phase.timeRange + ')' : ''}\n\n`;
        (phase.tracks || []).forEach(track => {
          const b = currentDayData[track.key];
          md += `### ${b?.title || track.title}\n${b?.content || ''}\n\n`;
        });
      });
    } else {
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
    }

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

// Interactive Toast Helper (Supports text + optional 1-click action like Undo)
let toastTimer = null;
function showToast(msg, actionText = null, onAction = null, duration = 2400) {
  if (!toastEl) return;
  clearTimeout(toastTimer);
  toastEl.innerHTML = '';

  const textNode = document.createElement('span');
  textNode.className = 'toast-text';
  textNode.textContent = msg;
  toastEl.appendChild(textNode);

  if (actionText && typeof onAction === 'function') {
    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'toast-action-btn';
    actBtn.textContent = actionText;
    actBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toastEl.classList.remove('show');
      onAction();
    });
    toastEl.appendChild(actBtn);
  }

  toastEl.classList.add('show');
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
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

// Quick Sync Header Button
if (btnQuickSync) {
  btnQuickSync.addEventListener('click', () => {
    quickSync();
  });
}

// Remove Import Button inside Import Modal Notice
const btnModalQuickRemove = document.getElementById('btn-modal-quick-remove');
if (btnModalQuickRemove) {
  btnModalQuickRemove.addEventListener('click', () => {
    removeImport();
  });
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
if (btnImportResetBlank) {
  btnImportResetBlank.addEventListener('click', () => {
    const targetDateKey = formatDateKey(currentDate);
    const hasImport = currentDayData.importedFrom || safeStorage.getItem(`mrt_imported_${targetDateKey}`);
    if (hasImport) {
      removeImport();
    } else {
      handleUndoOrResetBlank();
    }
  });
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

// Customize Layout Modal Event Bindings
if (btnCustomizeLayout) {
  btnCustomizeLayout.addEventListener('click', openCustomizeModal);
}
if (btnCloseCustomizeModal) {
  btnCloseCustomizeModal.addEventListener('click', closeCustomizeModal);
}
if (btnCancelCustomize) {
  btnCancelCustomize.addEventListener('click', closeCustomizeModal);
}
if (btnResetDefaultLayout) {
  btnResetDefaultLayout.addEventListener('click', () => {
    applyLayout(PRESETS.default_polymath);
    closeCustomizeModal();
    showToast("Restored Polymath Golden Workflow");
  });
}
if (btnSaveCustomLayout) {
  btnSaveCustomLayout.addEventListener('click', () => {
    if (currentEditingLayout) {
      applyLayout(currentEditingLayout);
      closeCustomizeModal();
      showToast("Custom workflow applied & saved");
    }
  });
}
if (customizeLayoutModal) {
  customizeLayoutModal.addEventListener('click', (e) => {
    if (e.target === customizeLayoutModal) closeCustomizeModal();
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
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    quickSync();
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    if (calendarModal?.classList.contains('open')) {
      calendarModal.classList.remove('open');
    } else {
      openCalendarModal();
    }
  } else if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    if (customizeLayoutModal?.classList.contains('open')) {
      closeCustomizeModal();
    } else {
      openCustomizeModal();
    }
  } else if (e.key === 'Escape') {
    if (customizeLayoutModal?.classList.contains('open')) {
      closeCustomizeModal();
      return;
    }
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
  // Capture default workspace HTML on initial load before any custom mutation
  const workspaceEl = document.querySelector('.planner-workspace');
  if (workspaceEl && !defaultWorkspaceHTML) {
    defaultWorkspaceHTML = workspaceEl.innerHTML;
  }

  // Restore saved custom layout if one exists
  const savedLayoutStr = safeStorage.getItem('mrt_custom_layout');
  if (savedLayoutStr && workspaceEl) {
    try {
      const savedLayout = JSON.parse(savedLayoutStr);
      if (savedLayout && Array.isArray(savedLayout.phases) && savedLayout.phases.length > 0) {
        renderCustomWorkspace(savedLayout, workspaceEl);
      }
    } catch (e) {
      console.warn("Could not restore custom layout:", e);
    }
  }

  // 0. Pre-load cached active dates synchronously
  const cachedDates = safeStorage.getItem('mrt_active_dates');
  if (cachedDates) {
    try { activeDatesSet = new Set(JSON.parse(cachedDates)); } catch (e) { }
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
      const diskTime = new Date(diskData.updatedAt || 0).getTime();
      const curTime = new Date(currentDayData.updatedAt || 0).getTime();
      if (diskTime > curTime) {
        currentDayData = normalizeDayData(diskData, dateKey);
        renderCurrentDay();
        checkPendingCarryover(dateKey);
      }
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
        try { activeDatesSet = new Set(JSON.parse(cached)); } catch (e) { }
      }
    }
  });
}

// Start application immediately
init();
