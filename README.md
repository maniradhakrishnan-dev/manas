# Manas
> **A tactile, distraction-free daily planner and thinking space built with Tauri 2.0 & Rust.**

---

## 🚀 Overview

**Manas** is a high-performance, offline-first daily planner designed for deep focus, structured daily rhythm, and long-term reflection. It gives you complete control over your daily grid, tasks, and notes without cloud lock-in, subscriptions, or telemetry.

---

## 💻 Running the Application

### Launch
```bash
./mrt-launch.sh
```
*(Or use `npx @tauri-apps/cli dev` for live-reload development).*

### Building Standalone Release
```bash
cargo build --release --manifest-path src-tauri/Cargo.toml
```
The compiled native executable is generated at:
```text
src-tauri/target/release/manas
```

---

## 🔒 100% Private, Local-First Architecture

All planner entries are stored locally on your machine in human-readable JSON files:

* **Linux:** `~/.local/share/manas/entries/YYYY-MM-DD.json`
* **macOS:** `~/Library/Application Support/manas/entries/YYYY-MM-DD.json`
* **Windows:** `%APPDATA%\manas\entries\YYYY-MM-DD.json`

* **Zero telemetry, zero tracking, completely offline.**
* **Persistent across upgrades:** Installing a new version will never overwrite or erase your existing planner entries.
* **Open Folder:** Click the **📁 folder icon** in the app header at any time to open your data folder directly in your system file manager.

---

## ✨ Features

- **Dynamic Multi-Section Canvas**: Create customizable page rows, sections, and columns. Columns expand equally when space permits and scroll smoothly when overflowing.
- **Task & Subtask Reordering**: Move tasks up/down with dedicated buttons (`▲`/`▼`), drag-and-drop handles (`⠿`), direct jump-to-position dialog, or keyboard shortcuts (`Alt+↑` / `Alt+↓`).
- **Hierarchical Subtasks**: Indented checklist branches with progress counters and parent-child completion syncing.
- **⏱ Task Lock-In**: Isolate and focus on a single task with dedicated notes, time blocks, and distraction-free workspace.
- **365-Day Diary Navigator**: Full 12-month calendar heatmap with glowing visual activity indicators.
- **Curated Themes**: Pure Paper (Moleskine cream), Cyber Obsidian (Deep Dark), and Ceramic Studio.
- **Smart Carryover & Rollover**: Easily review, carry over, or archive unfinished tasks from previous days.

---

## 📄 License

MIT License — Copyright (c) 2026 Manas Contributors.