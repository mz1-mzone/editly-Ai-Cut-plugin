# Editly AI Editor

**AI-Powered Story Editor & VFX Studio for Adobe Premiere Pro**

Editly AI Editor combines intelligent story editing with a powerful VFX studio. Use Claude AI to auto-cut your footage, generate AI images with Gemini, and create AI-powered video effects with Kling 3.0, Seedance 2.0, and Beeble SwitchX — all from within Premiere Pro.

---

## ✨ Features

### 🎬 AI Story Editor
- **Claude AI** reads your transcript and makes narrative-focused cuts
- **Auto Filler Detection** — removes "um", "uh", breathing, and silence
- **Arabic Support** — native Arabic speech pattern understanding
- **Non-Destructive** — disables clips instead of deleting (undo anytime)

### 🎨 VFX Studio
- **Kling 3.0** — motion-controlled video generation (up to 30s)
- **Seedance 2.0** — high-quality video generation with audio (up to 15s)
- **Beeble SwitchX** — face-accurate background replacement
- **Gemini Image Generation** — AI preview images before video generation
- **Upload Reference Images** — skip AI generation and use your own
- **Direct Video Generation** — Seedance text/image-to-video without a source clip
- **Auto Timeline Import** — generated clips placed above the original with audio sync

### 🔄 Auto-Updates
- Plugin checks GitHub for new versions every launch

---

## 📦 Installation

### Mac (Recommended)

Open Terminal and run:

```bash
bash <(curl -s https://raw.githubusercontent.com/mz1-mzone/editly-Ai-Cut-plugin/main/install-mac.sh)
```

### Mac (.pkg Installer)

Download `EditlyAIEditor.pkg` from [Releases](https://github.com/mz1-mzone/editly-Ai-Cut-plugin/releases) and double-click to install.

### Windows

1. Download `install-windows.bat` from this repo
2. Right-click → **Run as Administrator**

### Requirements

- **Adobe Premiere Pro** 2022 or later
- **ffmpeg** installed ([Mac](https://formulae.brew.sh/formula/ffmpeg): `brew install ffmpeg` | [Windows](https://www.gyan.dev/ffmpeg/builds/))
- **git** installed ([Mac](https://git-scm.com/): comes with Xcode tools | [Windows](https://git-scm.com/download/win))

---

## 🔑 Setup

1. Open Premiere Pro → **Window** → **Extensions** → **Editly AI Editor**
2. Click the **⚙ Settings** button
3. Enter your API keys:

| Service | Purpose | Get Key |
|---|---|---|
| **ElevenLabs** | Speech transcription | [elevenlabs.io](https://elevenlabs.io) |
| **Anthropic** | AI story editing (Claude) | [console.anthropic.com](https://console.anthropic.com) |
| **Gemini** | AI image generation | [aistudio.google.com](https://aistudio.google.com) |
| **Kling** | Motion-controlled video FX | [klingai.com](https://klingai.com) |
| **Seedance** | High-quality video generation | [docs.byteplus.com](https://docs.byteplus.com) |
| **Beeble** | Face-safe background swap | [developer.beeble.ai](https://developer.beeble.ai) |

4. Click **Save Settings**

> **Note:** You only need keys for the features you use. ElevenLabs + Anthropic for story editing, Gemini + one video model for VFX.

---

## 🎬 Usage

### Story Editor

1. **Select clips** on the timeline
2. Click **↻ Refresh** to load clip info
3. Write a **Story Prompt** (e.g. "Create a highlight reel focusing on emotional moments")
4. Set a **Target Duration**
5. Click **✂ Create a Cut**
6. Review → **Approve** or **Undo**

### VFX Studio

1. Switch to **VFX Studio** tab
2. **Select a clip** on the timeline and click **↻ Refresh**
3. Write an **Effect Prompt** or choose a template
4. Choose a **Video Model** (Kling, Seedance, or Beeble)
5. Click **🚀 Generate Preview** or **📷 Upload Image** for a reference
6. **Approve** to send to the generation queue
7. Generated clips auto-import above the original on the timeline

### Direct Video Generation (Seedance 2.0)

1. Select **Seedance 2.0** as the model
2. Write a prompt and optionally upload reference images
3. Click **⚡ Generate Video Directly** — no source clip needed
4. Generates 15s, 1080p video with audio matching your sequence aspect ratio

---

## 🏗️ Architecture

```
┌─────────────── STORY EDITOR ───────────────┐
│ Premiere Timeline                          │
│     ↓                                      │
│ FFmpeg extracts audio (mono 16kHz WAV)     │
│     ↓                                      │
│ ElevenLabs Scribe v2 (speech-to-text)      │
│     ↓                                      │
│ Claude AI (story analysis → cuts)          │
│     ↓                                      │
│ ExtendScript applies razor cuts            │
└────────────────────────────────────────────┘

┌──────────────── VFX STUDIO ────────────────┐
│ Selected Clip + Prompt                     │
│     ↓                                      │
│ Gemini 2.0 Flash (AI preview image)        │
│     ↓                                      │
│ Kling 3.0 / Seedance 2.0 / Beeble SwitchX │
│     ↓                                      │
│ FFmpeg re-encode (H.264)                   │
│     ↓                                      │
│ Auto-import to timeline above source       │
└────────────────────────────────────────────┘
```

---

## 📂 Project Structure

```
EditlyPlugin/
├── CSXS/manifest.xml          # CEP extension manifest
├── config/
│   └── settings.example.json  # API key template
├── css/styles.css             # Premium dark UI theme
├── index.html                 # Panel UI
├── js/
│   ├── CSInterface.js         # Adobe CEP bridge
│   ├── api/
│   │   ├── ai-editor.js       # Claude AI story editor
│   │   ├── beeble-video.js    # Beeble SwitchX API client
│   │   ├── gemini-image.js    # Gemini image generation
│   │   ├── kling-video.js     # Kling 3.0 video API client
│   │   ├── seedance-video.js  # Seedance 2.0 video API client
│   │   ├── silence-detect.js  # FFmpeg silence detection
│   │   └── transcribe.js      # ElevenLabs transcription
│   ├── main.js                # App controller & pipeline
│   ├── updater.js             # GitHub auto-updater
│   ├── vfx-controller.js      # VFX task queue & processing
│   └── utils/                 # Audio & timeline utilities
├── jsx/hostscript.jsx         # Premiere Pro ExtendScript
├── install-mac.sh             # Mac installer (curl one-liner)
├── install-windows.bat        # Windows installer
├── build-mac-pkg.sh           # macOS .pkg builder
└── version.json               # Update tracking
```

---

## 📄 License

MIT

---

Made with ❤️ by [Editly](https://editly.ai)
