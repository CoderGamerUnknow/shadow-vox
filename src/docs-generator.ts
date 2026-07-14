/**
 * ShadowVox - README Generator
 *
 * Dynamically scans the project workspace and generates a beautiful,
 * professional `README.md` at the project root.
 *
 * Usage (via Discord slash command /generate-readme):
 *   Reads the active command list, project structure, dependencies,
 *   Python requirements, and environment variables, then writes a
 *   polished markdown document with a live "Last Updated" timestamp.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, basename, extname, sep } from "node:path";

// ── Scanning helpers ──────────────────────────────────────────────────────

interface ProjectTreeEntry {
  path: string;
  isDir: boolean;
}

/**
 * Recursively collect the project file tree, excluding noise directories.
 */
function scanProjectTree(root: string): ProjectTreeEntry[] {
  const excludeDirs = new Set([
    ".git",
    "node_modules",
    "recordings",
    "output",
    "dist",
    ".convex",
    ".vite",
  ]);
  const entries: ProjectTreeEntry[] = [];

  function walk(dir: string) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") && name !== ".env.example") continue;
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir && excludeDirs.has(name)) continue;
      const rel = relative(root, full);
      entries.push({ path: rel, isDir });
      if (isDir) walk(full);
    }
  }

  walk(root);
  return entries;
}

/**
 * Extract all prefix-command names from the bot source by scanning
 * the command-handler switch statement in index.ts.
 */
function extractCommands(root: string): string[] {
  const indexPath = join(root, "src", "index.ts");
  if (!existsSync(indexPath)) return [];

  const content = readFileSync(indexPath, "utf-8");
  const commands: string[] = [];
  // Match patterns like: case "join":    case "leave":    case "profiles":
  const caseRegex = /case\s+"([a-z][a-z0-9_-]+)":/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(content)) !== null) {
    if (!commands.includes(match[1])) {
      commands.push(match[1]);
    }
  }
  return commands.sort();
}

/**
 * Extract admin REST API routes from admin-server.ts.
 */
function extractAdminApiRoutes(root: string): string[] {
  const adminPath = join(root, "src", "admin-server.ts");
  if (!existsSync(adminPath)) return [];

  const content = readFileSync(adminPath, "utf-8");
  const routes: string[] = [];
  const routeRegex = /app\.(get|post|put|delete)\("(\/api\/[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(content)) !== null) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return routes;
}

/**
 * Read the package.json and return key sections.
 */
function readPackageInfo(root: string) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return {
      name: pkg.name ?? "shadow-vox",
      version: pkg.version ?? "0.0.0",
      description: pkg.description ?? "",
      scripts: pkg.scripts ?? {},
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Read Python requirements file.
 */
function readPythonReqs(root: string): string[] {
  const reqPath = join(root, "python", "requirements.txt");
  if (!existsSync(reqPath)) return [];
  const content = readFileSync(reqPath, "utf-8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Read .env.example and extract variable names and comments.
 */
function readEnvTemplate(root: string): Array<{ var: string; comment: string }> {
  const envPath = join(root, ".env.example");
  if (!existsSync(envPath)) return [];
  const content = readFileSync(envPath, "utf-8");
  const vars: Array<{ var: string; comment: string }> = [];
  let currentComment = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      currentComment = trimmed.replace(/^#\s*/, "");
    } else if (trimmed.includes("=")) {
      const varName = trimmed.split("=")[0].trim();
      vars.push({ var: varName, comment: currentComment });
      currentComment = "";
    }
  }
  return vars;
}

/**
 * Count lines of TypeScript source code.
 */
function countSourceLines(root: string): number {
  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) return 0;
  let total = 0;
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".ts")) {
        total += readFileSync(full, "utf-8").split("\n").length;
      }
    }
  }
  walk(srcDir);
  return total;
}

// ── Generator ─────────────────────────────────────────────────────────────

export function generateReadme(projectRoot?: string): { path: string; size: number } {
  const root = projectRoot ?? process.cwd();

  // ── Gather dynamic data ──
  const pkg = readPackageInfo(root);
  const commands = extractCommands(root);
  const adminRoutes = extractAdminApiRoutes(root);
  const pyReqs = readPythonReqs(root);
  const envVars = readEnvTemplate(root);
  const srcLines = countSourceLines(root);
  const tree = scanProjectTree(root);

  const version = pkg?.version ?? "0.0.0";
  const now = new Date();
  const timestamp = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // ── Build markdown ──
  const md = `# 🎤 ShadowVox

> **Real-time voice cloning Discord bot** powered by \`discord.js\` audio streams
> and a local Python **XTTS-v2** neural engine.

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v${version}-8b5cf6" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.5-3178c6" />
  <img alt="Python" src="https://img.shields.io/badge/Python-3.10+-3776AB" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="Lines" src="https://img.shields.io/badge/source-${srcLines.toLocaleString()}_lines-22d3ee" />
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
- [Security](#-security)
- [Environment Variables](#-environment-variables)
- [Development](#-development)

---

## 🏗 Architecture

\`\`\`
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
\`\`\`

### Data Flow

1. **Capture** — Bot joins a Discord voice channel and subscribes to a user's Opus audio stream via \`@discordjs/voice\`.
2. **Decode** — Raw Opus packets are decoded into 48 kHz, 16-bit signed PCM using \`prism-media\`.
3. **Convert** — FFmpeg converts the PCM data into a clean \`.wav\` file on disk.
4. **Clone** — The \`.wav\` reference is posted to the local Python TTS API (\`http://127.0.0.1:8000/clone\`), which runs XTTS-v2.
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

\`\`\`bash
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
\`\`\`

### First-Time Use in Discord

1. Invite the bot to your server using the invite link printed at startup.
2. Join a voice channel.
3. Type \`!join\` to have the bot join you.
4. Type \`!record\` to capture your voice profile (speak for 3+ seconds).
5. Type \`!say Hello, this is my cloned voice!\` to hear yourself.

---

## 💬 Prefix Commands

All commands use the \`!\` prefix. ${commands.length} commands are registered.

| Command | Description |
|---|---|
${commands
  .map((cmd) => {
    const descriptions: Record<string, string> = {
      join: "Join your current voice channel and start VAD",
      leave: "Leave the voice channel and stop VAD",
      record: "Record a voice profile for yourself or a mentioned user",
      say: "Clone your voice and speak the provided text",
      profile: "Show details for a specific user's voice profile",
      profiles: "List all saved voice profiles",
      deleteprofile: "Delete a user's voice profile",
      setclone: "Set the default text for VAD auto-cloning",
      voice: "List and select from 42 voice presets (Morgan Freeman, Yoda, etc.)",
      vad: "Manage Voice Activity Detection settings",
      ping: "Check if the bot is alive",
      health: "Check if the Python TTS server is running",
    };
    return `| \`!${cmd}\` | ${descriptions[cmd] || "—"} |`;
  })
  .join("\n")}

### VAD Sub-Commands

| Sub-command | Description |
|---|---|
| \`!vad on\` / \`!vad off\` | Toggle voice activity detection |
| \`!vad status\` | Show current VAD configuration |
| \`!vad clone\` / \`!vad noclone\` | Enable/disable auto-cloning |
| \`!vad all\` / \`!vad profiles\` | Listen to all users or only profiled ones |
| \`!vad silence <ms>\` | Set the silence threshold (200–5000 ms) |
| \`!vad cooldown <s>\` | Set the clone cooldown (1–60 s) |

---

## 🌐 Admin Web Panel

An embedded Express admin server provides a real-time dashboard and REST API.

### Dashboard

Open \`http://localhost:3000\` (configurable via \`ADMIN_PORT\`) to access:

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

${adminRoutes.length} endpoints are available under \`/api/*\` (secured with \`ADMIN_API_KEY\`):

| Method | Endpoint | Description |
|---|---|---|
${adminRoutes.map((route) => {
  const [method, path] = route.split(" ");
  const descs: Record<string, string> = {
    "GET /api/status": "Full bot state snapshot",
    "POST /api/speak": "Clone voice and play text",
    "POST /api/record": "Trigger voice recording",
    "POST /api/join": "Join a voice channel",
    "POST /api/leave": "Leave voice channel",
    "DELETE /api/profiles/:userId": "Delete a voice profile",
    "POST /api/vad": "Update VAD configuration",
    "POST /api/play-preset/:presetId": "Play a preset's reference audio sample",
    "GET /api/health": "Check Python TTS server health",
  };
  return `| \`${route}\` | ${descs[route] || "—"} |`;
}).join("\n")}

---

## 🎤 Voice Activity Detection (VAD)

The VAD system automatically monitors the Discord voice connection and triggers voice cloning when users speak.

### How It Works

1. The \`VoiceActivityDetector\` listens to \`receiver.speaking\` events from \`@discordjs/voice\`.
2. When a user starts speaking, their Opus stream is captured and decoded to PCM.
3. After \`silenceDurationMs\` of silence (default 1200 ms), the recording ends and is converted to \`.wav\`.
4. If the user has a voice profile → auto-clone and play back.
5. If the user has no profile → auto-create a profile (when \`autoProfile\` is enabled).

### Configuration

| Setting | Default | Description |
|---|---|---|
| \`enabled\` | \`true\` | Master toggle for VAD |
| \`silenceDurationMs\` | 1200 | Silence threshold before recording ends |
| \`cooldownMs\` | 8000 | Minimum time between clone triggers |
| \`cloneText\` | "Hello, I am your voice clone..." | Default text for auto-cloning |
| \`listenToAll\` | \`true\` | Listen to all users or only profiled ones |
| \`autoClone\` | \`true\` | Automatically clone and play back |
| \`autoProfile\` | \`true\` | Auto-save profiles for new users |

---

## 👤 Voice Profiles

Voice profiles are stored in \`profiles.json\` at the project root with JSON persistence.

### Profile Data

| Field | Type | Description |
|---|---|---|
| \`userId\` | \`string\` | Discord user snowflake |
| \`username\` | \`string\` | Display name at time of recording |
| \`guildId\` | \`string\` | Discord server ID |
| \`recordedAt\` | \`number\` | Unix timestamp (ms) |
| \`sampleDurationMs\` | \`number\` | Duration of the recorded sample |
| \`samplePath\` | \`string\` | Path to the \`.wav\` file |

---

## 🎭 Voice Presets

ShadowVox ships with **42 built-in voice presets** organized into 8 categories. These let anyone use a famous voice without recording their own — just select a preset and speak.

### Voice Mode

Users can switch between two modes:
- **🎤 Recorded** — Clone your own voice (requires \`!record\` first)
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
| \`!voice list\` | Show all 42 presets grouped by category with availability status |
| \`!voice <name>\` | Select a preset (fuzzy matching: \`!voice morgan\` → Morgan Freeman) |
| \`!voice off\` | Clear preset selection, return to your recorded voice |
| \`!say <text>\` | Speaks through the active preset (if selected) or your recorded profile |

### How Presets Work

1. Reference audio files are stored in \`presets/{presetId}.wav\`
2. When a preset is selected, the bot uses that reference instead of your recorded profile
3. The Python XTTS-v2 engine clones the voice from the reference and speaks your text
4. VAD auto-cloning also respects the active preset

### Generating Preset Audio Files

A Python script is provided to generate unique reference samples for all 42 presets:

\`\`\`bash
# Generate all 42 presets
python3 python/generate_presets.py

# Regenerate existing files
python3 python/generate_presets.py --force

# Generate a single preset
python3 python/generate_presets.py --preset yoda

# See what would be generated
python3 python/generate_presets.py --dry-run
\`\`\`

The script uses gTTS (Google Text-to-Speech) + Python's built-in \`audioop\` module to create unique-sounding voices with different pitches, rates, and filters. For best quality, replace generated files with real voice samples.

### Dashboard Integration

The Control Center (\`localhost:3000\`) lets you:
- Browse presets with a category filter dropdown
- Click any preset chip to select it
- Click the ▶ button on any available preset to hear its raw reference audio
- Type text and transmit it through the selected preset voice

---

## 📁 Project Structure

\`\`\`
${tree
  .map((e) => {
    const depth = e.path.split("/").length - 1;
    const indent = "  ".repeat(depth);
    const icon = e.isDir ? "📁" : "📄";
    return `${indent}${icon} ${e.path}`;
  })
  .join("\n")}
\`\`\`

---

## 📦 Dependencies

### Node.js (${Object.keys(pkg?.dependencies ?? {}).length} runtime + ${Object.keys(pkg?.devDependencies ?? {}).length} dev)

| Package | Version | Purpose |
|---|---|---|
${Object.entries(pkg?.dependencies ?? {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, ver]) => {
    const    purposes: Record<string, string> = {
      "@discordjs/opus": "Native Opus encoding/decoding",
      "@discordjs/voice": "Discord voice API integration",
      "@sentry/node": "Error tracking and performance monitoring",
      axios: "HTTP client for Python API calls",
      cors: "CORS middleware for admin panel",
      "discord.js": "Discord bot framework",
      dotenv: "Environment variable loading",
      express: "Admin web server",
      "express-rate-limit": "API rate limiting (60/min general, 10/min sensitive)",
      helmet: "Security headers (CSP, HSTS, X-Frame-Options, etc.)",
      "prism-media": "Audio stream transcoding",
    };
    return `| \`${name}\` | \`${ver}\` | ${purposes[name] || "—"} |`;
  })
  .join("\n")}

### Python (${pyReqs.length} packages)

\`\`\`
${pyReqs.join("\n")}
\`\`\`

---

## 🐍 Python TTS Server

The Python FastAPI server (\`python/tts_server.py\`) loads XTTS-v2 and exposes:

| Endpoint | Method | Description |
|---|---|---|
| \`/health\` | GET | Check if the model is loaded |
| \`/clone\` | POST | Clone a voice (\`{ user_id, text, language }\`) |

Run with:
\`\`\`bash
cd python
python tts_server.py
# Server starts on http://127.0.0.1:8000
\`\`\`

---

## 🔑 Environment Variables

${envVars.length} variables are configurable via \`.env\`:

| Variable | Required | Description |
|---|---|---|
${envVars
  .map((v) => {
    const required = ["DISCORD_BOT_TOKEN"].includes(v.var) ? "✅ Yes" : "❌ No";
    return `| \`${v.var}\` | ${required} | ${v.comment || "—"} |`;
  })
  .join("\n")}

---

## 🛡️ Security

ShadowVox has been hardened with **15 security layers** covering shell injection, path traversal, rate limiting, XSS, CSRF, and more.

### Hardening Layers

| # | Layer | Severity | File(s) |
|---|---|---|---|
| 1 | **Shell injection prevention** — FFmpeg conversion uses \`spawn\` with array arguments instead of \`exec\` with string interpolation | 🔴 Critical | \`src/recorder.ts\` |
| 2 | **Path traversal prevention (Python)** — User IDs are sanitized with regex before filesystem operations; custom \`speaker_wav_path\` is validated to stay within the project directory | 🔴 Critical | \`python/tts_server.py\` |
| 3 | **Path traversal prevention (TypeScript)** — Speaker WAV paths are resolved to absolute paths and checked to ensure they start with the project root | 🟠 High | \`src/cloner.ts\` |
| 4 | **Rate limiting** — All API routes are limited to 60 requests/minute; sensitive endpoints (\`/api/speak\`, \`/api/record\`) are limited to 10 requests/minute | 🟠 High | \`src/admin-server.ts\` |
| 5 | **Security headers (Helmet)** — Content Security Policy, X-Frame-Options, HSTS, X-Content-Type-Options, and other HTTP security headers are set on all responses | 🟠 High | \`src/admin-server.ts\` |
| 6 | **Content Security Policy** — Script, style, font, and connection sources are explicitly restricted to allowed origins only | 🟠 High | \`src/admin-server.ts\` |
| 7 | **Error message sanitization** — Stack traces and internal error details are never leaked to Discord users; errors are truncated to 200 characters and stripped of newlines | 🟠 High | \`src/index.ts\` |
| 8 | **Input validation** — Text input is limited to 500 characters, control characters are stripped, and all user-provided text is validated before processing | 🟡 Medium | \`src/admin-server.ts\`, \`src/index.ts\` |
| 9 | **XSS prevention** — All user-facing data in the dashboard is escaped using DOM-based \`escapeHtml()\` helper (emoji, IDs, names, categories) | 🟡 Medium | \`dashboard/app.js\` |
| 10 | **Timing-safe API key comparison** — \`crypto.timingSafeEqual\` is used for API key verification instead of standard string comparison, preventing timing attacks | 🟡 Medium | \`src/admin-server.ts\` |
| 11 | **API key not in URL** — Dashboard prompts for credentials via sessionStorage instead of reading from URL parameters, avoiding leakage through browser history and referrer headers | 🟡 Medium | \`dashboard/app.js\` |
| 12 | **Body size limit** — Request body parsing is limited to 100 KB (down from 1 MB), preventing large-payload attacks | 🟡 Medium | \`src/admin-server.ts\` |
| 13 | **Removed deprecated Sentry integration** — Outdated \`nodeContextIntegration()\` API call removed, replaced with Sentry v8 default integrations | ℹ️ Low | \`src/instrument.ts\` |
| 14 | **VAD async handling** — \`onSpeakingStart\` now properly awaits and catches errors from \`recordUserVoice\` with structured try/catch instead of promise chains | ℹ️ Low | \`src/vad.ts\` |
| 15 | **Empty catch block removed** — Removed a dead NOOP try/catch in the auto-profile section that was silently swallowing errors | ℹ️ Low | \`src/vad.ts\` |

### Security Best Practices

- **Environment variables** — All secrets are managed through \`.env\` (gitignored). Never commit \`.env\` to version control.
- **Principle of least privilege** — The Discord bot token only requires minimal permissions (connect, speak, read messages). No admin server permissions are needed.
- **Input sanitization** — All user-provided text is sanitized (control chars removed, length-limited) before reaching the TTS engine or being stored.
- **Rate limiting** — API abuse is mitigated with multi-tier rate limiting. The admin panel is local-only by default.
- **Dependency auditing** — Run \`npm audit\` or \`bun audit\` regularly to check for known vulnerabilities in dependencies.
- **Python server isolation** — The TTS server binds only to \`127.0.0.1\` (localhost), not exposed to the network.

### Reporting Vulnerabilities

If you discover a security vulnerability, please open an issue on GitHub or contact the maintainers directly. Do not disclose security issues in public Discord channels.

---

## 🛠 Development

### Scripts

| Script | Command | Description |
|---|---|---|
${Object.entries(pkg?.scripts ?? {})
  .map(([name, cmd]) => {
    return `| \`${name}\` | \`${cmd}\` | ${name.includes("dev") ? "Start in development mode" : name.includes("install") ? "Install dependencies" : name.includes("build") ? "Compile TypeScript" : name.includes("start") ? "Run compiled output" : "—"} |`;
  })
  .join("\n")}

### Data Flow Diagram

\`\`\`
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
\`\`\`

---

<p align="center">
  <sub>Generated automatically by <strong>/generate-readme</strong> • ShadowVox v${version}</sub>
  <br />
  <sub>🕐 <strong>Last updated:</strong> ${timestamp}</sub>
</p>
`;

  // ── Write ──
  const outputPath = join(root, "README.md");
  writeFileSync(outputPath, md, "utf-8");
  const size = Buffer.byteLength(md, "utf-8");

  console.log(`📝 README.md generated (${(size / 1024).toFixed(1)} KB) → ${outputPath}`);
  return { path: outputPath, size };
}
