# Contributing to Manas

Thank you for your interest in contributing to **Manas**! We welcome bug reports, feature requests, documentation improvements, and code contributions.

---

## 🧭 Philosophy

1. **Local-First & Zero Telemetry**: User data belongs solely to the user. Never introduce code that phones home, sends analytics, or requires an internet connection for core planner functions.
2. **Speed & Lightweight Footprint**: We value instant startup and low RAM usage. Keep UI dependencies minimal and avoid heavy frameworks.
3. **Tactile Simplicity**: The design prioritizes focus, clarity, and intentional daily rhythm.

---

## 🛠️ Development Setup

### Prerequisites
- **Rust**: Latest stable Rust (`rustup default stable`)
- **Node.js**: LTS version (`v18+` or `v20+`)
- **System Dependencies**:
  - **Linux (Ubuntu/Debian)**:
    ```bash
    sudo apt-get update && sudo apt-get install -y \
      libwebkit2gtk-4.1-dev \
      build-essential \
      curl \
      wget \
      file \
      libssl-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev
    ```
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft C++ Build Tools & WebView2 (standard on Windows 10/11)

### Getting Started

1. **Clone the repository**:
   ```bash
   git clone https://github.com/maniradhakrishnan-dev/manas.git
   cd manas
   ```

2. **Install frontend tooling**:
   ```bash
   npm install
   ```

3. **Run in development mode (with live reload)**:
   ```bash
   npm run dev
   # or
   npx @tauri-apps/cli dev
   ```

4. **Compile a release build locally**:
   ```bash
   npm run build
   # or
   cargo build --release --manifest-path src-tauri/Cargo.toml
   ```

---

## 📂 Project Structure

```text
├── ui/                   # Frontend assets
│   ├── index.html        # App layout and component shells
│   ├── style.css         # Tactile styling & theme engine
│   ├── app.js            # Frontend state, event handling & Tauri invoke bridges
│   └── assets/           # Local icons and artwork
├── src-tauri/            # Tauri 2.0 Rust backend
│   ├── Cargo.toml        # Rust dependencies & metadata
│   ├── tauri.conf.json   # Tauri window, security & build config
│   ├── src/lib.rs        # Local JSON storage commands & native lifecycle
│   └── icons/            # Cross-platform application icons
└── .github/              # CI/CD and issue templates
```

---

## 📋 Pull Request Guidelines

1. **Branch naming**: Use descriptive branches like `feat/keyboard-nav` or `fix/task-drag`.
2. **Test locally**: Ensure `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml` pass cleanly before pushing.
3. **Keep PRs focused**: Small, single-purpose PRs are reviewed and merged much faster.
4. **Preserve user data format**: Any changes to data models in `src-tauri/src/lib.rs` must maintain backwards compatibility with existing user JSON files in `~/.local/share/manas/entries/`.

---

## 📄 License
By contributing to Manas, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
