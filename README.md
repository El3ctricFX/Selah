<div align="center">
  <img src="public/logo.png" alt="Selah logo" width="320" />

  # Selah
  
[![Release](https://img.shields.io/github/v/release/El3ctricFX/Selah)](https://github.com/El3ctricFX/Selah/releases)
[![Downloads](https://img.shields.io/github/downloads/El3ctricFX/Selah/total)](https://github.com/El3ctricFX/Selah/releases)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/JSQFShPTkD)
[![Built with AI](https://img.shields.io/badge/Vibe%20coded%20with-AI-blueviolet)](https://github.com/El3ctricFX/Selah)

  **Pause. Reflect. Write. Grow.**

  *A quiet place to write, reflect, and grow in faith.*
</div>

---

Selah is a work-in-progress, local-first journaling and note-taking app inspired by the flexibility of Notion and the personal knowledge approach of Obsidian. It is being built as a calm space for daily journaling, prayer, Scripture study, dreams, testimonies, and the thoughts and moments worth keeping.

> “Be still, and know that I am God.” — Psalm 46:10

## 🌿 The vision

Selah aims to bring together a flexible writing experience, personal organization, and faith-centered reflection without making note management feel like a chore.

- **Flexible writing:** a block-based editor for more than plain text.
- **Personal journals:** a home for daily entries, prayer, dreams, Bible study, testimonies, and miscellaneous notes.
- **Local-first philosophy:** prioritize personal ownership and control of your writing.
- **Selah documents (`.selah`):** a purpose-built file format inspired by Markdown's readability, with room for richer document structures and features.
- **Calm interface:** a minimal workspace designed to help you focus on what you want to write.

## 🤖 AI Disclosure

Selah is vibe-coded and built using AI assistance for architecture, UI layout, and code generation.

## 🗂️ The `.selah` file format

Selah uses its own **`.selah` document format**. It takes inspiration from Markdown, but it is intended to support richer content and structures than standard Markdown alone. This lets Selah evolve its document capabilities while keeping the format centered around the needs of the app.

`.selah` is not simply another extension for a Markdown file. While it is readable as text, it relies on custom syntax (like `::: gallery` or `::: scripture`) to support advanced blocks. Compatibility, import/export options, and the exact format specification should be documented as those capabilities are finalized. Until then, do not assume `.selah` files can be opened losslessly in other Markdown editors.

## ✨ Features

Selah is in active development, but the following features are already functional:

- **Daily Journaling:** Browse and write past and future entries
- **Multiple Note Types:** Dedicated categories for prayer, dreams, Scripture study, testimonies, and general notes.
- **Block-Based Editor:** A powerful, Notion-like rich-text editor with image galleries, columns, and callouts.
- **Spell Checker:** Built-in Hunspell spell checking with per-note custom dictionaries.
- **Rich Media Support:** Embed images, audio, video, and drag-and-drop DM archives.
- **Data Portability:** Export notes and media into a single `.selahpack` file, or import directly from Obsidian/Notion Markdown.
- **Local-First:** All data stays on your machine. No cloud required.

## 🖼️ Screenshots

<div align="center">
  <img src="public/Readme/main.png" width="49%" />
  <img src="public/Readme/journal.png" width="49%" />
  <br /><br />
  <img src="public/Readme/Abba.png" width="49%" />
  <img src="public/Readme/notes.png" width="49%" />
  <br /><br />
  <img src="public/Readme/study.png" width="49%" />
</div>

## 🛠️ Built with

- [Tauri 2](https://v2.tauri.app/) — desktop application framework
- [React](https://react.dev/) and [TypeScript](https://www.typescriptlang.org/) — user interface and application logic
- [Vite](https://vite.dev/) — frontend development and build tooling
- [BlockNote](https://www.blocknotejs.org/) — block-based editor components
- [Tiptap](https://tiptap.dev/) — rich-text editing extensions
- [nspell](https://github.com/wooorm/nspell) — Hunspell-compatible spell checking
- [fflate](https://github.com/101arrowz/fflate) — high-performance ZIP compression for `.selahpack` import/export
- [emoji-picker-react](https://github.com/ealush/emoji-picker-react) — cross-platform emoji selection
- [Tailwind CSS](https://tailwindcss.com/) — styling

## 🚧 Project status

Selah is a personal project that is being actively developed. Features, the `.selah` format, and the interface may change. The current focus is building a dependable foundation for creating, editing, and saving notes before treating the app as a daily-use journal.

Please keep backups of important writing while the app and file format are still evolving.

## 💻 Getting started

These instructions are for running the project in development mode.

### Prerequisites

- Node.js and npm
- Rust and Cargo
- The platform-specific system dependencies required by [Tauri 2](https://v2.tauri.app/start/prerequisites/)
- **libmpv** (Required for advanced audio/video playback via `tauri-plugin-libmpv-api`. On Linux, install via your package manager, e.g., `sudo apt install libmpv-dev`. On macOS, `brew install mpv`.)
- **Spellcheck Dictionaries:** The spell checker relies on Hunspell dictionaries located in `public/dictionaries/`. Ensure `en_US.aff` and `en_US.dic` are present before building.

### Run locally

```bash
git clone https://github.com/El3ctricFX/Selah.git
cd Selah
npm install
npm run tauri dev
```

To run only the frontend development server:

```bash
npm run dev
```

To type-check and build the frontend:

```bash
npm run build
```

A successful build does not necessarily mean every app feature is implemented or ready for everyday use.

## 🤍 Why “Selah”?

*Selah* appears throughout the Psalms and other poetic passages of Scripture. Its exact meaning is debated, but it is often associated with a pause or moment of reflection. That idea captures the heart of the project: making room to slow down, write honestly, reflect on Scripture, and remember meaningful moments.

## 💬 Feedback

Selah is still taking shape. Suggestions and bug reports are welcome through [GitHub Issues](https://github.com/El3ctricFX/Selah/issues). For casual conversation and updates, join the [Discord community](https://discord.gg/JSQFShPTkD).

---

<div align="center">
  <em>Selah — Pause. Reflect. Write. Grow.</em>
</div>
