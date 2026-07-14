# 🎤 ShadowVox

> **Real-time voice cloning Discord bot** powered by `discord.js` audio streams
> and a local Python **XTTS-v2** neural engine.

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.0-8b5cf6" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.5-3178c6" />
  <img alt="Python" src="https://img.shields.io/badge/Python-3.10+-3776AB" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="Lines" src="https://img.shields.io/badge/source-3,176_lines-22d3ee" />
</p>

---

## 📋 Table of Contents

- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Prefix Commands](#-prefix-commands)
- [Admin Web Panel](#-admin-web-panel)
- [Voice Activity Detection (VAD)](#-voice-activity-detection-vad)
- [Voice Profiles](#-voice-profiles)
- [Project Structure](#-project-structure)
- [Dependencies](#-dependencies)
- [Python TTS Server](#-python-tts-server)
- [Environment Variables](#-environment-variables)
- [Development](#-development)

---

## 🏗 Architecture

```
┌────────────────────────────────────────────────────────┐
│                      DISCORD VC                        │
└─────┬────────────────────────────────────────────▲─────┘
      │                                            │
      │ 1. Raw Opus Stream                         │ 5. Play Cloned Audio
      ▼                                            │
┌──────────────┐   2. Decoded PCM   ┌──────────────┴─────┐
│  Discord.js  ├───────────────────►│    Discord.js      │
│  Receiver    │                    │  AudioPlayer Play  │
└─────┬────────┘                    └──────────────▲─────┘
      │                                            │
      │ (Save File)                                │ 4. Output .wav
      ▼                                            │
┌──────────────┐   3. POST user.wav ┌──────────────┴─────┐
│ Local Disk   ├───────────────────►│   Local Python     │
│  Recording   │                    │   Voice-Clone API  │
└──────────────┘                    └────────────────────┘
```

### Data Flow

1. **Capture** — Bot joins a Discord voice channel and subscribes to a user's Opus audio stream via `@discordjs/voice`.
2. **Decode** — Raw Opus packets are decoded into 48 kHz, 16-bit signed PCM using `prism-media`.
3. **Convert** — FFmpeg converts the PCM data into a clean `.wav` file on disk.
4. **Clone** — The `.wav` reference is posted to the local Python TTS API (`http://127.0.0.1:8000/clone`), which runs XTTS-v2.
5. **Play** — The synthesized audio is played back through the Discord voice connection.

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version / Notes |
|---|---|
| **Node.js** | ≥ 18 (Bun recommended) |
| **Python** | ≥ 3.10 |
| **FFmpeg** | Required for PCM→WAV conversion |
| **GPU (optional)** | CUDA-compatible GPU for faster TTS inference |
| **Discord Bot** | Create one at [discord.com/developers/applications](https://discord.com/developers/applications) |

### Setup

```bash
# 1. Clone and install Node.js dependencies
git clone https://github.com/CoderGamerUnknow/shadow-vox.git
cd shadow-vox
bun install

# 2. Install Python dependencies
cd python
pip install -r requirements.txt
cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env and set your DISCORD_BOT_TOKEN

# 4. Start the Python TTS server (in terminal 1)
cd python && python tts_server.py

# 5. Start the bot (in terminal 2)
bun run src/index.ts
```

### First-Time Use in Discord

1. Invite the bot to your server using the invite link printed at startup.
2. Join a voice channel.
3. Type `!join` to have the bot join you.
4. Type `!record` to capture your voice profile (speak for 3+ seconds).
5. Type `!say Hello, this is my cloned voice!` to hear yourself.

---

## 💬 Prefix Commands

All commands use the `!` prefix. 12 commands are registered.

| Command | Description |
|---|---|
| `!deleteprofile` | Delete a user's voice profile |
| `!health` | Check if the Python TTS server is running |
| `!join` | Join your current voice channel and start VAD |
| `!leave` | Leave the voice channel and stop VAD |
| `!ping` | Check if the bot is alive |
| `!profile` | Show details for a specific user's voice profile |
| `!profiles` | List all saved voice profiles |
| `!record` | Record a voice profile for yourself or a mentioned user |
| `!say` | Clone your voice and speak the provided text |
| `!setclone` | Set the default text for VAD auto-cloning |
| `!vad` | Manage Voice Activity Detection settings |
| `!voice` | List and select from 42 voice presets (Morgan Freeman, Yoda, etc.) |

### VAD Sub-Commands

| Sub-command | Description |
|---|---|
| `!vad on` / `!vad off` | Toggle voice activity detection |
| `!vad status` | Show current VAD configuration |
| `!vad clone` / `!vad noclone` | Enable/disable auto-cloning |
| `!vad all` / `!vad profiles` | Listen to all users or only profiled ones |
| `!vad silence <ms>` | Set the silence threshold (200–5000 ms) |
| `!vad cooldown <s>` | Set the clone cooldown (1–60 s) |

---

## 🌐 Admin Web Panel

An embedded Express admin server provides a real-time dashboard and REST API.

### Dashboard

Open `http://localhost:3000` (configurable via `ADMIN_PORT`) to access:

| Feature | Description |
|---|---|
| **Connection status** | Live indicator showing guild, channel, and bot state |
| **Voice profiles** | List all profiles with delete capability |
| **VAD controls** | Toggle listening, auto-clone, listen-to-all, and silence threshold |
| **Speak form** | Select a profile or preset, type text, and trigger voice cloning |
| **Preset browser** | Browse and select from 42 voice presets with category filtering |
| **Preset play button** | Click ▶ on any preset chip to hear its reference audio sample |
| **Activity log** | Scrolling timestamped event feed |
| **Animated waveform** | Visual indicator of bot connection state |

### REST API

11 endpoints are available under `/api/*` (secured with `ADMIN_API_KEY`):

| Method | Endpoint | Description |
|---|---|---|
| `GET /api/status` | Full bot state snapshot |
| `POST /api/speak` | Clone voice and play text |
| `POST /api/record` | Trigger voice recording |
| `POST /api/join` | Join a voice channel |
| `POST /api/leave` | Leave voice channel |
| `DELETE /api/profiles/:userId` | Delete a voice profile |
| `POST /api/vad` | Update VAD configuration |
| `POST /api/play-reference/:userId` | — |
| `POST /api/play-preset/:presetId` | Play a preset's reference audio sample |
| `POST /api/regenerate-readme` | — |
| `GET /api/health` | Check Python TTS server health |

---

## 🎤 Voice Activity Detection (VAD)

The VAD system automatically monitors the Discord voice connection and triggers voice cloning when users speak.

### How It Works

1. The `VoiceActivityDetector` listens to `receiver.speaking` events from `@discordjs/voice`.
2. When a user starts speaking, their Opus stream is captured and decoded to PCM.
3. After `silenceDurationMs` of silence (default 1200 ms), the recording ends and is converted to `.wav`.
4. If the user has a voice profile → auto-clone and play back.
5. If the user has no profile → auto-create a profile (when `autoProfile` is enabled).

### Configuration

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Master toggle for VAD |
| `silenceDurationMs` | 1200 | Silence threshold before recording ends |
| `cooldownMs` | 8000 | Minimum time between clone triggers |
| `cloneText` | "Hello, I am your voice clone..." | Default text for auto-cloning |
| `listenToAll` | `true` | Listen to all users or only profiled ones |
| `autoClone` | `true` | Automatically clone and play back |
| `autoProfile` | `true` | Auto-save profiles for new users |

---

## 👤 Voice Profiles

Voice profiles are stored in `profiles.json` at the project root with JSON persistence.

### Profile Data

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | Discord user snowflake |
| `username` | `string` | Display name at time of recording |
| `guildId` | `string` | Discord server ID |
| `recordedAt` | `number` | Unix timestamp (ms) |
| `sampleDurationMs` | `number` | Duration of the recorded sample |
| `samplePath` | `string` | Path to the `.wav` file |

---

## 🎭 Voice Presets

ShadowVox ships with **42 built-in voice presets** organized into 8 categories. These let anyone use a famous voice without recording their own — just select a preset and speak.

### Voice Mode

Users can switch between two modes:
- **🎤 Recorded** — Clone your own voice (requires `!record` first)
- **🎭 Presets** — Select from 42 pre-configured celebrity voices

### Categories & Presets

| Category | Emoji | Presets |
|---|---|---|
| **Iconic Voices** | 🎙️ | Morgan Freeman, David Attenborough, James Earl Jones, Fran Drescher, Gilbert Gottfried, Christopher Walken, William Shatner |
| **Hollywood Legends** | 🎬 | Arnold Schwarzenegger, Scarlett Johansson, Samuel L. Jackson, Tom Hanks, Meryl Streep, Keanu Reeves, Robert Downey Jr., Leonardo DiCaprio, Cate Blanchett, Ryan Reynolds, Zendaya |
| **Comedians** | 😂 | Eddie Murphy, Robin Williams, Jim Carrey, Ricky Gervais, Dave Chappelle, Kathy Burke, John Cleese |
| **Animated** | 🐭 | Mickey Mouse, SpongeBob SquarePants, Homer Simpson, Stewie Griffin, Shrek, Elmo |
| **Tech Giants** | 💻 | Steve Jobs, Elon Musk, Bill Gates |
| **Music Icons** | 🎵 | Taylor Swift, Beyoncé, Drake, Elvis Presley |
| **Political** | 🌍 | Barack Obama, Winston Churchill |
| **Sci-Fi & Fantasy** | 🚀 | Yoda, Gollum / Sméagol |

### Commands

| Command | Description |
|---|---|
| `!voice list` | Show all 42 presets grouped by category with availability status |
| `!voice <name>` | Select a preset (fuzzy matching: `!voice morgan` → Morgan Freeman) |
| `!voice off` | Clear preset selection, return to your recorded voice |
| `!say <text>` | Speaks through the active preset (if selected) or your recorded profile |

### How Presets Work

1. Reference audio files are stored in `presets/{presetId}.wav`
2. When a preset is selected, the bot uses that reference instead of your recorded profile
3. The Python XTTS-v2 engine clones the voice from the reference and speaks your text
4. VAD auto-cloning also respects the active preset

### Generating Preset Audio Files

A Python script is provided to generate unique reference samples for all 42 presets:

```bash
# Generate all 42 presets
python3 python/generate_presets.py

# Regenerate existing files
python3 python/generate_presets.py --force

# Generate a single preset
python3 python/generate_presets.py --preset yoda

# See what would be generated
python3 python/generate_presets.py --dry-run
```

The script uses gTTS (Google Text-to-Speech) + Python's built-in `audioop` module to create unique-sounding voices with different pitches, rates, and filters. For best quality, replace generated files with real voice samples.

### Dashboard Integration

The Control Center (`localhost:3000`) lets you:
- Browse presets with a category filter dropdown
- Click any preset chip to select it
- Click the ▶ button on any available preset to hear its raw reference audio
- Type text and transmit it through the selected preset voice

---

## 📁 Project Structure

```
📄 LICENSE
📁 python
  📄 python/requirements.txt
  📄 python/tts_server.py
  📄 python/generate_presets.py
📄 package.json
📄 tsconfig.json
📄 .env.example
📁 src
  📄 src/index.ts
  📄 src/recorder.ts
  📄 src/cloner.ts
  📄 src/player.ts
  📄 src/profiles.ts
  📄 src/vad.ts
  📄 src/admin-server.ts
  📄 src/docs-generator.ts
  📄 src/instrument.ts
  📄 src/presets.ts
📁 convex
📄 bun.lock
📄 tsconfig.tsbuildinfo
📁 dashboard
  📄 dashboard/index.html
  📄 dashboard/style.css
  📄 dashboard/app.js
📁 presets
  📄 presets/yoda.wav
  📄 presets/morgan-freeman.wav
  📄 presets/david-attenborough.wav
  📄 presets/james-earl-jones.wav
  📄 presets/fran-drescher.wav
  📄 presets/gilbert-gottfried.wav
  📄 presets/christopher-walken.wav
  📄 presets/william-shatner.wav
  📄 presets/arnold-schwarzenegger.wav
  📄 presets/scarlett-johansson.wav
  📄 presets/samuel-l-jackson.wav
  📄 presets/tom-hanks.wav
  📄 presets/meryl-streep.wav
  📄 presets/keanu-reeves.wav
  📄 presets/robert-downey-jr.wav
  📄 presets/leonardo-dicaprio.wav
  📄 presets/cate-blanchett.wav
  📄 presets/ryan-reynolds.wav
  📄 presets/zendaya.wav
  📄 presets/eddie-murphy.wav
  📄 presets/robin-williams.wav
  📄 presets/jim-carrey.wav
  📄 presets/ricky-gervais.wav
  📄 presets/dave-chappelle.wav
  📄 presets/kathy-burke.wav
  📄 presets/john-cleese.wav
  📄 presets/mickey-mouse.wav
  📄 presets/spongebob.wav
  📄 presets/homer-simpson.wav
  📄 presets/stewie-griffin.wav
  📄 presets/shrek.wav
  📄 presets/elmo.wav
  📄 presets/steve-jobs.wav
  📄 presets/elon-musk.wav
  📄 presets/bill-gates.wav
  📄 presets/taylor-swift.wav
  📄 presets/beyonce.wav
  📄 presets/drake.wav
  📄 presets/elvis-presley.wav
  📄 presets/barack-obama.wav
  📄 presets/winston-churchill.wav
  📄 presets/gollum.wav
```

---

## 📦 Dependencies

### Node.js (11 runtime + 5 dev)

| Package | Version | Purpose |
|---|---|---|
| `@discordjs/opus` | `^0.9.0` | Native Opus encoding/decoding |
| `@discordjs/voice` | `^0.16.1` | Discord voice API integration |
| `@sentry/node` | `^8.30.0` | Error tracking and performance monitoring |
| `axios` | `^1.7.2` | HTTP client for Python API calls |
| `cors` | `^2.8.5` | CORS middleware for admin panel |
| `discord.js` | `^14.15.3` | Discord bot framework |
| `dotenv` | `^16.4.5` | Environment variable loading |
| `express` | `^4.19.2` | Admin web server |
| `express-rate-limit` | `^7.4.1` | — |
| `helmet` | `^8.0.0` | — |
| `prism-media` | `^1.3.5` | Audio stream transcoding |

### Python (8 packages)

```
TTS>=0.22.0
fastapi>=0.111.0
uvicorn[standard]>=0.30.1
torch>=2.3.0
torchaudio>=2.3.0
soundfile>=0.12.1
pydub>=0.25.1
gTTS>=2.5.0
```

---

## 🐍 Python TTS Server

The Python FastAPI server (`python/tts_server.py`) loads XTTS-v2 and exposes:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Check if the model is loaded |
| `/clone` | POST | Clone a voice (`{ user_id, text, language }`) |

Run with:
```bash
cd python
python tts_server.py
# Server starts on http://127.0.0.1:8000
```

---

## 🔑 Environment Variables

9 variables are configurable via `.env`:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ Yes | Get yours from https://discord.com/developers/applications |
| `PYTHON_API_URL` | ❌ No | Python TTS API URL (default: http://127.0.0.1:8000) |
| `TARGET_GUILD_ID` | ❌ No | Target guild (server) ID for auto-join (optional) |
| `TARGET_VOICE_CHANNEL_ID` | ❌ No | Target voice channel ID to auto-join (optional) |
| `ADMIN_PORT` | ❌ No | Admin server listens on this port (default: 3000) |
| `ADMIN_DISABLED` | ❌ No | Set to "true" to disable the admin web server |
| `ADMIN_API_KEY` | ❌ No | Optional API key for securing admin endpoints |
| `SENTRY_DSN` | ❌ No | SENTRY_TRACES_SAMPLE_RATE controls performance tracing (0.0-1.0, defaults to 0.1) |
| `SENTRY_TRACES_SAMPLE_RATE` | ❌ No | — |

---

## 🛠 Development

### Scripts

| Script | Command | Description |
|---|---|---|
| `install:bot` | `bun install` | Install dependencies |
| `install:python` | `cd python && pip install -r requirements.txt` | Install dependencies |
| `install` | `bun run install:bot && bun run install:python` | Install dependencies |
| `dev:bot` | `bun run src/index.ts` | Start in development mode |
| `dev:python` | `cd python && python tts_server.py` | Start in development mode |
| `dev` | `echo 'Run dev:bot and dev:python in separate terminals'` | Start in development mode |
| `build` | `tsc` | Compile TypeScript |
| `start` | `node dist/index.js` | Run compiled output |

### Data Flow Diagram

```
Discord Voice Channel
  │
  ▼
┌─────────────────────┐     ┌─────────────────────┐
│  !join / !record    │     │  Voice Activity      │
│  (prefix commands)  │     │  Detection (VAD)     │
└─────────┬───────────┘     └──────────┬──────────┘
          │                            │
          └──────────┬─────────────────┘
                     ▼
           ┌─────────────────┐
           │  recorder.ts    │
           │  Opus → PCM →   │
           │  WAV via FFmpeg │
           └────────┬────────┘
                    │
                    ▼
           ┌─────────────────┐     ┌─────────────────┐
           │  cloner.ts      │────►│  Python TTS     │
           │  HTTP client    │     │  (XTTS-v2)      │
           └────────┬────────┘     └────────┬────────┘
                    │                       │
                    └──────────┬────────────┘
                               ▼
                     ┌─────────────────┐
                     │  player.ts      │
                     │  Play in VC     │
                     └─────────────────┘
```

---

<p align="center">
  <sub>Generated automatically by <strong>/generate-readme</strong> • ShadowVox v1.0.0</sub>
  <br />
  <sub>🕐 <strong>Last updated:</strong> 2026-07-14 12:13:32 UTC</sub>
</p>
