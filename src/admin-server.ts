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
import { join, resolve, dirname } from "node:path";
import type { Client } from "discord.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ── Dashboard path ────────────────────────────────────────────────────────
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const DASHBOARD_DIR = resolve(_dirname, "..", "dashboard");

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

// ── Start Server ──────────────────────────────────────────────────────────

export function startAdminServer(port: number, state: BotState): void {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // ── API Middleware: Admin auth (optional) ─────────────────────────────
  const apiKey = process.env.ADMIN_API_KEY;

  app.use("/api/*", (req, res, next) => {
    if (apiKey) {
      const key = req.headers["x-api-key"] as string;
      if (key !== apiKey) {
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
      logs: activityLog.slice(-20),
    });
  });

  /** POST /api/speak — clone and play text through a user's voice */
  app.post("/api/speak", async (req: Request, res: Response) => {
    const { userId, text, language } = req.body as {
      userId?: string;
      text?: string;
      language?: string;
    };

    if (!userId || !text) {
      res.status(400).json({ error: "userId and text are required" });
      return;
    }

    if (!state.activeConnection) {
      res.status(400).json({ error: "Bot is not connected to a voice channel" });
      return;
    }

    if (!profileStore.hasProfile(userId)) {
      res.status(404).json({ error: `No voice profile for user '${userId}'` });
      return;
    }

    addLog("info", `🗣️  Admin triggered clone for ${userId}: "${text.slice(0, 50)}..."`);

    try {
      const audioPath = await generateClonedVoice(userId, text);
      playClonedAudio(state.activeConnection, audioPath);
      addLog("success", `🔊 Cloned voice played for ${userId}`);
      res.json({ status: "success", file: audioPath });
    } catch (err) {
      addLog("error", `❌ Admin clone failed: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  /** POST /api/train — record a user (requires userId in body) */
  app.post("/api/record", async (req: Request, res: Response) => {
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

  // ── Serve Dashboard Static Files ──────────────────────────────────────

  app.use("/static", express.static(DASHBOARD_DIR));

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(DASHBOARD_DIR, "index.html"));
  });

  // ── Start with fallback ──────────────────────────────────────────────

  const server = app.listen(port, () => {
    console.log(`🌐 Control Center: http://localhost:${port}`);
    console.log(`📡 API:             http://localhost:${port}/api/status`);
    addLog("success", `🌐 Control Center started on port ${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const fallbackPort = port + 1;
      console.warn(`⚠️  Port ${port} is in use, trying ${fallbackPort}...`);
      app.listen(fallbackPort, () => {
        console.log(`🌐 Control Center: http://localhost:${fallbackPort}`);
        addLog("success", `🌐 Control Center started on fallback port ${fallbackPort}`);
      });
    } else {
      console.error("❌ Admin server error:", err.message);
    }
  });

}
