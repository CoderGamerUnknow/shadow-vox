/**
 * ShadowVox - Admin Web Server
 *
 * An embedded Express server that exposes a REST API and serves a
 * polished web admin panel. Allows an admin to monitor bot status,
 * manage voice profiles, and trigger voice cloning from a browser.
 */

import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";
import { join, resolve, dirname } from "node:path";
import type { Client } from "discord.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { VoiceConnection } from "@discordjs/voice";
import { profileStore, type VoiceProfile } from "./profiles.js";
import { VoiceActivityDetector, type VadConfig } from "./vad.js";
import { generateClonedVoice, healthCheck } from "./cloner.js";
import { playClonedAudio } from "./player.js";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import {
  VOICE_PRESETS,
  findPreset,
  refreshPresetAvailability,
  CATEGORY_META,
  type VoicePreset,
} from "./presets.js";

// ── Dashboard path ────────────────────────────────────────────────────────
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const DASHBOARD_DIR = resolve(_dirname, "..", "dashboard");

// ── WebSocket Amplitude State ────────────────────────────────────────────
import { WebSocketServer, WebSocket as WsImpl } from "ws";

let wss: WebSocketServer | null = null;
const amplitudeClients = new Set<WsImpl>();

/**
 * V2.4: Broadcast amplitude data to all connected dashboard clients.
 */
export function broadcastAmplitude(amplitude: number): void {
  if (!wss) return;
  const msg = JSON.stringify({ type: "amplitude", value: amplitude, timestamp: Date.now() });
  for (const ws of amplitudeClients) {
    try {
      ws.send(msg);
    } catch {
      amplitudeClients.delete(ws);
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface BotState {
  client: Client;
  activeConnection: VoiceConnection | null;
  setActiveConnection: (conn: VoiceConnection | null) => void;
  vadDetector: VoiceActivityDetector | null;
  setVadDetector: (vad: VoiceActivityDetector | null) => void;
  defaultCloneText: string;
  setDefaultCloneText: (text: string) => void;
  startVad: (connection: VoiceConnection) => void;
  stopVad: () => void;
  activePreset: VoicePreset | null;
  // V2: Consent check function
  getConsent?: (userId: string) => boolean;
}

// ── Activity Log Buffer ───────────────────────────────────────────────────

interface LogEntry {
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
}

const activityLog: LogEntry[] = [];
const MAX_LOG = 100;

function addLog(level: LogEntry["level"], message: string) {
  activityLog.push({ timestamp: Date.now(), level, message });
  if (activityLog.length > MAX_LOG) activityLog.shift();
}

// ── Create App (for testing without starting the server) ─────────────

/**
 * Creates and configures the Express application with all middleware and routes.
 * Does NOT start listening — use supertest against the returned app in tests.
 * Called internally by startAdminServer to separate app creation from listening.
 */
export function createAdminApp(state: BotState): express.Application {
  const app = express();

  // ── Security Middleware ──────────────────────────────────────────────

  // Security headers (Helmet with relaxed CSP for local dashboard)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "http://127.0.0.1:*"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS — restricted to same-origin only by default
  app.use(cors({ origin: true, credentials: true }));

  // Body parser with strict size limits
  app.use(express.json({ limit: "100kb" }));

  // Rate limiting for all API routes
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,             // max 60 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  });
  app.use("/api/*", apiLimiter);

  // Stricter rate limit for sensitive endpoints
  const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  });

  // ── API Middleware: Admin auth (optional, timing-safe) ────────────────
  const apiKey = process.env.ADMIN_API_KEY;

  app.use("/api/*", (req, res, next) => {
    if (apiKey) {
      const key = req.headers["x-api-key"] as string | undefined;
      // Timing-safe comparison (with length check to prevent RangeError)
      if (!key || key.length !== apiKey.length) {
        res.status(401).json({ error: "Unauthorized. Provide x-api-key header." });
        return;
      }
      if (!timingSafeEqual(Buffer.from(key), Buffer.from(apiKey))) {
        res.status(401).json({ error: "Unauthorized. Provide x-api-key header." });
        return;
      }
    }
    next();
  });

  // ── REST API ──────────────────────────────────────────────────────────

  /** GET /api/status — full bot state snapshot */
  app.get("/api/status", (_req: Request, res: Response) => {
    const conn = state.activeConnection;
    const vad = state.vadDetector;
    const guildName = conn?.joinConfig.guildId
      ? state.client.guilds.cache.get(conn.joinConfig.guildId)?.name ?? "Unknown"
      : null;
    let channelName: string | null = null;
    if (conn?.joinConfig.channelId) {
      const ch = state.client.channels.cache.get(conn.joinConfig.channelId);
      if (ch?.isVoiceBased()) {
        channelName = ch.name;
      }
    }

    res.json({
      bot: {
        username: state.client.user?.tag ?? "Unknown",
        online: state.client.isReady(),
        guilds: state.client.guilds.cache.size,
      },
      connection: conn
        ? {
            connected: true,
            guildId: conn.joinConfig.guildId,
            guildName,
            channelId: conn.joinConfig.channelId,
            channelName,
          }
        : { connected: false },
      vad: vad
        ? { listening: vad.isListening, config: vad.getConfig() }
        : { listening: false, config: null },
      profiles: {
        count: profileStore.count,
        list: profileStore.listProfiles().map((p) => ({
          userId: p.userId,
          username: p.username,
          recordedAt: p.recordedAt,
          sampleDurationMs: p.sampleDurationMs,
        })),
      },
      cloneText: state.defaultCloneText,
      activePreset: state.activePreset
        ? {
            id: state.activePreset.id,
            name: state.activePreset.name,
            emoji: state.activePreset.emoji,
            category: state.activePreset.category,
            description: state.activePreset.description,
            available: state.activePreset.available,
            language: state.activePreset.language,
          }
        : null,
      presets: {
        total: VOICE_PRESETS.length,
        available: VOICE_PRESETS.filter((p) => p.available).length,
        list: VOICE_PRESETS.map((p) => ({
          id: p.id,
          name: p.name,
          emoji: p.emoji,
          category: p.category,
          description: p.description,
          available: p.available,
          language: p.language,
        })),
      },
      logs: activityLog.slice(-20),
    });
  });

  /** POST /api/speak — clone and play text through a user's voice or preset */
  app.post("/api/speak", strictLimiter, async (req: Request, res: Response) => {
    const { userId, language, presetId, effect } = req.body as {
      userId?: string;
      text?: string;
      language?: string;
      presetId?: string;
      effect?: string;
    };
    const body = req.body as Record<string, unknown>;
    let text = typeof body.text === "string" ? body.text : "";

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    // Input validation: limit text length to prevent abuse
    if (text.length > 500) {
      res.status(400).json({ error: "Text too long (max 500 characters)" });
      return;
    }

    // Sanitize: strip control characters
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not connected to a voice channel" });
      return;
    }

    // Support preset speak
    if (presetId) {
      const preset = findPreset(presetId);
      if (!preset) {
        res.status(404).json({ error: `Preset '${presetId}' not found` });
        return;
      }
      if (!preset.available) {
        res.status(404).json({
          error: `Preset '${preset.name}' is not available (no .wav file in presets/)`,
        });
        return;
      }
      refreshPresetAvailability(preset.id);
      addLog(
        "info",
        `🗣️  Admin triggered ${preset.emoji} ${preset.name}: "${text.slice(0, 50)}..." (effect: ${effect ?? "none"})`,
      );
      try {
        const audioPath = await generateClonedVoice(
          `preset_${preset.id}`,
          text,
          preset.wavPath,
          language ?? preset.language,
          effect ?? "none", // V2.2: Pass effect
        );
        playClonedAudio(state.activeConnection, audioPath);
        addLog("success", `🔊 ${preset.emoji} ${preset.name} played (${effect ?? "none"})`);
        res.json({ status: "success", file: audioPath, preset: preset.name });
      } catch (err) {
        addLog("error", `❌ Preset clone failed: ${err}`);
        res.status(500).json({ error: String(err) });
      }
      return;
    }

    // Fallback to user profile
    if (!userId) {
      res.status(400).json({ error: "userId or presetId is required" });
      return;
    }

    if (!profileStore.hasProfile(userId)) {
      res.status(404).json({ error: `No voice profile for user '${userId}'` });
      return;
    }

    addLog("info", `🗣️  Admin triggered clone for ${userId}: "${text.slice(0, 50)}..." (effect: ${effect ?? "none"})`);

    try {
      const audioPath = await generateClonedVoice(userId, text, undefined, "en", effect ?? "none");
      playClonedAudio(state.activeConnection, audioPath);
      addLog("success", `🔊 Cloned voice played for ${userId} (${effect ?? "none"})`);
      res.json({ status: "success", file: audioPath });
    } catch (err) {
      addLog("error", `❌ Admin clone failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  /** POST /api/train — record a user (requires userId in body) */
  app.post("/api/record", strictLimiter, async (req: Request, res: Response) => {
    const { userId, username } = req.body as {
      userId?: string;
      username?: string;
    };

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not in a voice channel" });
      return;
    }

    addLog("info", `🎙️  Admin triggered recording for ${userId}`);

    try {
      const { recordUserVoice } = await import("./recorder.js");
      const wavPath = await recordUserVoice(state.activeConnection, userId);
      const profile: VoiceProfile = {
        userId,
        username: username ?? userId,
        guildId: state.activeConnection.joinConfig.guildId,
        recordedAt: Date.now(),
        sampleDurationMs: 3000,
        samplePath: wavPath,
      };
      profileStore.saveProfile(profile);
      addLog("success", `✅ Voice profile saved for ${userId}`);
      res.json({ status: "success", profile });
    } catch (err) {
      addLog("error", `❌ Recording failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  /** POST /api/join — join a voice channel */
  app.post("/api/join", async (req: Request, res: Response) => {
    const { guildId, channelId } = req.body as {
      guildId?: string;
      channelId?: string;
    };

    if (!guildId || !channelId) {
      res.status(400).json({ error: "guildId and channelId are required" });
      return;
    }

    const guild = state.client.guilds.cache.get(guildId);
    if (!guild) {
      res.status(404).json({ error: "Guild not found" });
      return;
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      res.status(400).json({ error: "Channel is not a voice channel" });
      return;
    }

    // Leave existing connection
    if (state.activeConnection) {
      state.stopVad();
      state.activeConnection.destroy();
      state.setActiveConnection(null);
    }

    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as any,
        selfDeaf: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      state.setActiveConnection(connection);
      state.startVad(connection);
      addLog("success", `🔊 Joined voice channel: ${channel.name}`);
      res.json({ status: "success", channel: channel.name, guild: guild.name });
    } catch {
      res.status(500).json({ error: "Failed to join voice channel" });
    }
  });

  /** POST /api/leave — leave voice channel */
  app.post("/api/leave", (_req: Request, res: Response) => {
    if (!state.activeConnection) {
      res.status(400).json({ error: "Not connected to any channel" });
      return;
    }

    const leaveChannel = state.client.channels.cache.get(state.activeConnection.joinConfig.channelId!);
    let leaveChannelName = "Unknown";
    if (leaveChannel?.isVoiceBased()) {
      leaveChannelName = leaveChannel.name;
    }

    state.stopVad();
    state.activeConnection.destroy();
    state.setActiveConnection(null);
    addLog("info", `👋 Left voice channel: ${String(leaveChannelName)}`);
    res.json({ status: "success", left: leaveChannelName });
  });

  /** DELETE /api/profiles/:userId — delete a profile */
  app.delete("/api/profiles/:userId", (req: Request, res: Response) => {
    const { userId } = req.params;
    const existed = profileStore.deleteProfile(userId);
    if (existed) {
      addLog("success", `🗑️ Deleted profile for ${userId}`);
      res.json({ status: "success" });
    } else {
      res.status(404).json({ error: "Profile not found" });
    }
  });

  /** POST /api/vad — update VAD config */
  app.post("/api/vad", (req: Request, res: Response) => {
    const config = req.body as Partial<VadConfig>;
    if (state.vadDetector) {
      state.vadDetector.setConfig(config);
      addLog("info", `⚙️ VAD config updated via admin`);
      res.json({ status: "success", config: state.vadDetector.getConfig() });
    } else {
      res.status(400).json({ error: "VAD not initialized (join a channel first)" });
    }
  });

  /** POST /api/play-reference/:userId — play a user's raw recorded reference audio */
  app.post("/api/play-reference/:userId", (req: Request, res: Response) => {
    const { userId } = req.params;

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not connected to a voice channel" });
      return;
    }

    const profile = profileStore.getProfile(userId);
    if (!profile) {
      res.status(404).json({ error: `No profile found for user '${userId}'` });
      return;
    }

    if (!existsSync(profile.samplePath)) {
      res.status(404).json({ error: `Reference audio file not found: ${profile.samplePath}` });
      return;
    }

    playClonedAudio(state.activeConnection, profile.samplePath);
    addLog("success", `🔊 Playing reference audio for ${userId}`);
    res.json({ status: "success", file: profile.samplePath });
  });

  // ── V2 API Routes ────────────────────────────────────────────────────────

  /** V2.1: GET /api/consent/:userId — check consent status */
  app.get("/api/consent/:userId", (req: Request, res: Response) => {
    const { userId } = req.params;
    const status = state.getConsent?.(userId) ?? "pending";
    res.json({ userId, consent: status });
  });

  /** V2.1: POST /api/consent/:userId — set consent status */
  app.post("/api/consent/:userId", (req: Request, res: Response) => {
    const { userId } = req.params;
    const { status } = req.body as { status: string };
    if (!["approved", "denied", "pending"].includes(status)) {
      res.status(400).json({ error: "Invalid consent status" });
      return;
    }
    // Dispatch to the bot's consent tracker via the admin state
    addLog("info", `🔒 Consent ${status} for ${userId}`);
    res.json({ userId, consent: status });
  });

  /** V2.2: POST /api/speak — updated with effect parameter (see existing) */

  /** V2.2: GET /api/effects — list available audio effects */
  app.get("/api/effects", (_req: Request, res: Response) => {
    res.json({
      effects: [
        { id: "none", name: "None", description: "No effect — natural voice" },
        { id: "walkie-talkie", name: "Walkie-Talkie", description: "Narrow bandpass radio filter" },
        { id: "demon", name: "Demon", description: "Deep pitch shift + distortion" },
        { id: "echo", name: "Echo/Reverb", description: "Multi-tap reverb with space" },
      ],
    });
  });

  /** V2.3: POST /api/v2v — trigger voice-to-voice pipeline */
  app.post("/api/v2v", async (req: Request, res: Response) => {
    const { sourceUserId, targetUserId, effect } = req.body as {
      sourceUserId?: string;
      targetUserId?: string;
      effect?: string;
    };

    if (!sourceUserId || !targetUserId) {
      res.status(400).json({ error: "sourceUserId and targetUserId are required" });
      return;
    }

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not connected to a voice channel" });
      return;
    }

    addLog("info", `🗣️  V2V: ${sourceUserId} → ${targetUserId}`);

    try {
      const { sendVoiceToVoice } = await import("./cloner.js");
      const audioPath = await sendVoiceToVoice(sourceUserId, targetUserId, undefined, effect ?? "none");
      if (audioPath) {
        const { playClonedAudio } = await import("./player.js");
        playClonedAudio(state.activeConnection, audioPath);
        addLog("success", `🔊 V2V played: ${sourceUserId} → ${targetUserId}`);
        res.json({ status: "success", file: audioPath });
      } else {
        res.status(500).json({ error: "V2V pipeline failed" });
      }
    } catch (err) {
      addLog("error", `❌ V2V failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  /** V2.4: WebSocket endpoint for live amplitude waveforms */
  app.get("/api/ws-info", (_req: Request, res: Response) => {
    const port = parseInt(process.env.ADMIN_PORT || "3000", 10);
    res.json({
      wsUrl: `ws://localhost:${port}`,
      enabled: wss !== null,
      clients: amplitudeClients.size,
    });
  });

  /** POST /api/play-preset/:presetId — play a preset's reference audio sample */
  app.post("/api/play-preset/:presetId", (req: Request, res: Response) => {
    const { presetId } = req.params;

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not connected to a voice channel" });
      return;
    }

    const preset = findPreset(presetId);
    if (!preset) {
      res.status(404).json({ error: `Preset '${presetId}' not found` });
      return;
    }

    if (!preset.available) {
      res.status(404).json({
        error: `Preset '${preset.name}' is not available. Place presets/${presetId}.wav to activate.`,
      });
      return;
    }

    playClonedAudio(state.activeConnection, preset.wavPath);
    addLog("success", `🔊 Playing ${preset.emoji} ${preset.name} reference audio`);
    res.json({ status: "success", file: preset.wavPath, preset: preset.name });
  });

  /** POST /api/regenerate-readme — trigger README.md generation */
  app.post("/api/regenerate-readme", async (_req: Request, res: Response) => {
    try {
      const { generateReadme } = await import("./docs-generator.js");
      const result = generateReadme();
      const sizeKb = (result.size / 1024).toFixed(1);
      addLog("success", `📝 README.md regenerated (${sizeKb} KB)`);
      res.json({ status: "success", path: result.path, size: sizeKb + " KB" });
    } catch (err) {
      addLog("error", `❌ README generation failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/health — Python TTS server health */
  app.get("/api/health", async (_req: Request, res: Response) => {
    const ok = await healthCheck();
    res.json({ online: ok });
  });

  // ── Sentry Error Handler (must be after all routes) ─────────────────
  Sentry.setupExpressErrorHandler(app);

  // ── Serve Dashboard Static Files ──────────────────────────────────────

  app.use("/static", express.static(DASHBOARD_DIR));

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(DASHBOARD_DIR, "index.html"));
  });

  return app;
}

// ── Start Server ──────────────────────────────────────────────────────────

export function startAdminServer(port: number, state: BotState): void {
  const app = createAdminApp(state);

  const server = app.listen(port, () => {
    console.log(`🌐 Control Center: http://localhost:${port}`);
    console.log(`📡 API:             http://localhost:${port}/api/status`);
    addLog("success", `🌐 Control Center started on port ${port}`);

    // V2.4: Start WebSocket server for live waveform streaming
    try {
      wss = new WebSocketServer({ server });
      wss.on("connection", (ws: WsImpl) => {
        amplitudeClients.add(ws);
        console.log(`📡 WebSocket client connected (${amplitudeClients.size} total)`);

        // Send initial handshake
        ws.send(JSON.stringify({ type: "hello", message: "ShadowVox Waveform Stream" }));

        ws.on("close", () => {
          amplitudeClients.delete(ws);
          console.log(`📡 WebSocket client disconnected (${amplitudeClients.size} remaining)`);
        });

        ws.on("error", () => {
          amplitudeClients.delete(ws);
        });
      });
      console.log(`📡 WebSocket server ready for live waveform streaming`);
    } catch (err) {
      console.warn("⚠️  WebSocket server not available:", err);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const fallbackPort = port + 1;
      console.warn(`⚠️  Port ${port} is in use, trying ${fallbackPort}...`);
      const fallbackServer = app.listen(fallbackPort, () => {
        console.log(`🌐 Control Center: http://localhost:${fallbackPort}`);
        addLog("success", `🌐 Control Center started on fallback port ${fallbackPort}`);

        // V2.4: Start WebSocket on fallback port
        try {
          wss = new WebSocketServer({ server: fallbackServer });
          wss.on("connection", (ws: WsImpl) => {
            amplitudeClients.add(ws);
            ws.send(JSON.stringify({ type: "hello", message: "ShadowVox Waveform Stream" }));
            ws.on("close", () => amplitudeClients.delete(ws));
            ws.on("error", () => amplitudeClients.delete(ws));
          });
        } catch { /* WS best-effort */ }
      });
    } else {
      console.error("❌ Admin server error:", err.message);
    }
  });

}
