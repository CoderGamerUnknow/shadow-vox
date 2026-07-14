# 🎤 ShadowVox V3.0.0 — The Security & Stability Release

## 🔐 Major New Security Layer: INTERNAL_API_KEY

Every HTTP request between the Node.js Discord bot and the Python TTS engine now requires a shared secret key (`INTERNAL_API_KEY`). This prevents unauthorized access to the voice-cloning pipeline.

| Feature | Details |
|---|---|
| **X-API-KEY header** | All requests carry the key in the header |
| **403 on mismatch** | Python rejects unauthorized requests with 403 Forbidden |
| **Graceful fallback** | No key configured = dev mode (local still works) |
| **Env var doc** | `INTERNAL_API_KEY` documented in `.env.example` |

## 🐛 Bugs Fixed

- **Redundant V2V clone** — VAD's Voice-to-Voice mode was calling `generateClonedVoice()` with placeholder text BEFORE `sendVoiceToVoice()`, wasting compute. Now only `sendVoiceToVoice()` runs.
- **Duplicate FFmpeg functions** — `convertPcmToWav` and `convertPcmToWavCustom` were identical code duplicated across `src/recorder.ts`. Consolidated into single `convertPcmToWavCore`.
- **Comment duplication** — Fixed duplicated text in `handleVoice` comment.

## 🛡️ Security Layer 16 Added

| # | Layer | Severity |
|---|---|---|
| 16 | **INTERNAL_API_KEY auth** — Python FastAPI verifies `X-API-KEY` on `/clone`, `/health`, `/voice-to-voice`. Node.js sends it on every request. | 🔴 Critical |

## ✅ Two-Pass Pre-Flight Audit

- **Pass 1**: Read all 13+ source files, audited all imports, types, and paths — zero issues found
- **Pass 2**: Edge-case review — WebSocket disconnects, null VAD connections, stream errors, redundant calls — all fixed

## 📦 Full Testing Verification

- ✅ **0 TypeScript errors** (`bun tsc -b --noEmit`)
- ✅ **71/71 tests passing** (169 expect() calls across 2 test files)
- ✅ **README regenerated** with V3 security section (29.5 KB)
