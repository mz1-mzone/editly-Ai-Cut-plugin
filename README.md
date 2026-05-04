# Editly AI Cut

**AI-Powered Story Editor for Adobe Premiere Pro**

Editly AI Cut uses ElevenLabs for speech transcription and Claude AI for intelligent story editing. Select your clips, describe the story you want, and the AI creates professional cuts — removing fillers, silence, and weak sections while keeping the narrative intact.

---

## ✨ Features

- **AI Story Editing** — Claude reads the transcript and makes narrative-focused cuts
- **Auto Filler Detection** — Removes "aaaa", "um", breathing, and silence
- **Arabic Support** — Native Arabic speech pattern understanding
- **Non-Destructive** — Disables clips instead of deleting (undo anytime)
- **Auto-Updates** — Plugin checks GitHub for updates on every launch

---

## 📦 Installation

### Mac

Open Terminal and run:

```bash
bash <(curl -s https://raw.githubusercontent.com/mz1-mzone/editly-Ai-Cut-plugin/main/install-mac.sh)
```

Or download `install-mac.sh` and run it.

### Windows

1. Download `install-windows.bat` from this repo
2. Right-click → **Run as Administrator**

### Requirements

- **Adobe Premiere Pro** 2022 or later
- **ffmpeg** installed ([Mac](https://formulae.brew.sh/formula/ffmpeg): `brew install ffmpeg` | [Windows](https://www.gyan.dev/ffmpeg/builds/))
- **git** installed ([Mac](https://git-scm.com/): comes with Xcode tools | [Windows](https://git-scm.com/download/win))

---

## 🔑 Setup

1. Open Premiere Pro → **Window** → **Extensions** → **Editly AI Cut**
2. Click the **⚙ Settings** button
3. Enter your API keys:
   - **ElevenLabs API Key** — Get one at [elevenlabs.io](https://elevenlabs.io)
   - **Anthropic API Key** — Get one at [console.anthropic.com](https://console.anthropic.com)
4. Click **Save Settings**

---

## 🎬 Usage

1. **Select clips** on the timeline
2. Click **↻ Refresh** to load clip info
3. Write a **Story Prompt** (e.g. "Create a highlight reel focusing on emotional moments")
4. Set a **Target Duration** (this is a loose guide)
5. Click **✂ Create a Cut**
6. Wait for the 4-step process:
   - Export Audio → Transcribe → AI Story Edit → Apply Cuts
7. Review the results — **Approve** or **Undo**

---

## 🔄 Auto-Updates

The plugin automatically checks GitHub for new versions every time Premiere Pro opens. If an update is found, it downloads and applies it — you just need to restart Premiere.

For manual updates:
```bash
cd ~/Library/Application\ Support/Adobe/CEP/extensions/EditlyPlugin  # Mac
cd %APPDATA%\Adobe\CEP\extensions\EditlyPlugin                       # Windows
git pull
```

---

## 🏗️ Architecture

```
Premiere Timeline
    ↓
FFmpeg extracts audio (mono 16kHz WAV)
    ↓
ElevenLabs Scribe v2 (speech-to-text with timestamps)
    ↓
Claude AI (story analysis → keep/remove decisions)
    ↓
ExtendScript applies razor cuts & disables removed clips
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
│   │   ├── transcribe.js      # ElevenLabs transcription
│   │   └── silence-detect.js  # FFmpeg silence detection
│   ├── updater.js             # GitHub auto-updater
│   ├── main.js                # App controller & pipeline
│   └── utils/                 # Audio & timeline utilities
├── jsx/hostscript.jsx         # Premiere Pro ExtendScript
├── install-mac.sh             # Mac installer
├── install-windows.bat        # Windows installer
└── version.json               # Update tracking
```

---

## 📄 License

MIT

---

Made with ❤️ by [Editly](https://editly.ai)
