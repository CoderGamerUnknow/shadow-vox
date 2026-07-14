# 🎤 ShadowVox V2.0.0 — The V2 Upgrade

Real-time voice cloning Discord bot powered by `discord.js` audio streams and a local Python **XTTS-v2** neural engine.

## 🚀 Four Major New Features

### V2.1 🔒 Consent & Privacy Safeguard
Before recording any user's voice, the bot requests explicit permission via ephemeral Discord DMs with **Approve** and **Deny** buttons. The VAD system checks consent state before capturing any audio.

- Consent state machine: `pending` → `approved` → `denied`
- Ephemeral button prompts on VC join
- VAD integration — blocks recording if consent not given
- Commands: `!consent status`, `!consent approve`, `!consent deny`
- API: `GET/POST /api/consent/:userId`

### V2.2 🎛️ Voicelab Audio Effects
Synthesized audio is piped through an FFmpeg-based effects engine before playback.

| Effect | Description |
|---|---|
| 📻 Walkie-Talkie | Bandpass filter (300-3400Hz) + radio compression |
| 👹 Demon | Pitch shift down 8 semitones + distortion |
| 🌊 Echo/Reverb | Multi-tap reverb with space and depth |
| 🎤 None | Natural voice — no processing |

- Commands: `!effect list`, `!effect walkie-talkie`, `!effect demon`, `!effect echo`
- API: `GET /api/effects`
- Dashboard: Effect selector dropdown in Live Mimic Console

### V2.3 🗣️ Voice-to-Voice Mode
Speak naturally and the bot repeats what you said — in someone else's cloned voice. A complete **STT → TTS** pipeline running locally.

1. User A speaks in the voice channel
2. Whisper-tiny (local) transcribes the speech to text
3. XTTS-v2 clones User B's voice and speaks the transcribed text
4. The cloned audio is played back in the voice channel

- Commands: `!v2v on/off`, `!v2v target @user`, `!v2v status`
- API: `POST /api/v2v`
- Dashboard: V2V toggle with target selector
- Supports all Voicelab effects

### V2.4 📊 Live Audio Waveform
Real-time audio amplitude visualization streamed to the Web Dashboard via WebSockets.

- WebSocket server on admin panel port
- `broadcastAmplitude()` pushes real-time data
- Smooth canvas animation with glow effects
- Auto-reconnect on disconnect

## 🐳 Production Deployment

New deployment infrastructure:
- **Dockerfile** — Multi-stage build with Python TTS + Bun bot
- **docker-compose.yml** — Orchestrated services with healthchecks
- **deploy.sh** — One-command deploy: `bash deploy.sh --docker` or `--bare`
- **GPU support**: `bash deploy.sh --docker --gpu` for CUDA acceleration

## 🛡️ Security (15 Hardening Layers)

Shell injection prevention, path traversal prevention, rate limiting, security headers (Helmet CSP, HSTS), error message sanitization, input validation, XSS prevention, timing-safe API key comparison, body size limit.

## ⚕️ Self-Healing System

- Autonomous `src/self-heal.ts` engine
- Daily cron job at 3 AM with lockfile protection
- Auto-creates GitHub Issues for problems found
- CI workflow with quality gate

## 📊 Stats

- **Source lines**: ~3,200 TypeScript + Python
- **Test coverage**: 71 tests, 169 assertions
- **Voice presets**: 42 pre-configured
- **API endpoints**: 15 REST + 1 WebSocket + 1 Python

## 🔧 How to Deploy

```bash
git clone https://github.com/CoderGamerUnknow/shadow-vox.git
cd shadow-vox
cp .env.example .env
nano .env
bash deploy.sh --docker
pip install openai-whisper
open http://localhost:3000
```

## 📋 Full Changelog

- V2 Consent & Privacy — consent state, button handlers, VAD integration
- V2 Voicelab Effects — Walkie-Talkie, Demon, Echo in Python + TypeScript
- V2 Voice-to-Voice — Whisper STT pipeline with XTTS cloning
- V2 Live Waveform — WebSocket streaming + canvas visualization
- Production Dockerfile, docker-compose, deploy scripts
- Self-healing AI engine with auto-fix and CI integration
- CI workflow with auto-commit back and issue creation
- Production cron job with lockfile and auto-rotation
- 42 voice presets with audio generation script
- Admin dashboard with preset browser, play buttons, logs
- /generate-readme slash command
- 15 security hardening layers
- 71 comprehensive integration + security tests
