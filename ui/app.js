// ==========================================================================
// MANAS — Daily Planner & Thinking Space
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
let activeStoragePath = '';
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
  blank_canvas: {
    id: "blank_canvas",
    name: "Blank Canvas",
    description: "100% clean slate. Build your own page rows, sections, and columns from scratch",
    pageRows: [],
    phases: []
  }
};

let inMemoryUserTemplates = null;

async function loadTemplatesFromDisk() {
  const diskTemplates = await callTauri('get_templates');
  if (Array.isArray(diskTemplates)) {
    inMemoryUserTemplates = diskTemplates;
    safeStorage.setItem('mrt_user_templates', JSON.stringify(diskTemplates));
    return diskTemplates;
  }
  return getUserTemplates();
}

function getUserTemplates() {
  if (Array.isArray(inMemoryUserTemplates)) {
    return inMemoryUserTemplates;
  }
  try {
    const raw = safeStorage.getItem('mrt_user_templates');
    if (raw) {
      inMemoryUserTemplates = JSON.parse(raw);
      return inMemoryUserTemplates;
    }
  } catch (e) { }
  inMemoryUserTemplates = [];
  return [];
}

function saveUserTemplate(name, layout, existingId = null) {
  if (!name || !name.trim()) return null;
  const templates = getUserTemplates();
  const pageRows = normalizeLayoutPageRows(layout);
  const cleanName = name.trim();

  // 1. If explicit existingId provided, update in-place
  if (existingId) {
    const idx = templates.findIndex(t => t.id === existingId);
    if (idx !== -1) {
      templates[idx].name = cleanName;
      templates[idx].description = `Custom layout with ${pageRows.length} page row(s)`;
      templates[idx].pageRows = JSON.parse(JSON.stringify(pageRows));
      templates[idx].phases = JSON.parse(JSON.stringify(layout.phases || []));
      inMemoryUserTemplates = templates;
      safeStorage.setItem('mrt_user_templates', JSON.stringify(templates));
      callTauri('save_templates', { templates });
      return templates[idx];
    }
  }

  // 2. If a template with the exact same name exists, update in-place
  const matchByName = templates.find(t => t.name.toLowerCase() === cleanName.toLowerCase());
  if (matchByName) {
    matchByName.description = `Custom layout with ${pageRows.length} page row(s)`;
    matchByName.pageRows = JSON.parse(JSON.stringify(pageRows));
    matchByName.phases = JSON.parse(JSON.stringify(layout.phases || []));
    inMemoryUserTemplates = templates;
    safeStorage.setItem('mrt_user_templates', JSON.stringify(templates));
    callTauri('save_templates', { templates });
    return matchByName;
  }

  // 3. Otherwise create new template
  const tplId = `template_${Date.now()}`;
  const newTpl = {
    id: tplId,
    name: cleanName,
    description: `Custom layout with ${pageRows.length} page row(s)`,
    pageRows: JSON.parse(JSON.stringify(pageRows)),
    phases: JSON.parse(JSON.stringify(layout.phases || []))
  };
  templates.push(newTpl);
  inMemoryUserTemplates = templates;
  safeStorage.setItem('mrt_user_templates', JSON.stringify(templates));
  callTauri('save_templates', { templates });
  return newTpl;
}

function deleteUserTemplate(tplId) {
  let templates = getUserTemplates();
  templates = templates.filter(t => t.id !== tplId);
  inMemoryUserTemplates = templates;
  safeStorage.setItem('mrt_user_templates', JSON.stringify(templates));
  callTauri('save_templates', { templates });
}

function markLayoutModified(activeLayout) {
  if (!activeLayout) return;
  const baseId = activeLayout.baseTemplateId || (activeLayout.id !== 'blank_canvas' && activeLayout.id !== 'custom' ? activeLayout.id : null);
  if (baseId) {
    activeLayout.baseTemplateId = baseId;
    const allTpls = getUserTemplates();
    const t = allTpls.find(item => item.id === baseId);
    if (t) activeLayout.baseTemplateName = t.name;
  }
  activeLayout.isModified = true;
  activeLayout.id = 'custom';
}

function renderLevel1TopBarHTML(activeLayout) {
  const currentId = activeLayout ? activeLayout.id : 'blank_canvas';
  const userTemplates = getUserTemplates();
  const baseId = activeLayout ? (activeLayout.baseTemplateId || (userTemplates.some(t => t.id === currentId) ? currentId : null)) : null;
  const matchedUserTpl = userTemplates.find(t => t.id === baseId);
  const isModified = activeLayout ? (activeLayout.isModified && !!matchedUserTpl) : false;

  const standardOptions = [
    { id: 'blank_canvas', label: "📄 Blank Canvas" }
  ];

  let optionsHTML = standardOptions.map(o => `
    <option value="${o.id}" ${currentId === o.id ? 'selected' : ''}>${escapeHtml(o.label)}</option>
  `).join('');

  if (userTemplates.length > 0) {
    optionsHTML += `
      <optgroup label="My Custom Templates">
        ${userTemplates.map(t => {
          const isSelected = (baseId === t.id);
          const label = (isSelected && isModified) ? `📌 ${t.name} (Modified)` : `📌 ${t.name}`;
          return `<option value="${t.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}
      </optgroup>
    `;
  }

  if (!matchedUserTpl && currentId === 'custom') {
    optionsHTML += `<option value="custom" selected>✦ Custom (${escapeHtml(formatDateDisplay(currentDate))})</option>`;
  }

  let actionButtonsHTML = '';
  if (matchedUserTpl) {
    if (isModified) {
      actionButtonsHTML = `
        <button type="button" class="btn-level1-pill btn-update-template" id="btn-top-update-template" title="Update the saved template '${escapeHtml(matchedUserTpl.name)}' with your current layout changes">🔄 Update "${escapeHtml(matchedUserTpl.name)}"</button>
        <button type="button" class="btn-level1-pill btn-save-new-template" id="btn-top-save-new-template" title="Save these changes as a brand new template">💾 Save as New...</button>
      `;
    } else {
      actionButtonsHTML = `
        <button type="button" class="btn-level1-pill btn-save-new-template" id="btn-top-save-new-template" title="Save a copy of this template with a new name">💾 Duplicate...</button>
        <button type="button" class="btn-level1-pill btn-del-template" id="btn-top-del-template" data-tpl-id="${matchedUserTpl.id}" title="Delete template '${escapeHtml(matchedUserTpl.name)}'">🗑️ Delete</button>
      `;
    }
  } else {
    actionButtonsHTML = `
      <button type="button" class="btn-level1-pill btn-save-template" id="btn-top-save-template" title="Save today's layout as a reusable template">💾 Save Template</button>
    `;
  }

  return `
    <div class="workspace-level1-bar" id="workspace-level1-bar">
      <div class="level1-brand-group">
        <span class="level1-badge">LEVEL 1</span>
        <span class="level1-title">Page Layout:</span>
      </div>
      <div class="level1-actions">
        <button type="button" class="btn-level1-action btn-add-page-row" id="btn-top-add-page-row" title="Add a new horizontal page row to organize sections">
          <span class="btn-level1-icon">＋</span> + Add Page Row
        </button>
      </div>
      <div class="level1-divider"></div>
      <div class="level1-template-group">
        <span class="level1-template-label">Routine:</span>
        <select id="level1-template-select" class="level1-template-select" title="Switch layout template for today">
          ${optionsHTML}
        </select>
        ${actionButtonsHTML}
      </div>
    </div>
  `;
}

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
      if (k !== 'date' && k !== 'updatedAt' && k !== 'importedFrom' && k !== 'importedAt' && k !== 'customLayout') {
        keys.add(k);
      }
    });
    if (currentDayData.customLayout) {
      try {
        const tracks = getAllLayoutTracks(currentDayData.customLayout);
        tracks.forEach(t => { if (t && t.key) keys.add(t.key); });
      } catch (e) { }
    }
  }
  return Array.from(keys);
}

function getAllBlockKeysBetween(dayA, dayB) {
  const keys = new Set(ALL_BLOCK_KEYS);
  [dayA, dayB].forEach(d => {
    if (d && typeof d === 'object') {
      Object.keys(d).forEach(k => {
        if (!['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(k)) {
          keys.add(k);
        }
      });
      if (d.customLayout) {
        try {
          const tracks = getAllLayoutTracks(d.customLayout);
          tracks.forEach(t => { if (t && t.key) keys.add(t.key); });
        } catch (e) { }
      }
    }
  });
  document.querySelectorAll('.cool-card, .block-card').forEach(card => {
    const k = card.getAttribute('data-block');
    if (k) keys.add(k);
  });
  return Array.from(keys);
}

function normBlockTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isGenericBlockTitle(title) {
  if (!title || typeof title !== 'string') return true;
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (t === 'new column' || t === 'column' || /^column\s*\d+$/i.test(t) || /^row\s*\d+$/i.test(t) || t === 'section' || /^section\s*\d+$/i.test(t)) {
    return true;
  }
  return false;
}

function hasBlockContent(block) {
  if (!block || typeof block !== 'object') return false;
  if (Array.isArray(block.tasks) && block.tasks.some(t => t && typeof t.text === 'string' && t.text.trim().length > 0)) return true;
  if (block.notes && typeof block.notes === 'string' && block.notes.trim().length > 0) return true;
  if (block.content && typeof block.content === 'string' && block.content.trim().length > 0) return true;
  return false;
}

function findMatchingSourceBlock(sourceData, targetKey, curBlock) {
  if (!sourceData || typeof sourceData !== 'object') return null;

  // 1. Direct key match with content
  if (sourceData[targetKey] && hasBlockContent(sourceData[targetKey])) {
    return { key: targetKey, block: sourceData[targetKey] };
  }

  // 2. Title-based match if target block has a meaningful non-generic title
  const curTitle = (curBlock && curBlock.title) ? curBlock.title : getDefaultTitle(targetKey);
  const targetNorm = normBlockTitle(curTitle);

  if (targetNorm && !isGenericBlockTitle(curTitle)) {
    for (const [sKey, sVal] of Object.entries(sourceData)) {
      if (!sVal || typeof sVal !== 'object' || ['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(sKey)) continue;
      const sTitle = sVal.title || getDefaultTitle(sKey);
      const sNorm = normBlockTitle(sTitle);
      if (!sNorm || isGenericBlockTitle(sTitle)) continue;

      if (targetNorm === sNorm || (targetNorm.length >= 4 && sNorm.length >= 4 && (targetNorm.includes(sNorm) || sNorm.includes(targetNorm)))) {
        if (hasBlockContent(sVal)) {
          return { key: sKey, block: sVal };
        }
      }
    }
  }

  // 3. Exact key match fallback
  if (sourceData[targetKey]) {
    return { key: targetKey, block: sourceData[targetKey] };
  }

  return null;
}

// Layout helper functions: scoped per-date
function getLayoutForDate(dateKey, dayData) {
  if (dayData && dayData.customLayout) {
    if (Array.isArray(dayData.customLayout.pageRows) || Array.isArray(dayData.customLayout.phases)) {
      return dayData.customLayout;
    }
  }
  const cached = safeStorage.getItem(`mrt_layout_${dateKey}`);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && (Array.isArray(parsed.pageRows) || Array.isArray(parsed.phases))) {
        return parsed;
      }
    } catch (e) { }
  }
  const userDef = safeStorage.getItem('mrt_user_default_template');
  if (userDef) {
    try {
      const parsed = JSON.parse(userDef);
      if (parsed && (Array.isArray(parsed.pageRows) || Array.isArray(parsed.phases))) {
        return parsed;
      }
    } catch (e) { }
  }
  return PRESETS.blank_canvas || { id: 'blank_canvas', name: 'Blank Canvas', pageRows: [] };
}

function getActiveLayout() {
  const dateKey = formatDateKey(currentDate);
  return getLayoutForDate(dateKey, currentDayData);
}

// Normalize any layout into a clean list of page rows (Layer 1 -> Layer 2 -> Layer 3)
function normalizeLayoutPageRows(layout) {
  if (!layout) return [];
  if (Array.isArray(layout.pageRows)) {
    layout.pageRows.forEach(pr => {
      (pr.sections || []).forEach(sec => {
        if (sec.timeRange === 'Custom Hours') sec.timeRange = '';
      });
    });
    return layout.pageRows;
  }
  // Backwards compatibility with legacy layout.phases:
  if (Array.isArray(layout.phases)) {
    const pageRows = [];
    let currentVertSections = [];

    layout.phases.forEach((p, idx) => {
      const isHoriz = (p.orientation === 'horizontal');
      const sec = {
        id: p.id || `sec_${idx}`,
        title: p.title || `Section ${idx + 1}`,
        timeRange: p.timeRange || '',
        colorClass: p.colorClass || 'cyan',
        rows: getSectionSubRows(p)
      };

      if (isHoriz) {
        if (currentVertSections.length > 0) {
          pageRows.push({
            id: `prow_${pageRows.length + 1}`,
            title: `PAGE ROW ${pageRows.length + 1}`,
            sections: currentVertSections
          });
          currentVertSections = [];
        }
        pageRows.push({
          id: `prow_${pageRows.length + 1}`,
          title: p.title ? p.title.toUpperCase() : `PAGE ROW ${pageRows.length + 1}`,
          sections: [sec]
        });
      } else {
        currentVertSections.push(sec);
      }
    });

    if (currentVertSections.length > 0) {
      pageRows.push({
        id: `prow_${pageRows.length + 1}`,
        title: `PAGE ROW ${pageRows.length + 1}`,
        sections: currentVertSections
      });
    }

    return pageRows;
  }

  return [];
}

// Normalize sub-rows (tiers) inside a section
function getSectionSubRows(section) {
  if (!section) return [];
  if (Array.isArray(section.rows) && section.rows.length > 0) {
    return section.rows;
  }
  if (Array.isArray(section.tracks)) {
    return [
      {
        id: `row_${section.id || 'sec'}_1`,
        title: "",
        tracks: section.tracks
      }
    ];
  }
  return [];
}

// Legacy alias for getSectionSubRows to avoid breaking any callers
function getPhaseRows(phase) {
  return getSectionSubRows(phase);
}

// Get all column cards/tracks across any layout structure
function getAllLayoutTracks(layout) {
  const tracks = [];
  if (!layout) return tracks;
  const pageRows = normalizeLayoutPageRows(layout);
  if (pageRows.length > 0) {
    pageRows.forEach(row => {
      (row.sections || []).forEach(sec => {
        const subRows = getSectionSubRows(sec);
        subRows.forEach(sub => {
          (sub.tracks || []).forEach(t => {
            if (t && t.key) tracks.push(t);
          });
        });
      });
    });
    return tracks;
  }
  if (Array.isArray(layout.phases)) {
    layout.phases.forEach(p => {
      const subRows = getSectionSubRows(p);
      subRows.forEach(sub => {
        (sub.tracks || []).forEach(t => {
          if (t && t.key) tracks.push(t);
        });
      });
    });
  }
  return tracks;
}

function getAllLayoutSections(layout) {
  const sections = [];
  if (!layout) return sections;
  const pageRows = normalizeLayoutPageRows(layout);
  if (pageRows.length > 0) {
    pageRows.forEach(row => {
      (row.sections || []).forEach(sec => {
        if (sec && sec.id) sections.push(sec);
      });
    });
    return sections;
  }
  if (Array.isArray(layout.phases)) {
    layout.phases.forEach(p => {
      if (p && p.id) sections.push(p);
    });
  }
  return sections;
}

let currentSectionFocus = safeStorage.getItem('mrt_section_focus') || 'all';

function renderPhaseRibbon(layout) {
  const ribbon = document.getElementById('phase-ribbon');
  if (!ribbon) return;

  const sections = getAllLayoutSections(layout);
  if (sections.length === 0) {
    ribbon.innerHTML = `
      <button type="button" class="phase-tab-btn active" data-section-id="all">
        <span class="phase-pill-key">0</span>
        <span class="phase-title">All Sections</span>
      </button>
    `;
    return;
  }

  const isAllActive = !currentSectionFocus || currentSectionFocus === 'all';

  let html = `
    <button type="button" class="phase-tab-btn ${isAllActive ? 'active' : ''}" data-section-id="all" title="View all sections (Key: 0)">
      <span class="phase-pill-key">0</span>
      <span class="phase-title">All Sections</span>
      <span class="phase-count-badge">(${sections.length})</span>
    </button>
  `;

  sections.forEach((sec, idx) => {
    const keyNumber = idx + 1;
    const keyShortcut = keyNumber <= 9 ? `${keyNumber}` : '';
    const color = sec.colorClass || 'cyan';
    const isAct = currentSectionFocus === sec.id;
    const timeDisplay = (sec.timeRange && sec.timeRange.trim() && sec.timeRange !== 'Custom Hours')
      ? `<span class="phase-time pill-${color}">${escapeHtml(sec.timeRange)}</span>`
      : '';

    html += `
      <button type="button" class="phase-tab-btn ${isAct ? 'active' : ''}" data-section-id="${sec.id}" data-color="${color}" title="${escapeHtml(sec.title || ('Section ' + (idx + 1)))}${keyShortcut ? ` (Key: ${keyShortcut})` : ''}">
        ${keyShortcut ? `<span class="phase-pill-key">${keyShortcut}</span>` : ''}
        <span class="track-indicator dot-${color}"></span>
        <span class="phase-title" data-ribbon-sec-id="${sec.id}">${escapeHtml(sec.title || ('Section ' + (idx + 1)))}</span>
        ${timeDisplay}
      </button>
    `;
  });

  ribbon.innerHTML = html;
}

function setSectionFocus(secId, notify = true) {
  currentSectionFocus = secId;
  safeStorage.setItem('mrt_section_focus', secId);

  // Update Ribbon buttons active state
  const ribbonBtns = document.querySelectorAll('#phase-ribbon .phase-tab-btn');
  ribbonBtns.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-section-id') === secId);
  });

  if (!secId || secId === 'all') {
    document.body.removeAttribute('data-section-focus');
    document.querySelectorAll('.planner-col.phase-col-custom').forEach(el => {
      el.classList.remove('section-spotlight', 'section-focused');
    });
    if (notify) showToast("All Sections Overview");
  } else {
    document.body.setAttribute('data-section-focus', secId);

    const allCustomCols = document.querySelectorAll('.planner-col.phase-col-custom');
    let targetEl = null;
    allCustomCols.forEach(el => {
      const match = el.getAttribute('data-section-id') === secId;
      el.classList.toggle('section-focused', match);
      if (match) targetEl = el;
    });

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      targetEl.classList.remove('section-spotlight');
      void targetEl.offsetWidth;
      targetEl.classList.add('section-spotlight');

      const secTitleInput = targetEl.querySelector('.section-title-input');
      const title = secTitleInput ? secTitleInput.value : 'Section';
      if (notify) showToast(`Focusing: ${title}`);
    }
  }
}

function updateSectionInLayout(secId, updates) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = getLayoutForDate(dateKey, currentDayData);
  if (!activeLayout) return;

  const pageRows = normalizeLayoutPageRows(activeLayout);
  let found = false;

  for (const prow of pageRows) {
    for (const sec of (prow.sections || [])) {
      if (sec.id === secId) {
        Object.assign(sec, updates);
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (found) {
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    if (!currentDayData) currentDayData = getDefaultDayData(dateKey);
    currentDayData.customLayout = activeLayout;
    safeStorage.setItem(`mrt_layout_${dateKey}`, JSON.stringify(activeLayout));
    isDirty = true;
  }
}

function updateTrackTitleInLayout(blockKey, newTitle) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = getLayoutForDate(dateKey, currentDayData);
  if (!activeLayout) return;

  const pageRows = normalizeLayoutPageRows(activeLayout);
  let found = false;

  for (const prow of pageRows) {
    for (const sec of (prow.sections || [])) {
      for (const sub of getSectionSubRows(sec)) {
        for (const tr of (sub.tracks || [])) {
          if (tr.key === blockKey) {
            tr.title = newTitle;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) break;
  }

  if (found) {
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    if (!currentDayData) currentDayData = getDefaultDayData(dateKey);
    currentDayData.customLayout = activeLayout;
    safeStorage.setItem(`mrt_layout_${dateKey}`, JSON.stringify(activeLayout));
    isDirty = true;
  }
}

function syncLevel1Bar(layout) {
  const bar = document.getElementById('workspace-level1-bar');
  if (!bar) return;
  const select = bar.querySelector('#level1-template-select');
  if (!select) return;
  const currentId = layout ? layout.id : 'blank_canvas';
  const userTemplates = getUserTemplates();

  const standardOptions = [
    { id: 'blank_canvas', label: "📄 Blank Canvas" }
  ];

  let isKnown = standardOptions.some(o => o.id === currentId) || userTemplates.some(t => t.id === currentId);

  let html = standardOptions.map(o => `
    <option value="${o.id}" ${currentId === o.id ? 'selected' : ''}>${escapeHtml(o.label)}</option>
  `).join('');

  if (userTemplates.length > 0) {
    html += `
      <optgroup label="My Custom Templates">
        ${userTemplates.map(t => `
          <option value="${t.id}" ${currentId === t.id ? 'selected' : ''}>📌 ${escapeHtml(t.name)}</option>
        `).join('')}
      </optgroup>
    `;
  }

  if (!isKnown) {
    html += `<option value="custom" selected>✦ Custom (${escapeHtml(formatDateDisplay(currentDate))})</option>`;
  }

  select.innerHTML = html;
}

function syncWorkspaceLayoutForDate(dateKey, dayData) {
  const workspaceEl = document.querySelector('.planner-workspace');
  if (!workspaceEl) return;

  const layout = getLayoutForDate(dateKey, dayData);
  renderCustomWorkspace(layout, workspaceEl);

  syncLevel1Bar(layout);
  renderPhaseRibbon(layout);
  setSectionFocus(currentSectionFocus || 'all', false);
  bindCardEvents();
}

function saveAndApplyLayoutForToday(layout) {
  const dateKey = formatDateKey(currentDate);
  if (!currentDayData) currentDayData = getDefaultDayData(dateKey);
  currentDayData.customLayout = layout;
  safeStorage.setItem(`mrt_layout_${dateKey}`, JSON.stringify(layout));
  isDirty = true;
  triggerAutoSave();
  syncWorkspaceLayoutForDate(dateKey, currentDayData);
  renderCurrentDay();
}

function attachCanvasLayoutControls(currentLayout) {
  // All canvas layout controls are directly rendered inside renderSectionHTML and dynamic cards
}

function handleCanvasAddPageRow() {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);
  const rowNum = pageRows.length + 1;
  const newRowId = `prow_${Date.now()}`;
  pageRows.push({
    id: newRowId,
    title: `PAGE ROW ${rowNum}`,
    sections: [
      {
        id: `sec_${Date.now()}`,
        title: `Section 1`,
        timeRange: "",
        colorClass: "cyan",
        rows: []
      }
    ]
  });
  markLayoutModified(activeLayout);
  activeLayout.pageRows = pageRows;
  delete activeLayout.phases;
  saveAndApplyLayoutForToday(activeLayout);
  showToast(`Added Page Row ${rowNum}!`);
}

function handleCanvasDeletePageRow(rowId) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);
  const idx = pageRows.findIndex(r => r.id === rowId);
  if (idx !== -1) {
    pageRows.splice(idx, 1);
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    saveAndApplyLayoutForToday(activeLayout);
    showToast("Page row removed");
  }
}

function handleCanvasAddSectionToRow(rowId) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);
  let targetRow = pageRows.find(r => r.id === rowId);
  if (!targetRow && pageRows.length > 0) {
    targetRow = pageRows[pageRows.length - 1];
  }
  if (!targetRow) {
    handleCanvasAddPageRow();
    return;
  }
  if (!Array.isArray(targetRow.sections)) targetRow.sections = [];

  const sNum = targetRow.sections.length + 1;
  const colors = ['cyan', 'violet', 'amber', 'emerald'];
  const nextColor = colors[(sNum - 1) % colors.length];
  targetRow.sections.push({
    id: `sec_${Date.now()}`,
    title: `Section ${sNum}`,
    timeRange: "",
    colorClass: nextColor,
    rows: []
  });
  markLayoutModified(activeLayout);
  activeLayout.pageRows = pageRows;
  delete activeLayout.phases;
  saveAndApplyLayoutForToday(activeLayout);
  showToast(`Added side-by-side section (${sNum})!`);
}

function handleCanvasDeleteSection(sectionId) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);
  let found = false;
  let title = "Section";
  for (const prow of pageRows) {
    if (Array.isArray(prow.sections)) {
      const idx = prow.sections.findIndex(s => s.id === sectionId);
      if (idx !== -1) {
        title = prow.sections[idx].title || "Section";
        prow.sections.splice(idx, 1);
        found = true;
        break;
      }
    }
  }
  if (found) {
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    saveAndApplyLayoutForToday(activeLayout);
    showToast(`Removed section "${title}"`);
  }
}

function handleCanvasAddColumn(sectionId, targetSubRowId, banner) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);

  let targetSec = null;
  if (sectionId) {
    for (const prow of pageRows) {
      targetSec = (prow.sections || []).find(s => s.id === sectionId);
      if (targetSec) break;
    }
  }

  // Fallback if triggered from default workspace banner
  if (!targetSec && banner) {
    let phaseKey = null;
    if (banner.closest('#phase-col-learning') || banner.classList.contains('banner-learning-master')) phaseKey = 'phase_learning';
    else if (banner.closest('#phase-col-productive') || banner.classList.contains('banner-work-master')) phaseKey = 'phase_productive';
    else if (banner.closest('#phase-row-evening') || banner.classList.contains('banner-evening-master')) phaseKey = 'phase_evening';
    else if (banner.closest('.health-section') || banner.classList.contains('banner-health-master')) phaseKey = 'phase_health';

    if (phaseKey) {
      for (const prow of pageRows) {
        targetSec = (prow.sections || []).find(s => s.id === phaseKey);
        if (targetSec) break;
      }
    }
  }

  if (!targetSec && pageRows.length > 0 && pageRows[0].sections && pageRows[0].sections.length > 0) {
    targetSec = pageRows[0].sections[0];
  }

  if (targetSec) {
    targetSec.rows = getSectionSubRows(targetSec);
    delete targetSec.tracks;

    let targetSubRow = null;
    if (targetSubRowId) {
      targetSubRow = targetSec.rows.find(r => r.id === targetSubRowId);
    }
    if (!targetSubRow) {
      if (targetSec.rows.length === 0) {
        targetSubRow = { id: `subrow_${Date.now()}`, title: "", tracks: [] };
        targetSec.rows.push(targetSubRow);
      } else {
        targetSubRow = targetSec.rows[targetSec.rows.length - 1];
      }
    }

    if (!Array.isArray(targetSubRow.tracks)) targetSubRow.tracks = [];

    const MAX_COLS_PER_ROW = 16;
    if (targetSubRow.tracks.length >= MAX_COLS_PER_ROW) {
      showToast(`Maximum ${MAX_COLS_PER_ROW} columns reached for this row.`);
      return;
    }

    const newKey = `custom_${Date.now()}`;
    targetSubRow.tracks.push({
      key: newKey,
      title: `Column ${targetSubRow.tracks.length + 1}`,
      placeholder: "Tasks, milestones, notes..."
    });

    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    saveAndApplyLayoutForToday(activeLayout);
    showToast(`Added column (${targetSubRow.tracks.length}) to ${targetSec.title || 'Section'}!`);
  }
}

function handleCanvasAddRow(sectionId, banner) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);

  let targetSec = null;
  if (sectionId) {
    for (const prow of pageRows) {
      targetSec = (prow.sections || []).find(s => s.id === sectionId);
      if (targetSec) break;
    }
  }

  if (!targetSec && banner) {
    let phaseKey = null;
    if (banner.closest('#phase-col-learning') || banner.classList.contains('banner-learning-master')) phaseKey = 'phase_learning';
    else if (banner.closest('#phase-col-productive') || banner.classList.contains('banner-work-master')) phaseKey = 'phase_productive';
    else if (banner.closest('#phase-row-evening') || banner.classList.contains('banner-evening-master')) phaseKey = 'phase_evening';
    else if (banner.closest('.health-section') || banner.classList.contains('banner-health-master')) phaseKey = 'phase_health';

    if (phaseKey) {
      for (const prow of pageRows) {
        targetSec = (prow.sections || []).find(s => s.id === phaseKey);
        if (targetSec) break;
      }
    }
  }

  if (!targetSec && pageRows.length > 0 && pageRows[0].sections && pageRows[0].sections.length > 0) {
    targetSec = pageRows[0].sections[0];
  }

  if (targetSec) {
    targetSec.rows = getSectionSubRows(targetSec);
    delete targetSec.tracks;

    const MAX_ROWS_PER_SECTION = 4;
    if (targetSec.rows.length >= MAX_ROWS_PER_SECTION) {
      showToast(`Maximum ${MAX_ROWS_PER_SECTION} rows per section reached.`);
      return;
    }

    const rIdx = targetSec.rows.length + 1;
    targetSec.rows.push({
      id: `row_${Date.now()}`,
      title: `Row ${rIdx}`,
      tracks: [
        {
          key: `custom_${targetSec.id || 'sec'}_${Date.now()}`,
          title: "New Column",
          placeholder: "Tasks, notes..."
        }
      ]
    });
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    saveAndApplyLayoutForToday(activeLayout);
    showToast(`Added row (${rIdx} of ${MAX_ROWS_PER_SECTION}) to ${targetSec.title || 'Section'}!`);
  }
}

// Alias for backwards compatibility
function handleCanvasAddSubRow(sectionId, banner) {
  return handleCanvasAddRow(sectionId, banner);
}

function handleCanvasDeleteRow(sectionId, subRowId) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);

  for (const prow of pageRows) {
    for (const sec of (prow.sections || [])) {
      if (sec.id === sectionId || !sectionId) {
        const rows = getSectionSubRows(sec);
        const idx = rows.findIndex(r => r.id === subRowId);
        if (idx !== -1) {
          rows.splice(idx, 1);
          sec.rows = rows;
          delete sec.tracks;
          markLayoutModified(activeLayout);
          activeLayout.pageRows = pageRows;
          delete activeLayout.phases;
          saveAndApplyLayoutForToday(activeLayout);
          showToast("Row removed from section");
          return;
        }
      }
    }
  }
}

// Alias for backwards compatibility
const handleCanvasDeleteSubRow = handleCanvasDeleteRow;

function handleCanvasDeleteColumn(blockKey) {
  const dateKey = formatDateKey(currentDate);
  let activeLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  const pageRows = normalizeLayoutPageRows(activeLayout);
  let removed = false;

  for (const prow of pageRows) {
    for (const sec of (prow.sections || [])) {
      const rows = getSectionSubRows(sec);
      for (const row of rows) {
        if (Array.isArray(row.tracks)) {
          const idx = row.tracks.findIndex(t => t.key === blockKey);
          if (idx !== -1) {
            row.tracks.splice(idx, 1);
            removed = true;
            break;
          }
        }
      }
      if (removed) {
        sec.rows = rows;
        delete sec.tracks;
        break;
      }
    }
    if (removed) break;
  }

  if (removed) {
    markLayoutModified(activeLayout);
    activeLayout.pageRows = pageRows;
    delete activeLayout.phases;
    saveAndApplyLayoutForToday(activeLayout);
    showToast("Column removed from today's layout");
  }
}

function promptSaveCurrentLayoutAsTemplate(forceNew = false) {
  const activeLayout = getActiveLayout();
  const userTemplates = getUserTemplates();
  const baseId = activeLayout.baseTemplateId || (activeLayout.id !== 'blank_canvas' && activeLayout.id !== 'custom' ? activeLayout.id : null);
  const matchedUserTpl = userTemplates.find(t => t.id === baseId);

  let defName = "My Custom Routine";
  if (matchedUserTpl) {
    defName = forceNew ? `${matchedUserTpl.name} (Copy)` : matchedUserTpl.name;
  }

  const name = prompt(forceNew ? "Enter name for the new template:" : "Enter template name:", defName);
  if (!name || !name.trim()) return;

  const targetId = (!forceNew && matchedUserTpl && matchedUserTpl.name.toLowerCase() === name.trim().toLowerCase()) ? matchedUserTpl.id : null;
  const saved = saveUserTemplate(name.trim(), activeLayout, targetId);
  if (saved) {
    activeLayout.id = saved.id;
    activeLayout.baseTemplateId = saved.id;
    activeLayout.name = saved.name;
    activeLayout.baseTemplateName = saved.name;
    activeLayout.isModified = false;
    saveAndApplyLayoutForToday(activeLayout);
    showToast(`Saved template "${saved.name}"!`);
  }
}

function handleUpdateCurrentTemplate() {
  const activeLayout = getActiveLayout();
  const userTemplates = getUserTemplates();
  const baseId = activeLayout.baseTemplateId || (activeLayout.id !== 'blank_canvas' && activeLayout.id !== 'custom' ? activeLayout.id : null);
  const matchedUserTpl = userTemplates.find(t => t.id === baseId);
  if (!matchedUserTpl) {
    promptSaveCurrentLayoutAsTemplate(false);
    return;
  }

  const updated = saveUserTemplate(matchedUserTpl.name, activeLayout, matchedUserTpl.id);
  if (updated) {
    activeLayout.id = updated.id;
    activeLayout.baseTemplateId = updated.id;
    activeLayout.name = updated.name;
    activeLayout.baseTemplateName = updated.name;
    activeLayout.isModified = false;
    saveAndApplyLayoutForToday(activeLayout);
    showToast(`Template "${updated.name}" updated with latest layout!`);
  }
}

// Global delegated change listener for template selection
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'level1-template-select') {
    const tplId = e.target.value;
    if (tplId === 'custom') return;
    if (PRESETS[tplId]) {
      const preset = JSON.parse(JSON.stringify(PRESETS[tplId]));
      preset.isModified = false;
      saveAndApplyLayoutForToday(preset);
      showToast(`Switched today to "${PRESETS[tplId].name}"`);
    } else {
      const userTpls = getUserTemplates();
      const match = userTpls.find(t => t.id === tplId);
      if (match) {
        const tplLayout = {
          id: match.id,
          baseTemplateId: match.id,
          name: match.name,
          baseTemplateName: match.name,
          description: match.description,
          isModified: false,
          pageRows: JSON.parse(JSON.stringify(match.pageRows || normalizeLayoutPageRows(match))),
          phases: JSON.parse(JSON.stringify(match.phases || []))
        };
        saveAndApplyLayoutForToday(tplLayout);
        showToast(`Switched today to "${match.name}"`);
      }
    }
  }
});

// Global delegated click listener for canvas layout modifications
document.addEventListener('click', (e) => {
  // 1. Delete column button
  const delColBtn = e.target.closest('.btn-canvas-del-col');
  if (delColBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = delColBtn.closest('.cool-card, .block-card');
    const trackKey = delColBtn.getAttribute('data-track-key') || (card && card.getAttribute('data-block'));
    if (trackKey) handleCanvasDeleteColumn(trackKey);
    return;
  }

  // 2. Add Page Row buttons (Level 1 Top bar or blank canvas welcome)
  const addPageRowBtn = e.target.closest('#btn-top-add-page-row, #btn-blank-canvas-add-row, .btn-add-page-row');
  if (addPageRowBtn) {
    e.preventDefault();
    e.stopPropagation();
    handleCanvasAddPageRow();
    return;
  }

  // 3. Add Section to Page Row (+ Add Section (Column))
  const addSecBtn = e.target.closest('.btn-row-add-sec');
  if (addSecBtn) {
    e.preventDefault();
    e.stopPropagation();
    const rowId = addSecBtn.getAttribute('data-row-id') || (addSecBtn.closest('.page-row-container') && addSecBtn.closest('.page-row-container').getAttribute('data-row-id'));
    handleCanvasAddSectionToRow(rowId);
    return;
  }

  // 4. Delete Page Row button
  const delPageRowBtn = e.target.closest('.btn-row-del');
  if (delPageRowBtn) {
    e.preventDefault();
    e.stopPropagation();
    const rowId = delPageRowBtn.getAttribute('data-row-id') || (delPageRowBtn.closest('.page-row-container') && delPageRowBtn.closest('.page-row-container').getAttribute('data-row-id'));
    if (rowId) handleCanvasDeletePageRow(rowId);
    return;
  }

  // 5. Delete Section button
  const delSecBtn = e.target.closest('.btn-canvas-del-section');
  if (delSecBtn) {
    e.preventDefault();
    e.stopPropagation();
    const secEl = delSecBtn.closest('.phase-col-custom');
    const secId = delSecBtn.getAttribute('data-section-id') || delSecBtn.getAttribute('data-phase-id') || (secEl && (secEl.getAttribute('data-section-id') || secEl.getAttribute('data-phase-id')));
    if (secId) handleCanvasDeleteSection(secId);
    return;
  }

  // 6. Add Row button inside section
  const addRowBtn = e.target.closest('.btn-canvas-add-row, .btn-starter-add-row, .btn-canvas-add-subrow, .btn-starter-add-subrow');
  if (addRowBtn) {
    e.preventDefault();
    e.stopPropagation();
    const secEl = addRowBtn.closest('.phase-col-custom');
    const secId = addRowBtn.getAttribute('data-section-id') || addRowBtn.getAttribute('data-phase-id') || (secEl && (secEl.getAttribute('data-section-id') || secEl.getAttribute('data-phase-id')));
    const banner = addRowBtn.closest('.col-master-banner') || secEl;
    handleCanvasAddRow(secId, banner);
    return;
  }

  // 7. Delete Row button inside section
  const delSecRowBtn = e.target.closest('.btn-canvas-del-row, .btn-canvas-del-subrow');
  if (delSecRowBtn) {
    e.preventDefault();
    e.stopPropagation();
    const rowBlock = delSecRowBtn.closest('.phase-row-block');
    const secEl = delSecRowBtn.closest('.phase-col-custom');
    const secId = delSecRowBtn.getAttribute('data-section-id') || delSecRowBtn.getAttribute('data-phase-id') || (secEl && (secEl.getAttribute('data-section-id') || secEl.getAttribute('data-phase-id')));
    const rowId = delSecRowBtn.getAttribute('data-subrow-id') || delSecRowBtn.getAttribute('data-row-id') || (rowBlock && (rowBlock.getAttribute('data-subrow-id') || rowBlock.getAttribute('data-row-id')));
    if (rowId) handleCanvasDeleteRow(secId, rowId);
    return;
  }

  // 8. Add Column button (master banner, sub-row, or starter)
  const addColBtn = e.target.closest('.btn-canvas-add-col, .btn-canvas-add-col-to-subrow, .btn-canvas-add-col-to-row, .btn-starter-add-col');
  if (addColBtn) {
    e.preventDefault();
    e.stopPropagation();
    const secEl = addColBtn.closest('.phase-col-custom');
    const secId = addColBtn.getAttribute('data-section-id') || addColBtn.getAttribute('data-phase-id') || (secEl && (secEl.getAttribute('data-section-id') || secEl.getAttribute('data-phase-id')));
    const subRowId = addColBtn.getAttribute('data-subrow-id') || addColBtn.getAttribute('data-row-id') ||
                     (addColBtn.closest('.phase-row-block') && (addColBtn.closest('.phase-row-block').getAttribute('data-subrow-id') || addColBtn.closest('.phase-row-block').getAttribute('data-row-id')));
    const banner = addColBtn.closest('.col-master-banner') || secEl;
    handleCanvasAddColumn(secId, subRowId, banner);
    return;
  }

  // 9. Template action buttons (Level 1 Top bar)
  const updateTplBtn = e.target.closest('#btn-top-update-template, .btn-update-template');
  if (updateTplBtn) {
    e.preventDefault();
    e.stopPropagation();
    handleUpdateCurrentTemplate();
    return;
  }

  const saveNewTplBtn = e.target.closest('#btn-top-save-new-template, .btn-save-new-template');
  if (saveNewTplBtn) {
    e.preventDefault();
    e.stopPropagation();
    promptSaveCurrentLayoutAsTemplate(true);
    return;
  }

  const delTplBtn = e.target.closest('#btn-top-del-template, .btn-del-template');
  if (delTplBtn) {
    e.preventDefault();
    e.stopPropagation();
    const tplId = delTplBtn.getAttribute('data-tpl-id');
    const userTemplates = getUserTemplates();
    const match = userTemplates.find(t => t.id === tplId);
    if (!match) return;
    if (confirm(`Delete the template "${match.name}"?`)) {
      deleteUserTemplate(match.id);
      const activeLayout = getActiveLayout();
      activeLayout.id = 'custom';
      delete activeLayout.baseTemplateId;
      delete activeLayout.baseTemplateName;
      activeLayout.isModified = false;
      saveAndApplyLayoutForToday(activeLayout);
      showToast(`Deleted template "${match.name}"`);
    }
    return;
  }

  const saveTplBtn = e.target.closest('#btn-top-save-template, .btn-save-template');
  if (saveTplBtn) {
    e.preventDefault();
    e.stopPropagation();
    promptSaveCurrentLayoutAsTemplate(false);
    return;
  }

  // 10. Clear to Blank Canvas
  const resetBlankBtn = e.target.closest('#btn-top-reset-blank, #btn-canvas-bottom-reset-blank');
  if (resetBlankBtn) {
    e.preventDefault();
    e.stopPropagation();
    saveAndApplyLayoutForToday(PRESETS.blank_canvas);
    showToast("Cleared to Blank Canvas");
    return;
  }

  // 11. Dynamic Phase Ribbon Tab Click (Section Selection / Navigation)
  const ribbonBtn = e.target.closest('#phase-ribbon .phase-tab-btn');
  if (ribbonBtn) {
    e.preventDefault();
    e.stopPropagation();
    const secId = ribbonBtn.getAttribute('data-section-id');
    if (!secId || secId === 'all') {
      setSectionFocus('all');
    } else {
      if (currentSectionFocus === secId) {
        setSectionFocus('all');
      } else {
        setSectionFocus(secId);
      }
    }
    return;
  }
});

// Delegated input listener for real-time section title and time updates
document.addEventListener('input', (e) => {
  const titleInput = e.target.closest('.section-title-input');
  if (titleInput) {
    const secId = titleInput.getAttribute('data-section-id');
    const newTitle = titleInput.value;
    updateSectionInLayout(secId, { title: newTitle });

    // Live update ribbon tab in real-time without destroying focus
    const ribbonTitle = document.querySelector(`.phase-title[data-ribbon-sec-id="${secId}"]`);
    if (ribbonTitle) {
      ribbonTitle.textContent = newTitle.trim() || 'Untitled Section';
    }
    const ribbonBtn = document.querySelector(`.phase-tab-btn[data-section-id="${secId}"]`);
    if (ribbonBtn) {
      ribbonBtn.setAttribute('title', newTitle.trim() || 'Untitled Section');
    }
    triggerAutoSave();
    return;
  }

  const timeInput = e.target.closest('.section-time-input');
  if (timeInput) {
    const secId = timeInput.getAttribute('data-section-id');
    const newTime = timeInput.value;
    updateSectionInLayout(secId, { timeRange: newTime });

    // Live update ribbon time pill in real-time
    const ribbonBtn = document.querySelector(`.phase-tab-btn[data-section-id="${secId}"]`);
    if (ribbonBtn) {
      let timePill = ribbonBtn.querySelector('.phase-time');
      if (newTime.trim()) {
        if (!timePill) {
          timePill = document.createElement('span');
          timePill.className = `phase-time pill-${ribbonBtn.dataset.color || 'cyan'}`;
          ribbonBtn.appendChild(timePill);
        }
        timePill.textContent = newTime.trim();
        timePill.style.display = '';
      } else if (timePill) {
        timePill.style.display = 'none';
      }
    }
    triggerAutoSave();
    return;
  }
});

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

  const pageRows = normalizeLayoutPageRows(layout);

  // If 100% full blank canvas (0 page rows), render welcoming blank state
  if (pageRows.length === 0) {
    workspaceEl.innerHTML = bannerHTML + renderLevel1TopBarHTML(layout) + `
      <div class="blank-canvas-welcome">
        <div class="blank-canvas-icon">✦</div>
        <h3>Blank Canvas for ${escapeHtml(formatDateDisplay(currentDate))}</h3>
        <p>Your daily planner is completely blank. Start by adding your first Page Row across the day.</p>
        <div style="margin-top: 14px;">
          <button type="button" class="btn-level1-action btn-add-page-row" id="btn-blank-canvas-add-row" style="display: inline-flex; font-size: 13px; padding: 8px 18px;">
            <span class="btn-level1-icon">＋</span> + Add First Page Row
          </button>
        </div>
      </div>
    `;

    // Re-bind carryover banner buttons
    const bApply = document.getElementById('btn-carryover-apply');
    if (bApply) bApply.addEventListener('click', applyPendingCarryover);
    const bChoose = document.getElementById('btn-carryover-choose');
    if (bChoose) bChoose.addEventListener('click', () => openImportModal(currentPendingCarryoverSourceDate));
    const bDismiss = document.getElementById('btn-carryover-dismiss');
    if (bDismiss) bDismiss.addEventListener('click', dismissCarryover);
    return;
  }

  function renderSectionHTML(sec, rowId, sIdx) {
    const color = sec.colorClass || 'cyan';
    const subRows = getSectionSubRows(sec);
    return `
      <div class="planner-col phase-col-custom" data-section-id="${sec.id}" data-row-id="${rowId}">
        <div class="col-master-banner banner-${color}-master">
          <div class="master-banner-left">
            <span class="track-indicator dot-${color}"></span>
            <input type="text" class="section-title-input" data-section-id="${sec.id}" value="${escapeHtml(sec.title || '')}" placeholder="Section ${sIdx + 1}..." spellcheck="false" title="Click to rename this section" />
            <input type="text" class="section-time-input pill-${color}" data-section-id="${sec.id}" value="${escapeHtml((sec.timeRange && sec.timeRange !== 'Custom Hours') ? sec.timeRange : '')}" placeholder="Hours (optional)..." spellcheck="false" title="Section time range or hours (optional)" />
          </div>
          <div class="master-banner-actions">
            <button type="button" class="btn-canvas-add-col btn-canvas-mini" data-section-id="${sec.id}" data-row-id="${rowId}" title="Add column to this section">+ Column</button>
            <button type="button" class="btn-canvas-add-row btn-canvas-mini" data-section-id="${sec.id}" data-row-id="${rowId}" title="Add row to this section">+ Row</button>
            <button type="button" class="btn-canvas-del-section" data-section-id="${sec.id}" data-row-id="${rowId}" title="Delete this section">✕</button>
          </div>
        </div>
        <div class="phase-rows-container" style="display: flex; flex-direction: column; gap: 14px;">
          ${subRows.length === 0 ? `
            <div class="empty-section-starter" data-section-id="${sec.id}" data-row-id="${rowId}">
              <div class="starter-actions">
                <button type="button" class="btn-canvas-action-btn btn-starter-add-col" data-section-id="${sec.id}" data-row-id="${rowId}" title="Add a column to this section">+ Add Column</button>
                <button type="button" class="btn-canvas-action-btn btn-starter-add-row" data-section-id="${sec.id}" data-row-id="${rowId}" title="Add a row to this section">+ Add Row</button>
              </div>
            </div>
          ` : subRows.map((sub, rIdx) => {
            return `
              <div class="phase-row-block" data-section-id="${sec.id}" data-subrow-id="${sub.id}">
                ${(subRows.length > 1 || sub.title) ? `
                  <div class="sub-split-header-clean" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 6px;">
                    <span class="sub-split-tag tag-${color}">${escapeHtml(sub.title || ('Row ' + (rIdx + 1)))}</span>
                    <div class="row-canvas-actions" style="display: flex; align-items: center; gap: 4px; margin-left: auto; flex-shrink: 0;">
                      <button type="button" class="btn-canvas-add-col-to-subrow btn-canvas-mini" data-section-id="${sec.id}" data-subrow-id="${sub.id}" title="Add column to this row">+ Column</button>
                      <button type="button" class="btn-canvas-del-row btn-canvas-mini" data-section-id="${sec.id}" data-subrow-id="${sub.id}" title="Delete this row">✕ Row</button>
                    </div>
                  </div>
                ` : ''}
                <div class="section-cards-scroll-row" data-subrow-id="${sub.id}">
                  ${(sub.tracks || []).map((t, tIdx) => `
                    <div class="cool-card dynamic-col-card" data-block="${t.key || ('custom_' + sec.id + '_' + tIdx)}" data-active-tab="tasks">
                      <div class="card-bar">
                        <div class="card-bar-left">
                          <span class="track-indicator dot-${color}"></span>
                          <input type="text" class="card-title-input" value="${escapeHtml(t.title)}" placeholder="${escapeHtml(t.title)}" spellcheck="false" title="Click to rename this column" />
                        </div>
                        <div class="card-bar-right">
                          <span class="card-checklist-stat"></span>
                          <button class="btn-check-insert" title="Insert Checkbox">☐</button>
                          <button class="btn-bullet-insert" title="Insert Bullet">•</button>
                          <button type="button" class="btn-push-to-doc-action" data-track-key="${t.key}" title="Push notes/tasks from this column to Thinking Space (e.g. AI Research)">💡</button>
                          <button type="button" class="btn-canvas-del-col" data-track-key="${t.key}" title="Delete this column from today">✕</button>
                        </div>
                      </div>
                      <div class="card-editor-area">
                        <textarea class="card-text-editor" placeholder="${escapeHtml(t.placeholder || 'Tasks and notes...')}"></textarea>
                      </div>
                    </div>
                  `).join('')}
                  ${(!sub.tracks || sub.tracks.length === 0) ? `
                    <div class="empty-row-hint">No columns in this tier. <button type="button" class="btn-canvas-add-col-to-subrow" data-section-id="${sec.id}" data-subrow-id="${sub.id}">+ Column</button></div>
                  ` : ''}
                </div>
              </div>
              ${(rIdx < subRows.length - 1) ? `<div class="clean-split-rule"></div>` : ''}
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  const rowsHTML = pageRows.map((prow, rIdx) => {
    const sections = prow.sections || [];
    return `
      <div class="page-row-container" data-row-id="${prow.id}">
        <div class="page-row-header">
          <div class="page-row-header-left">
            <span class="page-row-tag">${escapeHtml(prow.title || ('PAGE ROW ' + (rIdx + 1)))}</span>
            <span class="page-row-count-badge">${sections.length} ${sections.length === 1 ? 'section' : 'sections'}</span>
          </div>
          <div class="page-row-actions">
            <button type="button" class="btn-row-action btn-row-add-sec" data-row-id="${prow.id}" title="Split this row by adding another side-by-side section">+ Add Section</button>
            <button type="button" class="btn-row-action btn-row-del" data-row-id="${prow.id}" title="Delete this entire page row">✕ Row</button>
          </div>
        </div>
        <div class="page-row-sections">
          ${sections.length === 0 ? `
            <div class="empty-section-starter" style="width: 100%;">
              <p class="starter-desc">This row is empty. Click below to add a section:</p>
              <button type="button" class="btn-canvas-action-btn btn-row-add-sec" data-row-id="${prow.id}">+ Add Section</button>
            </div>
          ` : sections.map((sec, sIdx) => renderSectionHTML(sec, prow.id, sIdx)).join('')}
        </div>
      </div>
    `;
  }).join('');

  workspaceEl.innerHTML = bannerHTML + renderLevel1TopBarHTML(layout) + rowsHTML;

  // Re-bind carryover banner buttons
  const bApply = document.getElementById('btn-carryover-apply');
  if (bApply) bApply.addEventListener('click', applyPendingCarryover);
  const bChoose = document.getElementById('btn-carryover-choose');
  if (bChoose) bChoose.addEventListener('click', () => openImportModal(currentPendingCarryoverSourceDate));
  const bDismiss = document.getElementById('btn-carryover-dismiss');
  if (bDismiss) bDismiss.addEventListener('click', dismissCarryover);

  initHorizontalMouseWheelScroll();
}

function initHorizontalMouseWheelScroll() {
  document.querySelectorAll('.section-cards-scroll-row, .page-row-sections, .day-timeline-ribbon').forEach(scrollContainer => {
    if (scrollContainer._hasWheelListener) return;
    scrollContainer._hasWheelListener = true;

    scrollContainer.addEventListener('wheel', (e) => {
      // If user holds Shift or trackpad already uses horizontal delta, allow native
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      // Check if mouse is hovering over vertically scrollable child that can scroll in this direction
      const verticalScrollable = e.target.closest('.tasks-scroll-list, .card-notes-editor');
      if (verticalScrollable) {
        const canScrollDown = e.deltaY > 0 && (verticalScrollable.scrollTop + verticalScrollable.clientHeight < verticalScrollable.scrollHeight - 1);
        const canScrollUp = e.deltaY < 0 && (verticalScrollable.scrollTop > 1);
        if (canScrollDown || canScrollUp) {
          return;
        }
      }

      if (scrollContainer.scrollWidth > scrollContainer.clientWidth) {
        const canScrollRight = e.deltaY > 0 && (scrollContainer.scrollLeft + scrollContainer.clientWidth < scrollContainer.scrollWidth - 1);
        const canScrollLeft = e.deltaY < 0 && (scrollContainer.scrollLeft > 1);
        if (canScrollRight || canScrollLeft) {
          e.preventDefault();
          e.stopPropagation();
          scrollContainer.scrollLeft += e.deltaY;
        }
      }
    }, { passive: false });
  });
}


function openCustomizeModal() {
  const modal = document.getElementById('customize-layout-modal');
  if (!modal) return;
  const dateKey = formatDateKey(currentDate);
  currentEditingLayout = JSON.parse(JSON.stringify(getLayoutForDate(dateKey, currentDayData)));
  if (!Array.isArray(currentEditingLayout.phases) || currentEditingLayout.phases.length === 0) {
    if (Array.isArray(currentEditingLayout.pageRows)) {
      currentEditingLayout.phases = [];
      currentEditingLayout.pageRows.forEach(prow => {
        (prow.sections || []).forEach(sec => {
          currentEditingLayout.phases.push(sec);
        });
      });
    } else {
      currentEditingLayout.phases = [];
    }
  }
  const dateDisp = document.getElementById('customize-date-display');
  if (dateDisp) dateDisp.textContent = formatDateDisplay(currentDate);
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
    { id: 'blank_canvas', icon: '📄', name: "Blank Canvas", desc: "100% clean slate. Build custom sections, rows, and columns" }
  ];

  const userTemplates = getUserTemplates();
  userTemplates.forEach(t => {
    presetList.push({
      id: t.id,
      icon: '📌',
      name: t.name,
      desc: t.description || 'User Custom Template',
      isUser: true
    });
  });

  presetList.forEach(p => {
    const btn = document.createElement('div');
    btn.className = `preset-card-btn ${currentEditingLayout && currentEditingLayout.id === p.id ? 'active' : ''}`;
    btn.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div class="preset-card-title">
          <span>${p.icon}</span>
          <span>${escapeHtml(p.name)}</span>
        </div>
        ${p.isUser ? `<button type="button" class="btn-del-user-template" data-tpl-id="${p.id}" title="Delete this custom template" style="background: none; border: none; color: #ef4444; font-size: 13px; cursor: pointer; padding: 0 4px;">✕</button>` : ''}
      </div>
      <div class="preset-card-desc">${escapeHtml(p.desc)}</div>
    `;
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.btn-del-user-template')) {
        e.stopPropagation();
        const tplId = e.target.closest('.btn-del-user-template').getAttribute('data-tpl-id');
        if (confirm(`Delete template "${p.name}"?`)) {
          deleteUserTemplate(tplId);
          renderPresetCards();
        }
        return;
      }
      const selected = PRESETS[p.id] || userTemplates.find(t => t.id === p.id);
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
  if (phases.length === 0) {
    container.innerHTML = `
      <div class="empty-row-hint" style="padding: 16px; justify-content: center; font-size: 13px;">
        ✦ Blank Canvas: No sections or columns currently exist for this day. Click "+ Add New Phase / Section" below to build your layout!
      </div>
    `;
    return;
  }

  phases.forEach((phase, phaseIdx) => {
    const box = document.createElement('div');
    box.className = 'phase-customizer-box';

    // Header: phase title, time, orientation, and delete section button
    const isHoriz = (phase.orientation === 'horizontal');
    const header = document.createElement('div');
    header.className = 'phase-customizer-header';
    header.innerHTML = `
      <input type="text" class="phase-customizer-title-input" value="${escapeHtml(phase.title || '')}" placeholder="Phase Title (e.g. Morning Focus)" />
      <input type="text" class="phase-customizer-time-input" value="${escapeHtml(phase.timeRange || '')}" placeholder="Time (09:00 — 18:00)" />
      <button type="button" class="phase-orientation-btn ${isHoriz ? 'is-horiz' : 'is-vert'}" title="Toggle Orientation">${isHoriz ? '↔ Horizontal Row' : '↕ Vertical Column'}</button>
      <button type="button" class="phase-delete-btn" title="Delete this section">🗑 Delete Section</button>
    `;

    const titleInput = header.querySelector('.phase-customizer-title-input');
    titleInput.addEventListener('input', () => {
      phase.title = titleInput.value;
      currentEditingLayout.id = 'custom';
      renderPresetCards();
    });
    const timeInput = header.querySelector('.phase-customizer-time-input');
    timeInput.addEventListener('input', () => {
      phase.timeRange = timeInput.value;
      currentEditingLayout.id = 'custom';
    });
    const orientBtn = header.querySelector('.phase-orientation-btn');
    if (orientBtn) {
      orientBtn.addEventListener('click', () => {
        phase.orientation = (phase.orientation === 'horizontal') ? 'vertical' : 'horizontal';
        currentEditingLayout.id = 'custom';
        renderPresetCards();
        renderPhaseCustomizer();
      });
    }
    const delPhaseBtn = header.querySelector('.phase-delete-btn');
    if (delPhaseBtn) {
      delPhaseBtn.addEventListener('click', () => {
        phases.splice(phaseIdx, 1);
        currentEditingLayout.id = 'custom';
        renderPresetCards();
        renderPhaseCustomizer();
      });
    }
    box.appendChild(header);

    // Rows container inside this phase
    const rows = getPhaseRows(phase);
    phase.rows = rows;
    delete phase.tracks;

    const rowsContainer = document.createElement('div');
    rowsContainer.className = 'phase-rows-edit-container';
    rowsContainer.style.display = 'flex';
    rowsContainer.style.flexDirection = 'column';
    rowsContainer.style.gap = '10px';

    rows.forEach((row, rowIdx) => {
      const rowBox = document.createElement('div');
      rowBox.className = 'row-customizer-box';

      // Row Header
      const rHeader = document.createElement('div');
      rHeader.className = 'row-customizer-header';
      rHeader.innerHTML = `
        <span style="font-size: 11px; font-weight: 800; color: var(--accent-cyan); text-transform: uppercase;">Row ${rowIdx + 1}:</span>
        <input type="text" class="row-customizer-title-input" value="${escapeHtml(row.title || '')}" placeholder="Row Header / Tag (Optional, e.g. Part 1 — Depth, Afternoon Batch)" />
        <button type="button" class="row-delete-btn" title="Delete this Row">✕ Delete Row</button>
      `;

      const rTitleInput = rHeader.querySelector('.row-customizer-title-input');
      rTitleInput.addEventListener('input', () => {
        row.title = rTitleInput.value;
        currentEditingLayout.id = 'custom';
        renderPresetCards();
      });

      const rDelBtn = rHeader.querySelector('.row-delete-btn');
      rDelBtn.addEventListener('click', () => {
        rows.splice(rowIdx, 1);
        currentEditingLayout.id = 'custom';
        renderPresetCards();
        renderPhaseCustomizer();
      });

      rowBox.appendChild(rHeader);

      // Track List in Row
      const trackList = document.createElement('div');
      trackList.className = 'track-edit-list';

      if (!Array.isArray(row.tracks)) row.tracks = [];
      row.tracks.forEach((track, trackIdx) => {
        const trRow = document.createElement('div');
        trRow.className = 'track-edit-row';
        trRow.innerHTML = `
          <span class="track-indicator dot-${phase.colorClass || 'cyan'}"></span>
          <input type="text" class="track-edit-input" value="${escapeHtml(track.title || '')}" placeholder="Column Title" />
          <input type="text" class="track-edit-sub-input" value="${escapeHtml(track.placeholder || '')}" placeholder="Subtitle / details hint..." />
          <button type="button" class="track-edit-del-btn" title="Remove Column">✕</button>
        `;

        const tInput = trRow.querySelector('.track-edit-input');
        tInput.addEventListener('input', () => {
          track.title = tInput.value;
          currentEditingLayout.id = 'custom';
          renderPresetCards();
        });
        const sInput = trRow.querySelector('.track-edit-sub-input');
        sInput.addEventListener('input', () => {
          track.placeholder = sInput.value;
          currentEditingLayout.id = 'custom';
        });

        const delBtn = trRow.querySelector('.track-edit-del-btn');
        delBtn.addEventListener('click', () => {
          row.tracks.splice(trackIdx, 1);
          currentEditingLayout.id = 'custom';
          renderPresetCards();
          renderPhaseCustomizer();
        });

        trackList.appendChild(trRow);
      });

      if (row.tracks.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'empty-row-hint';
        emptyHint.textContent = "No columns in this row yet. Click below to add a column.";
        trackList.appendChild(emptyHint);
      }

      rowBox.appendChild(trackList);

      // Add Column Button to Row
      const addColBtn = document.createElement('button');
      addColBtn.type = 'button';
      addColBtn.className = 'btn-add-track-col';
      addColBtn.innerHTML = `<span>+</span> <span>Add Column to Row ${rowIdx + 1}</span>`;
      addColBtn.addEventListener('click', () => {
        const newKey = `custom_${phase.id || 'phase'}_${Date.now()}`;
        row.tracks.push({
          key: newKey,
          title: `Column ${row.tracks.length + 1}`,
          placeholder: "Tasks, milestones, notes..."
        });
        currentEditingLayout.id = 'custom';
        renderPresetCards();
        renderPhaseCustomizer();
      });
      rowBox.appendChild(addColBtn);

      rowsContainer.appendChild(rowBox);
    });

    box.appendChild(rowsContainer);

    // Add Row to Section Button
    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'btn-add-row-to-phase';
    addRowBtn.innerHTML = `<span>+</span> <span>Add Row to ${escapeHtml(phase.title || 'Phase')}</span>`;
    addRowBtn.addEventListener('click', () => {
      const rIdx = rows.length + 1;
      rows.push({
        id: `row_${Date.now()}`,
        title: `Row ${rIdx}`,
        tracks: [
          {
            key: `custom_${phase.id || 'phase'}_${Date.now()}`,
            title: "New Column",
            placeholder: "Tasks, notes..."
          }
        ]
      });
      currentEditingLayout.id = 'custom';
      renderPresetCards();
      renderPhaseCustomizer();
    });
    box.appendChild(addRowBtn);

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
const btnAddNewPhase = document.getElementById('btn-add-new-phase');

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

  // Check active layout tracks
  try {
    const layout = getActiveLayout();
    const tracks = getAllLayoutTracks(layout);
    for (const t of tracks) {
      if (t.key === blockKey && t.title) return t.title;
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
  const layout = getLayoutForDate(dateKey, null);
  const data = {
    date: dateKey,
    updatedAt: new Date().toISOString(),
    customLayout: layout
  };

  const tracks = getAllLayoutTracks(layout);
  tracks.forEach(t => {
    if (t.key) {
      data[t.key] = getDefaultBlockData(t.title || getDefaultTitle(t.key));
    }
  });

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

  // Auto-migrate legacy content string if tasks or notes not yet segregated, or if content has tasks
  const rawContent = rawBlock.content || "";
  if (rawContent && (tasks === null || notes === null || rawContent.includes('- [ ]') || rawContent.includes('- [x]') || rawContent.includes('- [X]'))) {
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
          const text = trimmed.replace(/^[-*]\s\[\s\]\s?/, '').trim();
          if (text) parent.subtasks.push({ text, done: false });
          continue;
        } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]') || trimmed.startsWith('* [x]') || trimmed.startsWith('* [X]')) {
          const parent = extractedTasks[extractedTasks.length - 1];
          if (!Array.isArray(parent.subtasks)) parent.subtasks = [];
          const text = trimmed.replace(/^[-*]\s\[[xX]\]\s?/, '').trim();
          if (text) parent.subtasks.push({ text, done: true });
          continue;
        }
      }

      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
        const text = trimmed.replace(/^[-*]\s\[\s\]\s?/, '').trim();
        if (text) extractedTasks.push({ text, done: false, subtasks: [] });
      } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]') || trimmed.startsWith('* [x]') || trimmed.startsWith('* [X]')) {
        const text = trimmed.replace(/^[-*]\s\[[xX]\]\s?/, '').trim();
        if (text) extractedTasks.push({ text, done: true, subtasks: [] });
      } else if (trimmed.length > 0) {
        extractedNotes.push(line);
      }
    }

    if (tasks === null) {
      tasks = extractedTasks;
    } else if (extractedTasks.length > 0) {
      extractedTasks.forEach(et => {
        if (et.text && !tasks.some(t => t && t.text && t.text.trim().toLowerCase() === et.text.toLowerCase())) {
          tasks.push(et);
        }
      });
    }
    if (notes === null) notes = extractedNotes.join('\n');
  }

  if (Array.isArray(tasks)) {
    tasks = tasks
      .filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0)
      .map(t => ({
        text: t.text.trim(),
        done: !!t.done,
        notes: typeof t.notes === 'string' ? t.notes : '',
        subtasks: Array.isArray(t.subtasks)
          ? t.subtasks
            .filter(s => s && (typeof s === 'string' ? s.trim().length > 0 : (s.text && s.text.trim().length > 0)))
            .map(s => ({
              text: typeof s === 'string' ? s.trim() : (s.text || '').trim(),
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
    if (!['date', 'updatedAt', 'importedFrom', 'importedAt', 'evening', 'part1', 'health', 'customLayout'].includes(k)) {
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
  if (raw.customLayout && typeof raw.customLayout === 'object') {
    normalized.customLayout = raw.customLayout;
  }

  // Strict normalization for Part 2 (Breadth)
  if (normalized.part2) {
    const p2Title = (normalized.part2.title || '').trim().toLowerCase();
    if (!p2Title || p2Title.includes('electronics') || p2Title.includes('motors') || p2Title.includes('part - 2') || p2Title.includes('part-2') || p2Title.includes('part 2')) {
      normalized.part2.title = "Breadth";
    }
  }

  // Strict normalization for Evening Survivo
  if (normalized.evening_survivi) {
    const survTitle = (normalized.evening_survivi.title || '').trim().toLowerCase();
    if (!survTitle || survTitle.includes('survivi')) {
      normalized.evening_survivi.title = "Survivo";
    }
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

  // In Tauri desktop app, disk is the authoritative source of truth
  if (typeof window.__TAURI__ !== 'undefined') {
    if (diskData) {
      safeStorage.setItem(`mrt_${dateKey}`, JSON.stringify(diskData));
      return diskData;
    } else {
      // File was deleted on disk or has not been created yet
      safeStorage.removeItem(`mrt_${dateKey}`);
      activeDatesSet.delete(dateKey);
      return getDefaultDayData(dateKey);
    }
  }

  // Fallback for pure browser mode without Tauri backend
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

  if (typeof window.__TAURI__ === 'undefined') {
    safeStorage.setItem(`mrt_${dateKey}`, JSON.stringify(dataToSave));
  }
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
  if (!data || typeof data !== 'object') return false;
  if (data.customLayout) {
    try {
      const tracks = getAllLayoutTracks(data.customLayout);
      if (tracks && tracks.length > 0) return true;
    } catch (e) { }
  }
  for (const key of Object.keys(data)) {
    if (!['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(key)) {
      const b = data[key];
      if (b && typeof b === 'object') {
        if (Array.isArray(b.tasks) && b.tasks.some(t => t && typeof t.text === 'string' && t.text.trim().length > 0)) return true;
        if (b.notes && typeof b.notes === 'string' && b.notes.trim().length > 0) return true;
        if (b.content && typeof b.content === 'string' && b.content.trim().length > 0) return true;
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

// Move task within a block or reorder to any target index
function moveTask(blockKey, fromIdx, toIdx) {
  const block = currentDayData[blockKey];
  if (!block || !Array.isArray(block.tasks) || block.tasks.length === 0) return;

  toIdx = Math.max(0, Math.min(block.tasks.length - 1, toIdx));
  if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= block.tasks.length) return;

  const [moved] = block.tasks.splice(fromIdx, 1);
  block.tasks.splice(toIdx, 0, moved);

  syncBlockContent(blockKey);
  const card = document.querySelector(`.cool-card[data-block="${blockKey}"]`);
  if (card) {
    renderCardTasks(card, blockKey);
  }
  updateCardTabBadges(card, blockKey);
  triggerAutoSave();

  setTimeout(() => {
    const targetInput = document.querySelector(`.cool-card[data-block="${blockKey}"] .task-row[data-task-idx="${toIdx}"] .task-row-input`);
    if (targetInput) {
      targetInput.focus();
      setActiveTaskSelection(blockKey, toIdx);
    }
  }, 30);
}

// Move task between two different blocks/columns
function moveTaskBetweenBlocks(fromBlockKey, fromIdx, toBlockKey, toIdx) {
  const srcBlock = currentDayData[fromBlockKey];
  const dstBlock = currentDayData[toBlockKey];
  if (!srcBlock || !Array.isArray(srcBlock.tasks) || !dstBlock) return;
  if (!Array.isArray(dstBlock.tasks)) dstBlock.tasks = [];
  if (fromIdx < 0 || fromIdx >= srcBlock.tasks.length) return;

  const [moved] = srcBlock.tasks.splice(fromIdx, 1);
  const insertAt = (typeof toIdx === 'number' && toIdx >= 0) ? Math.min(dstBlock.tasks.length, toIdx) : dstBlock.tasks.length;
  dstBlock.tasks.splice(insertAt, 0, moved);

  syncBlockContent(fromBlockKey);
  syncBlockContent(toBlockKey);

  const srcCard = document.querySelector(`.cool-card[data-block="${fromBlockKey}"]`);
  if (srcCard) renderCardTasks(srcCard, fromBlockKey);
  const dstCard = document.querySelector(`.cool-card[data-block="${toBlockKey}"]`);
  if (dstCard) renderCardTasks(dstCard, toBlockKey);

  triggerAutoSave();

  setTimeout(() => {
    const targetInput = document.querySelector(`.cool-card[data-block="${toBlockKey}"] .task-row[data-task-idx="${insertAt}"] .task-row-input`);
    if (targetInput) {
      targetInput.focus();
      setActiveTaskSelection(toBlockKey, insertAt);
    }
  }, 30);
}

// Prompt dialog to jump task to any specific position number (1-based, e.g. #3 to #1)
function promptMoveTask(blockKey, currentIdx, totalCount) {
  const currentNum = currentIdx + 1;
  const ans = prompt(`Move task #${currentNum} to position (1 to ${totalCount}):`, String(currentNum));
  if (ans === null) return;
  const targetNum = parseInt(ans.trim(), 10);
  if (!isNaN(targetNum) && targetNum >= 1 && targetNum <= totalCount) {
    moveTask(blockKey, currentIdx, targetNum - 1);
  }
}

// Move subtask within parent task
function moveSubtask(blockKey, parentTaskIdx, fromSubIdx, toSubIdx) {
  const block = currentDayData[blockKey];
  if (!block || !Array.isArray(block.tasks)) return;
  const task = block.tasks[parentTaskIdx];
  if (!task || !Array.isArray(task.subtasks) || task.subtasks.length === 0) return;

  toSubIdx = Math.max(0, Math.min(task.subtasks.length - 1, toSubIdx));
  if (fromSubIdx === toSubIdx || fromSubIdx < 0 || fromSubIdx >= task.subtasks.length) return;

  const [moved] = task.subtasks.splice(fromSubIdx, 1);
  task.subtasks.splice(toSubIdx, 0, moved);

  syncBlockContent(blockKey);
  const card = document.querySelector(`.cool-card[data-block="${blockKey}"]`);
  if (card) {
    renderCardTasks(card, blockKey);
  }
  triggerAutoSave();

  setTimeout(() => {
    const targetSubInput = document.querySelector(`.cool-card[data-block="${blockKey}"] .task-subtasks-tree[data-parent-task-idx="${parentTaskIdx}"] .subtask-row[data-sub-idx="${toSubIdx}"] .subtask-row-input`);
    if (targetSubInput) {
      targetSubInput.focus();
    }
  }, 30);
}

// Prompt dialog to jump subtask to any position number (1-based)
function promptMoveSubtask(blockKey, parentTaskIdx, currentSubIdx, totalCount) {
  const currentNum = currentSubIdx + 1;
  const ans = prompt(`Move subtask #${currentNum} to position (1 to ${totalCount}):`, String(currentNum));
  if (ans === null) return;
  const targetNum = parseInt(ans.trim(), 10);
  if (!isNaN(targetNum) && targetNum >= 1 && targetNum <= totalCount) {
    moveSubtask(blockKey, parentTaskIdx, currentSubIdx, targetNum - 1);
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
    listEl.innerHTML = `<div class="empty-tasks-hint" title="Click to add a task">+ Add a task or type here...</div>`;
    listEl.onclick = (e) => {
      if (e.target.closest('.empty-tasks-hint')) {
        insertCheckboxTask(card, blockKey, '');
      }
    };
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
      <button type="button" class="task-drag-handle" title="Drag to reorder, or click to jump to number (1-${tasks.length})" draggable="true">⠿</button>
      <button type="button" class="task-checkbox-btn ${task.done ? 'checked' : ''}" title="${task.done ? 'Mark active' : 'Mark completed'}">
        <svg class="task-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
      <input type="text" class="task-row-input ${task.done ? 'task-done' : ''}" value="${escapeHtml(task.text)}" placeholder="Task..." spellcheck="false" />
      ${subBadgeHtml}
      <div class="task-move-group">
        <button type="button" class="task-move-btn task-move-up" title="Move task up (Alt+↑)" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="task-move-btn task-move-down" title="Move task down (Alt+↓)" ${idx === tasks.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
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
      if (!e.target.closest('.task-checkbox-btn') && !e.target.closest('.task-row-del') && !e.target.closest('.task-row-lockin') && !e.target.closest('.task-row-add-sub') && !e.target.closest('.task-move-btn') && !e.target.closest('.task-drag-handle')) {
        setActiveTaskSelection(blockKey, idx);
      }
    });

    // Drag Handle & Drag-and-Drop Reordering
    const dragHandle = row.querySelector('.task-drag-handle');
    let isDraggingTask = false;
    if (dragHandle) {
      dragHandle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDraggingTask) return;
        promptMoveTask(blockKey, idx, tasks.length);
      });
      dragHandle.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        isDraggingTask = true;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          type: 'task',
          blockKey: blockKey,
          taskIdx: idx
        }));
      });
      dragHandle.addEventListener('dragend', () => {
        setTimeout(() => { isDraggingTask = false; }, 80);
        row.classList.remove('is-dragging');
        listEl.querySelectorAll('.task-row').forEach(r => {
          r.classList.remove('is-dragging', 'drag-over-top', 'drag-over-bottom');
        });
      });
    }

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const isBottom = relY > (rect.height / 2);
      row.classList.toggle('drag-over-top', !isBottom);
      row.classList.toggle('drag-over-bottom', isBottom);
    });

    row.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over-top', 'drag-over-bottom');
      try {
        const rawData = e.dataTransfer.getData('text/plain');
        if (!rawData) return;
        const data = JSON.parse(rawData);
        if (data.type === 'task') {
          const rect = row.getBoundingClientRect();
          const isBottom = (e.clientY - rect.top) > (rect.height / 2);
          let targetIdx = isBottom ? idx + 1 : idx;

          if (data.blockKey === blockKey) {
            if (data.taskIdx < targetIdx) {
              targetIdx--;
            }
            moveTask(blockKey, data.taskIdx, targetIdx);
          } else {
            moveTaskBetweenBlocks(data.blockKey, data.taskIdx, blockKey, targetIdx);
          }
        }
      } catch (err) {
        console.warn('Drag drop error:', err);
      }
    });

    // Up / Down Button Actions
    const btnUp = row.querySelector('.task-move-up');
    const btnDown = row.querySelector('.task-move-down');
    if (btnUp) {
      btnUp.addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx > 0) {
          moveTask(blockKey, idx, idx - 1);
        }
      });
    }
    if (btnDown) {
      btnDown.addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx < tasks.length - 1) {
          moveTask(blockKey, idx, idx + 1);
        }
      });
    }

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

    // Enter to insert new task below; Tab to add subtask; Backspace on empty to delete; Alt+Up/Down to reorder
    input.addEventListener('keydown', (e) => {
      // Reordering shortcuts: Alt+Up / Alt+Down, Alt+Shift+Up (to top #1), Alt+Shift+Down (to bottom)
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'Up')) {
        e.preventDefault();
        if (e.shiftKey) {
          moveTask(blockKey, idx, 0);
        } else if (idx > 0) {
          moveTask(blockKey, idx, idx - 1);
        }
        return;
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'Down')) {
        e.preventDefault();
        if (e.shiftKey) {
          moveTask(blockKey, idx, tasks.length - 1);
        } else if (idx < tasks.length - 1) {
          moveTask(blockKey, idx, idx + 1);
        }
        return;
      }

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
          <button type="button" class="subtask-drag-handle" title="Drag to reorder, or click to jump to number (1-${task.subtasks.length})" draggable="true">⠿</button>
          <span class="subtask-connector">↳</span>
          <button type="button" class="subtask-checkbox-btn ${sub.done ? 'checked' : ''}" title="${sub.done ? 'Mark active' : 'Mark completed'}">
            <svg class="subtask-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
          <input type="text" class="subtask-row-input ${sub.done ? 'task-done' : ''}" value="${escapeHtml(sub.text)}" placeholder="Subtask..." spellcheck="false" />
          <div class="subtask-move-group">
            <button type="button" class="subtask-move-btn subtask-move-up" title="Move subtask up (Alt+↑)" ${sIdx === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="subtask-move-btn subtask-move-down" title="Move subtask down (Alt+↓)" ${sIdx === task.subtasks.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <button type="button" class="subtask-row-del" title="Delete subtask">×</button>
        `;

        const subInput = subRow.querySelector('.subtask-row-input');
        const subCheck = subRow.querySelector('.subtask-checkbox-btn');
        const subDel = subRow.querySelector('.subtask-row-del');
        const subDrag = subRow.querySelector('.subtask-drag-handle');
        const subBtnUp = subRow.querySelector('.subtask-move-up');
        const subBtnDown = subRow.querySelector('.subtask-move-down');

        // Subtask drag handle & jump prompt
        let isDraggingSub = false;
        if (subDrag) {
          subDrag.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isDraggingSub) return;
            promptMoveSubtask(blockKey, idx, sIdx, task.subtasks.length);
          });
          subDrag.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            isDraggingSub = true;
            subRow.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
              type: 'subtask',
              blockKey: blockKey,
              parentTaskIdx: idx,
              subIdx: sIdx
            }));
          });
          subDrag.addEventListener('dragend', () => {
            setTimeout(() => { isDraggingSub = false; }, 80);
            subRow.classList.remove('is-dragging');
            subtasksTree.querySelectorAll('.subtask-row').forEach(sr => {
              sr.classList.remove('is-dragging', 'drag-over-top', 'drag-over-bottom');
            });
          });
        }

        subRow.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const rect = subRow.getBoundingClientRect();
          const isBottom = (e.clientY - rect.top) > (rect.height / 2);
          subRow.classList.toggle('drag-over-top', !isBottom);
          subRow.classList.toggle('drag-over-bottom', isBottom);
        });

        subRow.addEventListener('dragleave', (e) => {
          e.stopPropagation();
          subRow.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        subRow.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          subRow.classList.remove('drag-over-top', 'drag-over-bottom');
          try {
            const rawData = e.dataTransfer.getData('text/plain');
            if (!rawData) return;
            const data = JSON.parse(rawData);
            if (data.type === 'subtask' && data.blockKey === blockKey && data.parentTaskIdx === idx) {
              const rect = subRow.getBoundingClientRect();
              const isBottom = (e.clientY - rect.top) > (rect.height / 2);
              let targetSubIdx = isBottom ? sIdx + 1 : sIdx;
              if (data.subIdx < targetSubIdx) {
                targetSubIdx--;
              }
              moveSubtask(blockKey, idx, data.subIdx, targetSubIdx);
            }
          } catch (err) {}
        });

        // Subtask Move Buttons
        if (subBtnUp) {
          subBtnUp.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sIdx > 0) moveSubtask(blockKey, idx, sIdx, sIdx - 1);
          });
        }
        if (subBtnDown) {
          subBtnDown.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sIdx < task.subtasks.length - 1) moveSubtask(blockKey, idx, sIdx, sIdx + 1);
          });
        }

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

        // Subtask keyboard navigation: Enter creates next subtask, Backspace on empty deletes, Shift+Tab outdents, Alt+Up/Down reorders
        subInput.addEventListener('keydown', (e) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'Up')) {
            e.preventDefault();
            if (e.shiftKey) {
              moveSubtask(blockKey, idx, sIdx, 0);
            } else if (sIdx > 0) {
              moveSubtask(blockKey, idx, sIdx, sIdx - 1);
            }
            return;
          }
          if (e.altKey && (e.key === 'ArrowDown' || e.key === 'Down')) {
            e.preventDefault();
            if (e.shiftKey) {
              moveSubtask(blockKey, idx, sIdx, task.subtasks.length - 1);
            } else if (sIdx < task.subtasks.length - 1) {
              moveSubtask(blockKey, idx, sIdx, sIdx + 1);
            }
            return;
          }

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
    syncBtn.title = activeSourceDate
      ? `Sync with ${activeSourceDate} (Shortcut: S) — Syncs unfinished tasks and notes seamlessly`
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
          <span class="tab-label">Tasks</span>
          <span class="tab-task-badge" style="display:none;">0</span>
        </button>
        <button type="button" class="tab-btn tab-notes" title="Independent Notes">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          <span class="tab-label">Notes</span>
        </button>
      `;
      const barRight = card.querySelector('.card-bar-right');
      if (barRight) {
        barRight.prepend(tabSwitcher);
      }
    }

    if (!card.dataset.activeTab) {
      card.dataset.activeTab = 'tasks';
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
        updateTrackTitleInLayout(blockKey, titleInput.value);
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

    // 9. Push to Thinking Space Button (💡)
    const btnPushDoc = card.querySelector('.btn-push-to-doc-action');
    if (btnPushDoc) {
      btnPushDoc.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const block = currentDayData[blockKey];
        let textToPush = '';
        if (block) {
          if (block.notes && block.notes.trim()) {
            textToPush += block.notes.trim() + '\n\n';
          }
          if (Array.isArray(block.tasks) && block.tasks.length > 0) {
            textToPush += block.tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
          }
        }
        openPushToThinkingModal(textToPush);
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

  // 3. Render target date: In Tauri desktop app, read strictly from disk!
  if (typeof window.__TAURI__ !== 'undefined') {
    callTauri('get_day', { date: targetDateKey }).then(diskData => {
      if (formatDateKey(currentDate) === targetDateKey) {
        if (diskData && typeof diskData === 'object') {
          currentDayData = normalizeDayData(diskData, targetDateKey);
        } else {
          activeDatesSet.delete(targetDateKey);
          currentDayData = getDefaultDayData(targetDateKey);
        }
        syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
        renderCurrentDay();
        if (currentDayData.importedFrom) {
          quickSync(currentDayData.importedFrom, true);
        }
        checkPendingCarryover(targetDateKey);
      }
    });
    return;
  }

  // Fallback for pure browser mode without native backend
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
  syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
  renderCurrentDay();

  if (currentDayData.importedFrom) {
    quickSync(currentDayData.importedFrom, true);
  }

  checkPendingCarryover(targetDateKey);
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

  const keysToCheck = new Set(ALL_BLOCK_KEYS);
  Object.keys(dayData).forEach(k => {
    if (!['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(k)) {
      keysToCheck.add(k);
    }
  });
  if (dayData.customLayout) {
    try {
      const tracks = getAllLayoutTracks(dayData.customLayout);
      tracks.forEach(t => { if (t && t.key) keysToCheck.add(t.key); });
    } catch (e) { }
  }

  for (const k of keysToCheck) {
    const rawBlock = dayData[k];
    if (!rawBlock) continue;
    const block = normalizeBlockData(rawBlock, rawBlock.title || getDefaultTitle(k));

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

  // Deduplicate against current target day's existing tasks across matching block or all blocks
  const pendingTasks = analysis.unfinishedTasks.filter(item => {
    const currentBlock = currentDayData[item.blockKey];
    if (currentBlock && Array.isArray(currentBlock.tasks)) {
      if (currentBlock.tasks.some(t => t && t.text && t.text.trim().toLowerCase() === item.text.toLowerCase())) return false;
    }
    for (const curKey of Object.keys(currentDayData)) {
      if (['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(curKey)) continue;
      const b = currentDayData[curKey];
      if (b && Array.isArray(b.tasks)) {
        if (b.tasks.some(t => t && t.text && t.text.trim().toLowerCase() === item.text.toLowerCase())) {
          return false;
        }
      }
    }
    return true;
  });

  // Check if any finished tasks from source day are lingering as active in today
  const tasksToClear = [];
  if (analysis.finishedTasks && Array.isArray(analysis.finishedTasks)) {
    analysis.finishedTasks.forEach(item => {
      for (const curKey of Object.keys(currentDayData)) {
        if (['date', 'updatedAt', 'importedFrom', 'importedAt', 'customLayout'].includes(curKey)) continue;
        const curBlock = currentDayData[curKey];
        if (curBlock && Array.isArray(curBlock.tasks)) {
          if (curBlock.tasks.some(t => t && t.text && t.text.trim().toLowerCase() === item.text.toLowerCase() && !t.done)) {
            tasksToClear.push(item);
          }
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
  let srcData = null;
  if (sourceDateKey) {
    try {
      srcData = await loadDay(sourceDateKey);
      if (srcData) {
        const srcKeys = getAllBlockKeysBetween(srcData, currentDayData);
        for (const k of srcKeys) {
          if (srcData[k] && Array.isArray(srcData[k].tasks)) {
            srcData[k].tasks.forEach(t => {
              if (t && typeof t.text === 'string' && t.text.trim()) {
                sourceTaskSet.add(t.text.trim().toLowerCase());
              }
            });
          }
        }
      }
    } catch (e) {
      console.warn("Could not load source day for removeImport verification:", e);
    }
  }

  const allKeys = getAllBlockKeysBetween(srcData, currentDayData);
  for (const blockKey of allKeys) {
    const curBlock = currentDayData[blockKey];
    if (curBlock && Array.isArray(curBlock.tasks)) {
      const remaining = [];
      for (const t of curBlock.tasks) {
        if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
        const textKey = t.text.trim().toLowerCase();
        const isImported = (t.importedFrom && (t.importedFrom === sourceDateKey || !sourceDateKey)) ||
          (sourceDateKey && sourceTaskSet.has(textKey));

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
  syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
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
    // 1. Determine source date
    let sourceDateKey = preferredSourceDate;

    if (!sourceDateKey) {
      const latestActive = await findLatestActiveDayBefore(targetDateKey);
      if (latestActive) {
        sourceDateKey = latestActive.dateKey;
      } else if (currentDayData.importedFrom && currentDayData.importedFrom < targetDateKey) {
        sourceDateKey = currentDayData.importedFrom;
      } else {
        const [y, m, d] = targetDateKey.split('-').map(Number);
        const targetDateObj = new Date(y, m - 1, d);
        const yestDateObj = new Date(targetDateObj);
        yestDateObj.setDate(yestDateObj.getDate() - 1);
        sourceDateKey = formatDateKey(yestDateObj);
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

    // Inherit layout if target day has an empty layout (blank canvas) and source has customLayout
    const curLayout = getLayoutForDate(targetDateKey, currentDayData);
    const curRows = normalizeLayoutPageRows(curLayout);
    const srcRows = sourceData.customLayout ? normalizeLayoutPageRows(sourceData.customLayout) : [];

    if (curRows.length === 0 && srcRows.length > 0) {
      currentDayData.customLayout = JSON.parse(JSON.stringify(sourceData.customLayout));
      safeStorage.setItem(`mrt_layout_${targetDateKey}`, JSON.stringify(currentDayData.customLayout));
      syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
    }

    // Store pre-sync backup snapshot so accidental sync can be undone
    safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));

    // 3. Reconcile with current target day
    let clearedCount = 0;
    let addedCount = 0;
    let updatedCount = 0;
    let inheritedNotesCount = 0;
    let preservedCustomCount = 0;

    const allKeys = getAllBlockKeysBetween(sourceData, currentDayData);

    for (const blockKey of allKeys) {
      if (!currentDayData[blockKey]) {
        currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
      }
      const curBlock = currentDayData[blockKey];
      if (!Array.isArray(curBlock.tasks)) curBlock.tasks = [];

      const matchResult = findMatchingSourceBlock(sourceData, blockKey, curBlock);
      if (!matchResult || !matchResult.block) {
        preservedCustomCount += curBlock.tasks.filter(t => t && typeof t.text === 'string' && t.text.trim().length > 0).length;
        continue;
      }

      const { key: srcKey, block: srcRawBlock } = matchResult;
      const srcBlock = normalizeBlockData(srcRawBlock, srcRawBlock.title || getDefaultTitle(srcKey));

      // Inherit notes if today has none
      if ((!curBlock.notes || !curBlock.notes.trim()) && srcBlock.notes && srcBlock.notes.trim()) {
        curBlock.notes = srcBlock.notes.trim();
        inheritedNotesCount++;
      }

      // Check tasks on source
      const srcFinished = (srcBlock.tasks || []).filter(t => t && isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);
      const srcUnfinished = (srcBlock.tasks || []).filter(t => t && !isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);

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
          let modified = false;
          if (uTask.notes && existing.notes !== uTask.notes && (!existing.notes || !existing.notes.trim())) {
            existing.notes = uTask.notes;
            modified = true;
          }
          if (Array.isArray(uTask.subtasks) && uTask.subtasks.length > 0 && (!Array.isArray(existing.subtasks) || existing.subtasks.length === 0)) {
            existing.subtasks = JSON.parse(JSON.stringify(uTask.subtasks));
            modified = true;
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
        const existsInSrc = (srcBlock.tasks || []).some(st => st && typeof st.text === 'string' && st.text.trim().toLowerCase() === t.text.trim().toLowerCase());
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

    syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
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
    if (inheritedNotesCount > 0) parts.push(`${inheritedNotesCount} note${inheritedNotesCount > 1 ? 's' : ''} inherited`);
    if (preservedCustomCount > 0) parts.push(`${preservedCustomCount} custom today task${preservedCustomCount > 1 ? 's' : ''} kept`);

    if (clearedCount === 0 && addedCount === 0 && updatedCount === 0 && inheritedNotesCount === 0) {
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
      const isInToday = Object.values(currentDayData).some(b => {
        if (!b || typeof b !== 'object' || !Array.isArray(b.tasks)) return false;
        return b.tasks.some(t => t && typeof t.text === 'string' && t.text.trim().toLowerCase() === item.text.toLowerCase());
      });
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

    // Inherit layout if target day has an empty layout (blank canvas) and source has customLayout
    const curLayout = getLayoutForDate(targetDateKey, currentDayData);
    const curRows = normalizeLayoutPageRows(curLayout);
    const srcRows = sourceData.customLayout ? normalizeLayoutPageRows(sourceData.customLayout) : [];

    if (curRows.length === 0 && srcRows.length > 0) {
      currentDayData.customLayout = JSON.parse(JSON.stringify(sourceData.customLayout));
      safeStorage.setItem(`mrt_layout_${targetDateKey}`, JSON.stringify(currentDayData.customLayout));
      syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
    }

    // Store backup snapshot before importing so user can redo/undo
    safeStorage.setItem(`mrt_pre_import_${targetDateKey}`, JSON.stringify(currentDayData));

    let importedTasksCount = 0;
    let removedFinishedCount = 0;
    let updatedTasksCount = 0;
    let inheritedNotesCount = 0;
    let updatedTitlesCount = 0;
    let preservedCustomCount = 0;

    const allKeys = getAllBlockKeysBetween(sourceData, currentDayData);

    for (const blockKey of allKeys) {
      if (!currentDayData[blockKey]) {
        currentDayData[blockKey] = getDefaultBlockData(getDefaultTitle(blockKey));
      }
      const currentBlock = currentDayData[blockKey];
      if (!Array.isArray(currentBlock.tasks)) currentBlock.tasks = [];

      const matchResult = findMatchingSourceBlock(sourceData, blockKey, currentBlock);
      if (!matchResult || !matchResult.block) continue;

      const { key: srcKey, block: srcRawBlock } = matchResult;
      const sourceBlock = normalizeBlockData(srcRawBlock, srcRawBlock.title || getDefaultTitle(srcKey));

      // 1. Inherit Custom Block Titles
      if (options.titles && sourceBlock.title) {
        const defTitle = getDefaultTitle(blockKey);
        if (sourceBlock.title !== defTitle && currentBlock.title === defTitle && !isGenericBlockTitle(sourceBlock.title)) {
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
        // A. Finished Tasks on Source Day:
        const finishedOnSource = sourceBlock.tasks.filter(t => t && isTaskDone(t) && typeof t.text === 'string' && t.text.trim().length > 0);
        finishedOnSource.forEach(finishedTask => {
          const textKey = finishedTask.text.trim().toLowerCase();
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
            currentBlock.tasks.push({
              text: taskText,
              done: false,
              notes: srcTask.notes || '',
              subtasks: Array.isArray(srcTask.subtasks) ? JSON.parse(JSON.stringify(srcTask.subtasks)) : [],
              importedFrom: sourceDateKey
            });
            importedTasksCount++;
          } else if (!existingTask.done) {
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

    syncWorkspaceLayoutForDate(targetDateKey, currentDayData);
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
// Dynamic Section Focus & Compatibility Controller
// ==========================================================================

function setPhase(phase, notify = true) {
  setSectionFocus(phase, notify);
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
    const pageRows = normalizeLayoutPageRows(layout);
    for (const prow of pageRows) {
      for (const sec of (prow.sections || [])) {
        const subRows = getSectionSubRows(sec);
        for (const sub of subRows) {
          if ((sub.tracks || []).some(t => t.key === blockKey)) {
            return `${sec.title}${sec.timeRange ? ' (' + sec.timeRange + ')' : ''}`;
          }
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

  // 3. Fallback to candidate blocks from active section or all sections in layout
  let candidateKeys = [];
  try {
    const dateKey = formatDateKey(currentDate);
    const activeLayout = getLayoutForDate(dateKey, currentDayData);
    if (currentSectionFocus && currentSectionFocus !== 'all') {
      const sections = getAllLayoutSections(activeLayout);
      const focusedSec = sections.find(s => s.id === currentSectionFocus);
      if (focusedSec) {
        for (const sub of getSectionSubRows(focusedSec)) {
          for (const tr of (sub.tracks || [])) {
            if (tr.key) candidateKeys.push(tr.key);
          }
        }
      }
    }
    if (candidateKeys.length === 0) {
      const allTracks = getAllLayoutTracks(activeLayout);
      candidateKeys = allTracks.map(t => t.key).filter(Boolean);
    }
  } catch (e) {
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
    let md = `# Manas Daily Planner — ${formatDateDisplay(currentDate)}\n\n`;

    const activeLayout = getActiveLayout();
    const pageRows = normalizeLayoutPageRows(activeLayout);
    if (pageRows.length === 0) {
      md += `*Blank Canvas — No page rows or columns configured for this date.*\n\n`;
    } else {
      pageRows.forEach((prow, rIdx) => {
        md += `## ${prow.title || ('PAGE ROW ' + (rIdx + 1))}\n\n`;
        (prow.sections || []).forEach(sec => {
          md += `### ${sec.title}${sec.timeRange ? ' (' + sec.timeRange + ')' : ''}\n\n`;
          const subRows = getSectionSubRows(sec);
          subRows.forEach(sub => {
            if (sub.title) md += `#### ${sub.title}\n\n`;
            (sub.tracks || []).forEach(track => {
              const b = currentDayData ? currentDayData[track.key] : null;
              md += `##### ${b?.title || track.title}\n${b?.content || ''}\n\n`;
            });
          });
        });
      });
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `manas_${dateKey}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported manas_${dateKey}.md`);
  });
}

// Open Data Folder Button
if (btnOpenFolder) {
  btnOpenFolder.addEventListener('click', async () => {
    const res = await callTauri('open_data_folder');
    const folder = res || activeStoragePath;
    if (folder) {
      showToast(`Opened: ${folder}`);
    } else {
      showToast("Opened data folder");
    }
  });
}

// Click footer storage path to open folder directly
if (footerStoragePath) {
  footerStoragePath.style.cursor = 'pointer';
  footerStoragePath.addEventListener('click', async () => {
    const res = await callTauri('open_data_folder');
    const folder = res || activeStoragePath;
    if (folder) {
      showToast(`Opened: ${folder}`);
    } else {
      showToast("Opened data folder");
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
    saveAndApplyLayoutForToday(PRESETS.blank_canvas);
    closeCustomizeModal();
    showToast(`Reset to Blank Canvas for ${formatDateDisplay(currentDate)}`);
  });
}
if (btnSaveCustomLayout) {
  btnSaveCustomLayout.addEventListener('click', () => {
    if (currentEditingLayout) {
      saveAndApplyLayoutForToday(currentEditingLayout);
      closeCustomizeModal();
      showToast(`Workflow layout saved for ${formatDateDisplay(currentDate)}!`);
    }
  });
}
function addPhaseToModal(orientation = 'vertical') {
  if (!currentEditingLayout) currentEditingLayout = JSON.parse(JSON.stringify(getActiveLayout()));
  if (!Array.isArray(currentEditingLayout.phases)) currentEditingLayout.phases = [];
  const pIdx = currentEditingLayout.phases.length + 1;
  const isHoriz = (orientation === 'horizontal');
  currentEditingLayout.phases.push({
    id: `phase_custom_${Date.now()}`,
    title: isHoriz ? `Row Section ${pIdx}` : `Column Section ${pIdx}`,
    timeRange: "",
    orientation: isHoriz ? 'horizontal' : 'vertical',
    colorClass: pIdx % 2 === 0 ? "violet" : "cyan",
    rows: [] // Starts 100% blank without dummy tracks!
  });
  currentEditingLayout.id = 'custom';
  renderPresetCards();
  renderPhaseCustomizer();
}

const btnAddVertPhase = document.getElementById('btn-add-vertical-phase');
if (btnAddVertPhase) {
  btnAddVertPhase.addEventListener('click', () => addPhaseToModal('vertical'));
}
const btnAddHorizPhase = document.getElementById('btn-add-horizontal-phase');
if (btnAddHorizPhase) {
  btnAddHorizPhase.addEventListener('click', () => addPhaseToModal('horizontal'));
}
if (btnAddNewPhase) {
  btnAddNewPhase.addEventListener('click', () => addPhaseToModal('vertical'));
}
if (customizeLayoutModal) {
  customizeLayoutModal.addEventListener('click', (e) => {
    if (e.target === customizeLayoutModal) closeCustomizeModal();
  });
}

// Phase ribbon clicks are dynamically handled by delegated listener above

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
  } else if (e.key === '0') {
    e.preventDefault();
    setSectionFocus('all');
  } else if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(e.key)) {
    const keyNum = parseInt(e.key, 10);
    const dateKey = formatDateKey(currentDate);
    const layout = getLayoutForDate(dateKey, currentDayData);
    const sections = getAllLayoutSections(layout);
    if (sections[keyNum - 1]) {
      e.preventDefault();
      setSectionFocus(sections[keyNum - 1].id);
    }
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

  // In desktop app, purge any legacy localStorage day keys so disk is the sole source of truth
  const isDesktop = typeof window.__TAURI__ !== 'undefined';
  if (isDesktop) {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('mrt_20') || k.startsWith('mrt_active_dates'))) {
          localStorage.removeItem(k);
        }
      }
    } catch (e) { }
    currentDayData = getDefaultDayData(dateKey);
  } else {
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
  }
  syncWorkspaceLayoutForDate(dateKey, currentDayData);
  renderCurrentDay();

  // Apply Dynamic Section Focus
  setSectionFocus(currentSectionFocus || 'all', false);

  // Check pending carryover for today
  checkPendingCarryover(dateKey);

  // 4. Background non-blocking sync with native disk
  callTauri('get_day', { date: dateKey }).then(diskData => {
    if (formatDateKey(currentDate) === dateKey) {
      if (diskData && typeof diskData === 'object') {
        const diskTime = new Date(diskData.updatedAt || 0).getTime();
        const curTime = new Date(currentDayData.updatedAt || 0).getTime();
        if (diskTime > curTime) {
          currentDayData = normalizeDayData(diskData, dateKey);
          syncWorkspaceLayoutForDate(dateKey, currentDayData);
          renderCurrentDay();
          checkPendingCarryover(dateKey);
        }
      } else if (typeof window.__TAURI__ !== 'undefined' && !diskData) {
        safeStorage.removeItem(`mrt_${dateKey}`);
        activeDatesSet.delete(dateKey);
        currentDayData = getDefaultDayData(dateKey);
        syncWorkspaceLayoutForDate(dateKey, currentDayData);
        renderCurrentDay();
      }
    }
  });

  // 5. Query active dates & storage directory in background
  callTauri('get_data_folder_path').then(folderPath => {
    if (folderPath) {
      activeStoragePath = folderPath;
      if (footerStoragePath) {
        footerStoragePath.textContent = `Storage: ${folderPath}`;
        footerStoragePath.title = `Click to open ${folderPath}`;
      }
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

  // 6. Load saved templates from disk in background
  loadTemplatesFromDisk().then(templates => {
    if (Array.isArray(templates)) {
      const activeLayout = getActiveLayout();
      syncLevel1Bar(activeLayout);
    }
  });

  // 7. Initialize Dual-Space & Thinking Studio
  initDualSpaceAndThinkingStudio();
}

// ==========================================================================
// DUAL-SPACE & THINKING SPACE STUDIO MODULE
// ==========================================================================

let currentAppMode = 'planner'; // 'planner' | 'thinking'
let activeDocsList = [];
let currentOpenDocPath = null;
let currentOpenDocContent = '';
let docAutoSaveTimer = null;
let currentThinkingView = 'edit'; // 'edit' | 'split' | 'preview'
let docsFolderPath = '';
const docAssetCache = new Map();

function switchAppMode(mode) {
  if (mode === currentAppMode) return;
  currentAppMode = mode;

  const btnPlanner = document.getElementById('btn-mode-planner');
  const btnThinking = document.getElementById('btn-mode-thinking');
  const plannerWs = document.querySelector('.planner-workspace');
  const thinkingWs = document.getElementById('thinking-workspace');
  const phaseRibbon = document.getElementById('phase-ribbon');
  const dateNavPill = document.querySelector('.date-navigator-pill');

  if (mode === 'planner') {
    btnPlanner?.classList.add('active');
    btnThinking?.classList.remove('active');
    if (plannerWs) plannerWs.style.display = 'flex';
    if (thinkingWs) thinkingWs.style.display = 'none';
    if (phaseRibbon) phaseRibbon.style.display = 'flex';
    if (dateNavPill) dateNavPill.style.visibility = 'visible';

    if (footerStoragePath) {
      footerStoragePath.textContent = `Storage: ${activeStoragePath || '~/.local/share/manas/entries'}`;
      footerStoragePath.title = "Click to open entries folder";
    }
  } else {
    btnThinking?.classList.add('active');
    btnPlanner?.classList.remove('active');
    if (plannerWs) plannerWs.style.display = 'none';
    if (thinkingWs) thinkingWs.style.display = 'flex';
    if (phaseRibbon) phaseRibbon.style.display = 'none';

    if (footerStoragePath) {
      footerStoragePath.textContent = `Storage: ${docsFolderPath || '~/.local/share/manas/docs'}`;
      footerStoragePath.title = "Click to open docs folder";
    }

    loadThinkingDocs();
  }
}

async function loadThinkingDocs(autoOpenFirst = true) {
  try {
    const docs = await callTauri('list_docs');
    if (Array.isArray(docs)) {
      activeDocsList = docs;
      renderDocsTree(docs);

      if (autoOpenFirst && (!currentOpenDocPath || !findDocByPath(docs, currentOpenDocPath))) {
        const firstDoc = getFirstDocItem(docs);
        if (firstDoc) {
          openThinkingDoc(firstDoc.path);
        }
      }
    }
  } catch (err) {
    console.warn("Failed to load thinking docs:", err);
  }
}

function getFirstDocItem(items) {
  for (const item of items) {
    if (!item.is_dir) return item;
    if (item.children && item.children.length > 0) {
      const found = getFirstDocItem(item.children);
      if (found) return found;
    }
  }
  return null;
}

function findDocByPath(items, path) {
  for (const item of items) {
    if (item.path === path) return item;
    if (item.children && item.children.length > 0) {
      const found = findDocByPath(item.children, path);
      if (found) return found;
    }
  }
  return null;
}

function renderDocsTree(items, filter = '') {
  const container = document.getElementById('thinking-tree-container');
  if (!container) return;
  container.innerHTML = '';

  const filterLower = filter.trim().toLowerCase();

  function buildTreeHTML(list, depth = 0) {
    const frag = document.createDocumentFragment();

    list.forEach(item => {
      if (item.is_dir) {
        const folderEl = document.createElement('div');
        folderEl.className = 'thinking-folder-group';

        const headerEl = document.createElement('div');
        headerEl.className = 'thinking-folder-header';
        headerEl.innerHTML = `
          <span class="thinking-folder-toggle">▼</span>
          <span class="thinking-folder-icon">📁</span>
          <span class="thinking-folder-name">${escapeHTML(item.name)}</span>
          <span class="thinking-folder-count">${item.children?.length || 0}</span>
        `;

        const childrenEl = document.createElement('div');
        childrenEl.className = 'thinking-folder-children';

        headerEl.addEventListener('click', () => {
          const isCollapsed = childrenEl.style.display === 'none';
          childrenEl.style.display = isCollapsed ? 'flex' : 'none';
          const toggle = headerEl.querySelector('.thinking-folder-toggle');
          if (toggle) toggle.textContent = isCollapsed ? '▼' : '▶';
        });

        if (item.children && item.children.length > 0) {
          childrenEl.appendChild(buildTreeHTML(item.children, depth + 1));
        }

        folderEl.appendChild(headerEl);
        folderEl.appendChild(childrenEl);
        frag.appendChild(folderEl);
      } else {
        if (filterLower && !item.name.toLowerCase().includes(filterLower)) {
          return;
        }

        const docEl = document.createElement('div');
        docEl.className = `thinking-doc-item ${item.path === currentOpenDocPath ? 'active' : ''}`;
        const cleanName = item.name.replace(/\.(md|markdown|txt)$/i, '');

        docEl.innerHTML = `
          <span class="thinking-doc-icon">📄</span>
          <span class="thinking-doc-name" title="${escapeHTML(item.path)}">${escapeHTML(cleanName)}</span>
          <div class="thinking-doc-item-actions">
            <button class="thinking-doc-del-btn" title="Delete document">✕</button>
          </div>
        `;

        docEl.addEventListener('click', (e) => {
          if (e.target.closest('.thinking-doc-del-btn')) return;
          openThinkingDoc(item.path);
        });

        const delBtn = docEl.querySelector('.thinking-doc-del-btn');
        delBtn?.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Delete '${item.name}'?`)) {
            await callTauri('delete_doc', { path: item.path });
            if (currentOpenDocPath === item.path) {
              currentOpenDocPath = null;
            }
            await loadThinkingDocs(true);
            showToast(`Deleted ${item.name}`);
          }
        });

        frag.appendChild(docEl);
      }
    });

    return frag;
  }

  container.appendChild(buildTreeHTML(items));
}

async function openThinkingDoc(relPath) {
  try {
    currentOpenDocPath = relPath;
    const content = await callTauri('read_doc', { path: relPath });
    currentOpenDocContent = content !== null ? content : '';

    const textarea = document.getElementById('thinking-editor-textarea');
    if (textarea) {
      textarea.value = currentOpenDocContent;
    }

    const titleInput = document.getElementById('thinking-doc-title-input');
    const breadcrumb = document.getElementById('thinking-doc-breadcrumb');

    const parts = relPath.split('/');
    const fileName = parts.pop().replace(/\.(md|markdown|txt)$/i, '');
    const folderName = parts.length > 0 ? parts.join(' / ') : 'Root';

    if (titleInput) titleInput.value = fileName;
    if (breadcrumb) breadcrumb.textContent = folderName;

    // Highlight active in tree
    document.querySelectorAll('.thinking-doc-item').forEach(el => {
      const nameEl = el.querySelector('.thinking-doc-name');
      if (nameEl && nameEl.getAttribute('title') === relPath) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    updateEditorStats();
    renderThinkingPreview();
  } catch (err) {
    console.warn("Error opening document:", err);
    showToast("Error opening document");
  }
}

function updateEditorStats() {
  const textarea = document.getElementById('thinking-editor-textarea');
  if (!textarea) return;
  const text = textarea.value.trim();

  const words = text ? text.split(/\s+/).length : 0;
  const chars = textarea.value.length;
  const minutes = Math.ceil(words / 200);

  const wordEl = document.getElementById('thinking-stat-words');
  const charEl = document.getElementById('thinking-stat-chars');
  const timeEl = document.getElementById('thinking-stat-time');

  if (wordEl) wordEl.textContent = `${words} word${words === 1 ? '' : 's'}`;
  if (charEl) charEl.textContent = `${chars} char${chars === 1 ? '' : 's'}`;
  if (timeEl) timeEl.textContent = `~${minutes} min read`;
}

function queueAutoSaveDoc() {
  const saveInd = document.getElementById('thinking-save-indicator');
  if (saveInd) {
    saveInd.textContent = "Saving...";
    saveInd.style.color = "var(--text-dim)";
  }

  updateEditorStats();

  clearTimeout(docAutoSaveTimer);
  docAutoSaveTimer = setTimeout(async () => {
    if (!currentOpenDocPath) return;
    const textarea = document.getElementById('thinking-editor-textarea');
    if (!textarea) return;

    currentOpenDocContent = textarea.value;
    await callTauri('save_doc', {
      path: currentOpenDocPath,
      content: currentOpenDocContent
    });

    if (saveInd) {
      saveInd.textContent = "Saved";
      saveInd.style.color = "var(--accent-emerald)";
    }
    renderThinkingPreview();
  }, 400);
}

function renderThinkingPreview() {
  const previewContent = document.getElementById('thinking-preview-content');
  if (!previewContent) return;

  const text = currentOpenDocContent || '';
  previewContent.innerHTML = parseMarkdownToHTML(text);

  // Wire up interactive checklist items inside preview
  previewContent.querySelectorAll('.preview-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const lineIdx = parseInt(e.target.dataset.lineIndex, 10);
      toggleMarkdownChecklistLine(lineIdx, e.target.checked);
    });
  });

  // Asynchronously resolve local doc assets (e.g. pasted screenshots, KiCad snips)
  previewContent.querySelectorAll('img[data-asset-src]').forEach(async (img) => {
    const rawSrc = img.getAttribute('data-asset-src') || '';
    if (rawSrc.startsWith('data:') || rawSrc.startsWith('http://') || rawSrc.startsWith('https://')) {
      return;
    }
    const parts = (currentOpenDocPath || '').split('/');
    parts.pop();
    const folder = parts.join('/');
    const filename = rawSrc.replace(/^assets\//, '').replace(/^\.\//, '');
    const cacheKey = `${folder}:${filename}`;

    if (docAssetCache.has(cacheKey)) {
      img.src = docAssetCache.get(cacheKey);
    } else {
      try {
        const dataUri = await callTauri('read_doc_asset', { folder, filename });
        if (dataUri) {
          docAssetCache.set(cacheKey, dataUri);
          img.src = dataUri;
        }
      } catch (err) {
        // file not yet written or path invalid
      }
    }
  });
}

function toggleMarkdownChecklistLine(targetLineIdx, isChecked) {
  const textarea = document.getElementById('thinking-editor-textarea');
  if (!textarea) return;

  const lines = textarea.value.split('\n');
  let currentCheckboxIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s*\[([ xX])\]\s+/.test(line)) {
      if (currentCheckboxIdx === targetLineIdx) {
        lines[i] = line.replace(/^(\s*-\s*\[)([ xX])(\]\s+)/, `$1${isChecked ? 'x' : ' '}$3`);
        break;
      }
      currentCheckboxIdx++;
    }
  }

  textarea.value = lines.join('\n');
  currentOpenDocContent = textarea.value;
  queueAutoSaveDoc();
}

function formatMathExpression(expr) {
  let out = escapeHTML(expr);
  const symbols = [
    [/\\tau/g, 'τ'], [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'],
    [/\\delta/g, 'δ'], [/\\epsilon/g, 'ε'], [/\\theta/g, 'θ'], [/\\lambda/g, 'λ'],
    [/\\mu/g, 'μ'], [/\\pi/g, 'π'], [/\\rho/g, 'ρ'], [/\\sigma/g, 'σ'],
    [/\\phi/g, 'ϕ'], [/\\omega/g, 'ω'], [/\\Delta/g, 'Δ'], [/\\Omega/g, 'Ω'],
    [/\\nabla/g, '∇'], [/\\partial/g, '∂'], [/\\times/g, '×'], [/\\cdot/g, '·'],
    [/\\div/g, '÷'], [/\\approx/g, '≈'], [/\\neq/g, '≠'], [/\\le(q)?/g, '≤'],
    [/\\ge(q)?/g, '≥'], [/\\pm/g, '±'], [/\\int/g, '∫'], [/\\sum/g, '∑'],
    [/\\infty/g, '∞'], [/\\sqrt\{([^}]+)\}/g, '√($1)'], [/\\sqrt/g, '√'],
    [/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)'],
    [/\\mathcal\{L\}/g, 'ℒ'], [/\\parallel/g, '∥'],
    [/\\text\{([^}]+)\}/g, '$1']
  ];
  for (const [pattern, rep] of symbols) {
    out = out.replace(pattern, rep);
  }
  return out;
}

function parseMarkdownToHTML(md) {
  if (!md) return '<p class="text-dim">Empty document.</p>';

  const lines = md.split('\n');
  let html = '';
  let inCodeBlock = false;
  let codeLang = '';
  let codeBuffer = [];
  let inMathBlock = false;
  let mathBuffer = [];
  let inTable = false;
  let tableRows = [];
  let checkboxCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Math Block delimiter: $$
    if (line.trim().startsWith('$$')) {
      if (inMathBlock) {
        inMathBlock = false;
        html += `<div class="math-block">${formatMathExpression(mathBuffer.join('\n'))}</div>`;
        mathBuffer = [];
        continue;
      } else if (line.trim() === '$$') {
        inMathBlock = true;
        mathBuffer = [];
        continue;
      } else {
        const mathContent = line.trim().replace(/^\$\$\s*/, '').replace(/\s*\$\$$/, '');
        html += `<div class="math-block">${formatMathExpression(mathContent)}</div>`;
        continue;
      }
    }

    if (inMathBlock) {
      mathBuffer.push(line);
      continue;
    }

    // Code Block delimiter: ```
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        const codeText = escapeHTML(codeBuffer.join('\n'));
        html += `
          <div class="code-block-box">
            <div class="code-block-header">
              <span>${codeLang || 'CODE'}</span>
              <button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.innerText); showToast('Copied to clipboard');">Copy</button>
            </div>
            <pre class="code-block-body"><code>${codeText}</code></pre>
          </div>
        `;
        codeBuffer = [];
        codeLang = '';
        continue;
      } else {
        inCodeBlock = true;
        codeLang = line.trim().replace(/^```/, '').trim();
        codeBuffer = [];
        continue;
      }
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Tables
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      inTable = true;
      tableRows.push(line.trim());
      continue;
    } else if (inTable) {
      inTable = false;
      html += renderTableHTML(tableRows);
      tableRows = [];
    }

    // Headers
    if (line.startsWith('# ')) {
      html += `<h1>${inlineFormat(line.slice(2))}</h1>`;
      continue;
    }
    if (line.startsWith('## ')) {
      html += `<h2>${inlineFormat(line.slice(3))}</h2>`;
      continue;
    }
    if (line.startsWith('### ')) {
      html += `<h3>${inlineFormat(line.slice(4))}</h3>`;
      continue;
    }
    if (line.startsWith('#### ')) {
      html += `<h4>${inlineFormat(line.slice(5))}</h4>`;
      continue;
    }

    // Checklists: - [ ] or - [x]
    const checkMatch = line.match(/^\s*-\s*\[([ xX])\]\s+(.*)$/);
    if (checkMatch) {
      const isChecked = checkMatch[1].toLowerCase() === 'x';
      const text = checkMatch[2];
      html += `
        <div class="preview-checklist-item">
          <input type="checkbox" class="preview-checkbox" ${isChecked ? 'checked' : ''} data-line-index="${checkboxCount}" />
          <span class="preview-checklist-text ${isChecked ? 'checked' : ''}">${inlineFormat(text)}</span>
        </div>
      `;
      checkboxCount++;
      continue;
    }

    // Regular list: - or *
    if (/^\s*[-*]\s+/.test(line)) {
      html += `<ul><li>${inlineFormat(line.replace(/^\s*[-*]\s+/, ''))}</li></ul>`;
      continue;
    }

    // Blockquotes: >
    if (line.startsWith('>')) {
      html += `<blockquote>${inlineFormat(line.slice(1).trim())}</blockquote>`;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      continue;
    }

    // Standard paragraph
    html += `<p>${inlineFormat(line)}</p>`;
  }

  if (inTable && tableRows.length > 0) {
    html += renderTableHTML(tableRows);
  }

  return html;
}

function renderTableHTML(rows) {
  if (rows.length === 0) return '';
  let out = '<table class="thinking-table">';
  let isHeader = true;

  rows.forEach((row, idx) => {
    if (/^\|[\s:-|]+\|$/.test(row)) {
      isHeader = false;
      return;
    }
    const cols = row.split('|').slice(1, -1);
    out += '<tr>';
    cols.forEach(col => {
      const tag = isHeader && idx === 0 ? 'th' : 'td';
      out += `<${tag}>${inlineFormat(col.trim())}</${tag}>`;
    });
    out += '</tr>';
  });

  out += '</table>';
  return out;
}

function inlineFormat(str) {
  let s = escapeHTML(str);
  // Images: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    return `<div class="thinking-doc-img-wrapper"><img src="${src}" data-asset-src="${src}" class="thinking-doc-img" alt="${alt}" loading="lazy" /><span class="thinking-doc-img-caption">${alt || 'Image'}</span></div>`;
  });
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Math: $expr$
  s = s.replace(/\$([^\$\n]+)\$/g, (m, g1) => `<span class="math-inline">${formatMathExpression(g1)}</span>`);
  // Bold & Italic & Code
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function applyMarkdownFormatting(action) {
  const textarea = document.getElementById('thinking-editor-textarea');
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const sel = textarea.value.substring(start, end);

  let replacement = '';
  let cursorOffset = 0;

  switch (action) {
    case 'bold':
      replacement = `**${sel || 'bold text'}**`;
      cursorOffset = sel ? replacement.length : 2;
      break;
    case 'italic':
      replacement = `*${sel || 'italic text'}*`;
      cursorOffset = sel ? replacement.length : 1;
      break;
    case 'h2':
      replacement = `\n## ${sel || 'Section Heading'}\n`;
      cursorOffset = replacement.length;
      break;
    case 'h3':
      replacement = `\n### ${sel || 'Subheading'}\n`;
      cursorOffset = replacement.length;
      break;
    case 'math-inline':
      replacement = `$${sel || 'x = y + z'}$`;
      cursorOffset = sel ? replacement.length : 1;
      break;
    case 'math-block':
      replacement = `\n$$\n${sel || '\\tau = F \\times r'}\n$$\n`;
      cursorOffset = replacement.length;
      break;
    case 'code':
      replacement = `\n\`\`\`python\n${sel || '# write code or pseudocode here'}\n\`\`\`\n`;
      cursorOffset = replacement.length;
      break;
    case 'check':
      replacement = `\n- [ ] ${sel || 'Action item'}`;
      cursorOffset = replacement.length;
      break;
    case 'table':
      replacement = `\n| Parameter | Value | Unit | Notes |\n| :--- | :--- | :--- | :--- |\n| Voltage | 3.3 | V | Nominal |\n| Current | 240 | mA | Peak burst |\n`;
      cursorOffset = replacement.length;
      break;
  }

  textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + (sel ? replacement.length : cursorOffset);

  currentOpenDocContent = textarea.value;
  queueAutoSaveDoc();
  updateEditorStats();
}

function setThinkingView(view) {
  currentThinkingView = view;
  const editorPane = document.getElementById('thinking-editor-pane');
  const previewPane = document.getElementById('thinking-preview-pane');

  document.querySelectorAll('.thinking-toggle-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`btn-thinking-view-${view}`)?.classList.add('active');

  if (view === 'edit') {
    if (editorPane) editorPane.style.display = 'flex';
    if (previewPane) previewPane.style.display = 'none';
  } else if (view === 'split') {
    if (editorPane) editorPane.style.display = 'flex';
    if (previewPane) previewPane.style.display = 'block';
    renderThinkingPreview();
  } else if (view === 'preview') {
    if (editorPane) editorPane.style.display = 'none';
    if (previewPane) previewPane.style.display = 'block';
    renderThinkingPreview();
  }
}

// Initializing All Thinking Studio Events & Bridge
function initDualSpaceAndThinkingStudio() {
  const btnModePlanner = document.getElementById('btn-mode-planner');
  const btnModeThinking = document.getElementById('btn-mode-thinking');

  btnModePlanner?.addEventListener('click', () => switchAppMode('planner'));
  btnModeThinking?.addEventListener('click', () => switchAppMode('thinking'));

  // Global Keyboard Shortcuts (Ctrl+1 / Ctrl+2)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '1') {
      e.preventDefault();
      switchAppMode('planner');
    } else if ((e.ctrlKey || e.metaKey) && e.key === '2') {
      e.preventDefault();
      switchAppMode('thinking');
    }
  });

  // Query docs folder path
  callTauri('get_docs_path').then(p => {
    if (p) {
      docsFolderPath = p;
      const el = document.getElementById('thinking-docs-path');
      if (el) {
        el.textContent = `Storage: ${p}`;
        el.title = `Click to open ${p}`;
      }
    }
  });

  // Sidebar Buttons
  const btnNewDoc = document.getElementById('btn-thinking-new-doc');
  btnNewDoc?.addEventListener('click', async () => {
    const docName = prompt("Enter new document name (e.g. Transformer Scaling or AI/Optimization):");
    if (!docName || !docName.trim()) return;

    let path = docName.trim();
    if (!path.endsWith('.md')) path += '.md';

    await callTauri('create_doc', { path });
    await loadThinkingDocs(false);
    openThinkingDoc(path);
    showToast(`Created ${path}`);
  });

  const btnNewFolder = document.getElementById('btn-thinking-new-folder');
  btnNewFolder?.addEventListener('click', async () => {
    const folderName = prompt("Enter new folder name (e.g. Robotics or Deep Learning):");
    if (!folderName || !folderName.trim()) return;

    await callTauri('create_folder', { path: folderName.trim() });
    await loadThinkingDocs(false);
    showToast(`Created folder '${folderName}'`);
  });

  const btnOpenDocsFolder = document.getElementById('btn-thinking-open-folder');
  btnOpenDocsFolder?.addEventListener('click', async () => {
    const path = await callTauri('open_docs_folder');
    showToast(`Opened: ${path || docsFolderPath || 'docs'}`);
  });

  const thinkingDocsPathEl = document.getElementById('thinking-docs-path');
  thinkingDocsPathEl?.addEventListener('click', async () => {
    const path = await callTauri('open_docs_folder');
    showToast(`Opened: ${path || docsFolderPath || 'docs'}`);
  });

  // Search Filter in Sidebar
  const searchInput = document.getElementById('thinking-search-input');
  searchInput?.addEventListener('input', (e) => {
    renderDocsTree(activeDocsList, e.target.value);
  });

  // Editor Textarea
  const textarea = document.getElementById('thinking-editor-textarea');
  textarea?.addEventListener('input', () => {
    queueAutoSaveDoc();
  });

  // Paste handler: Intercept screenshot/image paste directly into document
  textarea?.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64Data = event.target.result;
          const ext = file.type.split('/')[1] || 'png';
          const timestamp = Date.now();
          const filename = `snip_${timestamp}.${ext}`;

          const parts = (currentOpenDocPath || '').split('/');
          parts.pop();
          const folder = parts.join('/');

          showToast("Saving pasted image to project assets...");
          try {
            const savedRelPath = await callTauri('save_doc_asset', {
              folder,
              filename,
              base64_data: base64Data
            });

            // Cache it immediately so preview renders instantly
            const cacheKey = `${folder}:${filename}`;
            docAssetCache.set(cacheKey, base64Data);

            // Insert markdown image tag at cursor position
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const imgMarkdown = `\n![Screenshot](${savedRelPath})\n`;
            textarea.value = textarea.value.substring(0, start) + imgMarkdown + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + imgMarkdown.length;

            currentOpenDocContent = textarea.value;
            queueAutoSaveDoc();
            showToast("Pasted image saved into document assets!");
          } catch (err) {
            console.error("Failed to save doc asset:", err);
            showToast("Failed to save image: " + err);
          }
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });

  // Editor Keydown: Tab Indentation, Ctrl+B, Ctrl+I, Ctrl+S
  textarea?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      if (e.shiftKey) {
        const val = textarea.value;
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        if (val.substring(lineStart, lineStart + 2) === '  ') {
          textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
          textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 2);
        }
      } else {
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }
      currentOpenDocContent = textarea.value;
      queueAutoSaveDoc();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      applyMarkdownFormatting('bold');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      applyMarkdownFormatting('italic');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (currentOpenDocPath) {
        callTauri('save_doc', {
          path: currentOpenDocPath,
          content: textarea.value
        }).then(() => {
          showToast(`Saved '${currentOpenDocPath.split('/').pop()}'`);
          const saveInd = document.getElementById('thinking-save-indicator');
          if (saveInd) {
            saveInd.textContent = "Saved";
            saveInd.style.color = "var(--accent-emerald)";
          }
        });
      }
    }
  });

  // Formatting Toolbar Buttons
  document.querySelectorAll('#thinking-formatting-toolbar .thinking-fmt-btn[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyMarkdownFormatting(btn.dataset.fmt);
    });
  });

  // Export Markdown File
  document.getElementById('btn-thinking-export-md')?.addEventListener('click', () => {
    if (!currentOpenDocPath) {
      showToast("No document open to export");
      return;
    }
    const filename = currentOpenDocPath.split('/').pop() || 'document.md';
    const blob = new Blob([currentOpenDocContent || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${filename}`);
  });

  // Copy Markdown
  document.getElementById('btn-thinking-copy-md')?.addEventListener('click', () => {
    if (!currentOpenDocContent) {
      showToast("Document is empty");
      return;
    }
    navigator.clipboard.writeText(currentOpenDocContent).then(() => {
      showToast("Document markdown copied to clipboard!");
    });
  });

  // Rename Doc Title Input
  const titleInput = document.getElementById('thinking-doc-title-input');
  titleInput?.addEventListener('change', async () => {
    if (!currentOpenDocPath) return;
    const newTitle = titleInput.value.trim();
    if (!newTitle) return;

    const parts = currentOpenDocPath.split('/');
    parts.pop();
    const newPath = (parts.length > 0 ? parts.join('/') + '/' : '') + newTitle + '.md';

    if (newPath !== currentOpenDocPath) {
      await callTauri('rename_doc', { old_path: currentOpenDocPath, new_path: newPath });
      currentOpenDocPath = newPath;
      await loadThinkingDocs(false);
      showToast(`Renamed to '${newTitle}'`);
    }
  });

  // View Switchers
  document.getElementById('btn-thinking-view-edit')?.addEventListener('click', () => setThinkingView('edit'));
  document.getElementById('btn-thinking-view-split')?.addEventListener('click', () => setThinkingView('split'));
  document.getElementById('btn-thinking-view-preview')?.addEventListener('click', () => setThinkingView('preview'));

  // Zen Focus Mode Toggle
  const btnFocus = document.getElementById('btn-thinking-focus');
  btnFocus?.addEventListener('click', () => {
    const ws = document.getElementById('thinking-workspace');
    ws?.classList.toggle('zen-focus');
  });

  // ========================================================================
  // THE BRIDGE: Push from Thinking Space -> Today's Daily Planner
  // ========================================================================
  const btnPushToPlanner = document.getElementById('btn-push-to-planner');
  const pushModal = document.getElementById('push-to-planner-modal');
  const btnClosePushModal = document.getElementById('btn-close-push-planner-modal');
  const btnCancelPushModal = document.getElementById('btn-cancel-push-planner');
  const btnConfirmPushModal = document.getElementById('btn-confirm-push-planner');

  btnPushToPlanner?.addEventListener('click', () => {
    if (!currentOpenDocPath) {
      showToast("Please select a document first");
      return;
    }

    const sourceBadge = document.getElementById('bridge-source-doc-name');
    if (sourceBadge) sourceBadge.textContent = currentOpenDocPath;

    // Populate destination sections from today's layout
    const targetSectionSelect = document.getElementById('bridge-target-section');
    if (targetSectionSelect) {
      targetSectionSelect.innerHTML = '';
      const activeLayout = getActiveLayout();
      const pageRows = normalizeLayoutPageRows(activeLayout);

      pageRows.forEach(row => {
        (row.sections || []).forEach(sec => {
          const subRows = getSectionSubRows(sec);
          subRows.forEach(sub => {
            (sub.tracks || []).forEach(tr => {
              const opt = document.createElement('option');
              opt.value = tr.key;
              opt.textContent = `${sec.title} → ${tr.title}`;
              targetSectionSelect.appendChild(opt);
            });
          });
        });
      });
    }

    // Extract checklists from current open doc
    const checklistPreview = document.getElementById('bridge-doc-checklist-preview');
    if (checklistPreview) {
      checklistPreview.innerHTML = '';
      const lines = (currentOpenDocContent || '').split('\n');
      let foundAny = false;

      lines.forEach(line => {
        const m = line.match(/^\s*-\s*\[([ xX])\]\s+(.*)$/);
        if (m) {
          foundAny = true;
          const itemText = m[2];
          const isDone = m[1].toLowerCase() === 'x';
          const row = document.createElement('label');
          row.className = 'bridge-check-item';
          row.innerHTML = `
            <input type="checkbox" value="${escapeHTML(itemText)}" ${!isDone ? 'checked' : ''} />
            <span>${escapeHTML(itemText)}</span>
          `;
          checklistPreview.appendChild(row);
        }
      });

      if (!foundAny) {
        checklistPreview.innerHTML = '<span class="text-dim" style="font-size: 12px;">No checklists found in doc. Type a custom action below:</span>';
      }
    }

    const customInput = document.getElementById('bridge-custom-task-input');
    if (customInput) customInput.value = '';

    pushModal?.classList.add('show');
  });

  const closePushModal = () => pushModal?.classList.remove('show');
  btnClosePushModal?.addEventListener('click', closePushModal);
  btnCancelPushModal?.addEventListener('click', closePushModal);

  btnConfirmPushModal?.addEventListener('click', async () => {
    const targetSectionSelect = document.getElementById('bridge-target-section');
    const targetKey = targetSectionSelect?.value;
    if (!targetKey) {
      showToast("No target section selected");
      return;
    }

    // Collect tasks from checkboxes
    const tasksToAdd = [];
    document.querySelectorAll('#bridge-doc-checklist-preview input[type="checkbox"]:checked').forEach(cb => {
      if (cb.value) tasksToAdd.push(cb.value.trim());
    });

    // Plus custom input text
    const customText = document.getElementById('bridge-custom-task-input')?.value?.trim();
    if (customText) {
      tasksToAdd.push(customText);
    }

    if (tasksToAdd.length === 0) {
      showToast("Select or type at least one task to push");
      return;
    }

    // Ensure target block exists in currentDayData
    if (!currentDayData[targetKey]) {
      currentDayData[targetKey] = { title: targetKey, content: '', tasks: [] };
    }
    if (!Array.isArray(currentDayData[targetKey].tasks)) {
      currentDayData[targetKey].tasks = [];
    }

    tasksToAdd.forEach(tText => {
      currentDayData[targetKey].tasks.push({
        id: 't_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        text: `[${currentOpenDocPath.split('/').pop().replace(/\.md$/i, '')}] ${tText}`,
        completed: false
      });
    });

    const dateKey = formatDateKey(currentDate);
    activeDatesSet.add(dateKey);
    await callTauri('save_day', { entry: currentDayData });

    // Append pulse log to document
    const todayStr = formatDateKey(currentDate);
    const destTitle = targetSectionSelect.options[targetSectionSelect.selectedIndex]?.textContent || targetKey;
    const logEntry = `\n> *🚀 Pushed ${tasksToAdd.length} task${tasksToAdd.length > 1 ? 's' : ''} to Daily Planner (${destTitle}) on ${todayStr}*\n`;

    const textarea = document.getElementById('thinking-editor-textarea');
    if (textarea) {
      textarea.value += logEntry;
      currentOpenDocContent = textarea.value;
      queueAutoSaveDoc();
    }

    closePushModal();
    renderCurrentDay();
    showToast(`Pushed ${tasksToAdd.length} task(s) to Today's Planner!`);
  });

  // ========================================================================
  // THE BRIDGE: Push from Daily Planner -> Thinking Space
  // ========================================================================
  const pushThinkingModal = document.getElementById('push-to-thinking-modal');
  const btnClosePushThinkingModal = document.getElementById('btn-close-push-thinking-modal');
  const btnCancelPushThinking = document.getElementById('btn-cancel-push-thinking');
  const btnConfirmPushThinking = document.getElementById('btn-confirm-push-thinking');

  const closePushThinkingModal = () => pushThinkingModal?.classList.remove('show');
  btnClosePushThinkingModal?.addEventListener('click', closePushThinkingModal);
  btnCancelPushThinking?.addEventListener('click', closePushThinkingModal);

  btnConfirmPushThinking?.addEventListener('click', async () => {
    const docSelect = document.getElementById('bridge-target-doc');
    const newDocInput = document.getElementById('bridge-new-doc-name');
    const contentArea = document.getElementById('bridge-content-to-append');

    let targetDocPath = newDocInput?.value?.trim() || docSelect?.value;
    if (!targetDocPath) {
      showToast("Select or specify a document name");
      return;
    }
    if (!targetDocPath.endsWith('.md')) targetDocPath += '.md';

    const contentToAppend = contentArea?.value?.trim();
    if (!contentToAppend) {
      showToast("Please enter notes or findings to append");
      return;
    }

    const todayDisplay = formatDateDisplay(currentDate);
    const formattedAppend = `\n\n### 📅 Notes from ${todayDisplay}\n${contentToAppend}\n`;

    await callTauri('append_to_doc', {
      path: targetDocPath,
      content: formattedAppend
    });

    closePushThinkingModal();
    await loadThinkingDocs(false);
    showToast(`Appended to '${targetDocPath}'!`);
  });
}

// Global helper to open the Push-To-Thinking modal from anywhere in the planner
function openPushToThinkingModal(presetText = '') {
  const modal = document.getElementById('push-to-thinking-modal');
  const docSelect = document.getElementById('bridge-target-doc');
  const contentArea = document.getElementById('bridge-content-to-append');
  const newDocInput = document.getElementById('bridge-new-doc-name');

  if (docSelect) {
    docSelect.innerHTML = '';
    function collectDocPaths(items) {
      let paths = [];
      items.forEach(it => {
        if (!it.is_dir) paths.push(it.path);
        if (it.children) paths = paths.concat(collectDocPaths(it.children));
      });
      return paths;
    }

    const allPaths = collectDocPaths(activeDocsList);
    if (allPaths.length === 0) {
      const opt = document.createElement('option');
      opt.value = "AI Research/Research Notes.md";
      opt.textContent = "AI Research/Research Notes.md (New)";
      docSelect.appendChild(opt);
    } else {
      allPaths.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        docSelect.appendChild(opt);
      });
    }
  }

  if (newDocInput) newDocInput.value = '';
  if (contentArea) contentArea.value = presetText;

  modal?.classList.add('show');
}

// Start application immediately
init();

