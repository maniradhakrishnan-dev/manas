# Manas — Daily Planner & Thinking Space
> **A tactile, ultra-fast 365-day digital daily planner and personal diary built with Tauri 2.0 & Rust.**

<div align="center">
  <img src="ui/assets/logo.png" width="128" height="128" alt="MRT App Logo" style="border-radius: 28px; box-shadow: 0 8px 30px rgba(0,0,0,0.4);" />
  <br />
  <strong>Manas Daily Planner</strong>
</div>

---

## 🚀 How to Launch the Desktop Application

### Option 1: From Desktop / Application Menu
* Double click the **MRT** shortcut on your **Desktop**.
* Or search for **MRT** in your system applications launcher.

### Option 2: From Terminal
```bash
cd ~/mrt
./mrt-launch.sh
```
*(Or use `npx @tauri-apps/cli dev` for hot-reload development)*.

---

## 💾 Where is the Data Stored?

All planner entries are stored 100% locally on your machine in standard human-readable JSON files:

```text
~/.local/share/mrt/entries/YYYY-MM-DD.json
```

* **Zero telemetry, fully offline, and private**.
* **Quick Folder Access**: Click the **📁 folder icon** in the top navigation bar inside the app at any time to open the folder directly in your system file manager.

---

## 📐 Layout Architecture

Every day is organized into a clean **2-Row system**:

```text
+-------------------------------------------------------------------------------------------------------------------+
| [Traffic Lights]  [Logo] MRT      [ <  Today  >  Thursday, Oct 15, 2026  📅 365 Diary ]     [Progress] [Save] [📁] |
+-------------------------------------------------------------------------------------------------------------------+
| [04:00 - 09:00 Learning]       [09:00 - 14:00 Productive]      [14:00 - 18:00 Admin]      [18:00 - 23:00 Evening] |
+-------------------------------------------------------------------------------------------------------------------+
| ============================== ROW 1: DAYTIME (4:00 AM - 9:00 AM & 9:00 AM - 6:00 PM) =========================== |
| ----------------------------------------------------------------+------------------------------------------------ |
| COLUMN 1: 04:00 — 09:00 (LEARNING & CORE TRACKS)               | COLUMN 2: 09:00 — 18:00 (PRODUCTIVE & ADMIN)    |
| +------------------------------+------------------------------+ | ----------------------------------------------- |
| | CS & SWE (Quadrant 1)        | Core AI (Quadrant 2)         | | PRODUCTIVE (09:00 — 14:00)                      |
| +------------------------------+------------------------------+ | Deep Execution, shipping core deliverables      |
| | Applications (Quadrant 3)    | RSWE (Quadrant 4)            | |                                                 |
| +------------------------------+------------------------------+ | ----------------------------------------------- |
| ------------------------- [PART 2] ---------------------------- | ADMIN & CHORES (14:00 — 18:00)                  |
| Electronics & Motors                                          | Job applications, operations, digital cleanup   |
| Hardware, motor drivers, circuit schematics                   |                                                 |
+=================================================================+=================================================+
| ============================== ROW 2: EVENING PHASE (6:00 PM - 11:00 PM) ======================================= |
| (6 COLUMNS ACROSS THE WIDTH)                                                                                      |
| +------------+------------+------------+------------+----------------------------------+------------------------+ |
| | 1. Huro    | 2. Kana    | 3. Bana    | 4. Curio   | 5. Survivi                       | 6. Random              | |
| | (Robotics) |            |            | (Research) | (Health, workout, nutrition)     | (Spontaneous ideas)    | |
| +------------+------------+------------+------------+----------------------------------+------------------------+ |
+-------------------------------------------------------------------------------------------------------------------+
```

---

## ✨ Features

- **Cyber-macOS Glassmorphism**: Translucent acrylic cards, ambient hover glows, Apple SF Pro typography.
- **Visual Day Timeline Ribbon**: Live visual chips showing the 4 phases of your day.
- **Interactive Checklists**: Type `- [ ]` or click `☐`. Checkboxes toggle `- [x]`, update card stats, and animate the header progress ring.
- **365-Day Diary Modal**: Full 12-month calendar heatmap with glowing indicators for recorded days.
- **3 Curated Themes**: Cyber Obsidian (Dark), Apple Warm Paper (Moleskine cream), and Nordic Slate.
- **One-Click Markdown Export**: Save any day's structured entry into a clean `.md` file.

---

## 📄 License

MIT License — Copyright (c) 2026 Manas Contributors.