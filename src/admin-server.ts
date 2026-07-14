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

  // ── Start ─────────────────────────────────────────────────────────────

  app.listen(port, () => {
    console.log(`🌐 Control Center: http://localhost:${port}`);
    console.log(`📡 API:             http://localhost:${port}/api/status`);
    addLog("success", `🌐 Control Center started on port ${port}`);
  });
}

// ── Web Panel HTML (themed, dark, polished) ─────────────────────────────

const WEB_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ShadowVox Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after {
      margin: 0; padding: 0; box-sizing: border-box;
    }
    :root {
      --bg-primary: #0a0b0f;
      --bg-secondary: #111318;
      --bg-card: #181b23;
      --bg-card-hover: #1e212b;
      --border: #252832;
      --border-active: #3b3f52;
      --text-primary: #e8eaed;
      --text-secondary: #9ba0ab;
      --text-muted: #5c6170;
      --accent-purple: #8b5cf6;
      --accent-cyan: #22d3ee;
      --accent-green: #4ade80;
      --accent-red: #f87171;
      --accent-yellow: #fbbf24;
      --gradient-primary: linear-gradient(135deg, #8b5cf6, #22d3ee);
      --gradient-bg: linear-gradient(180deg, #0a0b0f 0%, #111318 50%, #0a0b0f 100%);
      --shadow-card: 0 4px 24px rgba(0,0,0,0.4);
      --radius: 12px;
      --radius-sm: 8px;
    }
    html { height: 100%; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--gradient-bg);
      color: var(--text-primary);
      min-height: 100%;
      line-height: 1.6;
    }
    .container { max-width: 1280px; margin: 0 auto; padding: 24px; }
    
    /* ── Header ── */
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; margin-bottom: 32px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-card);
    }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon {
      width: 40px; height: 40px; border-radius: 10px;
      background: var(--gradient-primary);
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    .logo h1 { font-size: 20px; font-weight: 700; }
    .logo span { color: var(--text-secondary); font-size: 14px; }
    .status-badge {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px; border-radius: 999px;
      font-size: 13px; font-weight: 600;
    }
    .status-badge.online { background: rgba(74,222,128,0.12); color: var(--accent-green); }
    .status-badge.offline { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      animation: pulse 2s infinite;
    }
    .status-badge.online .status-dot { background: var(--accent-green); }
    .status-badge.offline .status-dot { background: var(--accent-red); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Waveform Banner ── */
    .waveform {
      height: 80px; margin-bottom: 32px; position: relative;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden; display: flex; align-items: center; justify-content: center;
    }
    .waveform canvas {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
    }
    .waveform-text {
      position: relative; z-index: 1;
      font-size: 14px; font-weight: 500;
      color: var(--text-muted);
      background: rgba(10,11,15,0.6);
      padding: 6px 16px; border-radius: 999px;
      backdrop-filter: blur(4px);
    }

    /* ── Grid ── */
    .grid { display: grid; gap: 24px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
    @media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

    /* ── Cards ── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      transition: border-color .2s, box-shadow .2s;
    }
    .card:hover { border-color: var(--border-active); }
    .card-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-muted);
      margin-bottom: 16px;
    }
    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .stat-row:last-child { border: none; }
    .stat-label { font-size: 13px; color: var(--text-secondary); }
    .stat-value { font-size: 14px; font-weight: 600; }

    /* ── Profile List ── */
    .profile-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; margin-bottom: 4px;
      border-radius: var(--radius-sm);
      transition: background .15s;
    }
    .profile-item:hover { background: var(--bg-card-hover); }
    .profile-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--gradient-primary);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px; flex-shrink: 0;
    }
    .profile-info { flex: 1; min-width: 0; }
    .profile-name { font-size: 14px; font-weight: 600; }
    .profile-meta { font-size: 11px; color: var(--text-muted); }
    .profile-actions { display: flex; gap: 6px; }

    /* ── Speak Form ── */
    .speak-form { display: flex; flex-direction: column; gap: 12px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    select, textarea {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 10px 14px;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      transition: border-color .2s;
    }
    select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent-purple);
      box-shadow: 0 0 0 3px rgba(139,92,246,0.15);
    }
    textarea { resize: vertical; min-height: 80px; }
    select option { background: var(--bg-secondary); }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      padding: 10px 20px; border: none; border-radius: var(--radius-sm);
      font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: all .2s;
    }
    .btn-primary {
      background: var(--gradient-primary);
      color: white;
    }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.3); }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .btn-sm {
      padding: 6px 12px; font-size: 12px;
      background: rgba(248,113,113,0.12); color: var(--accent-red);
      border-radius: 6px;
    }
    .btn-sm:hover { background: rgba(248,113,113,0.25); }
    .btn-ghost {
      background: transparent; color: var(--text-secondary);
      padding: 6px 10px; font-size: 12px;
    }
    .btn-ghost:hover { color: var(--text-primary); background: var(--bg-card-hover); }
    .btn-success {
      background: rgba(74,222,128,0.12); color: var(--accent-green);
      padding: 6px 12px; font-size: 12px; border-radius: 6px;
    }

    /* ── Activity Log ── */
    .log-container { max-height: 300px; overflow-y: auto; }
    .log-container::-webkit-scrollbar { width: 4px; }
    .log-container::-webkit-scrollbar-track { background: transparent; }
    .log-container::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .log-entry {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 0; border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .log-entry:last-child { border: none; }
    .log-time { color: var(--text-muted); font-family: 'JetBrains Mono', monospace; font-size: 11px; white-space: nowrap; }
    .log-icon { flex-shrink: 0; }
    .log-msg { color: var(--text-secondary); word-break: break-word; }

    /* ── Toast ── */
    .toast {
      position: fixed; bottom: 24px; right: 24px;
      padding: 12px 20px; border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 500;
      background: var(--bg-card);
      border: 1px solid var(--border);
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      transform: translateY(120px);
      opacity: 0;
      transition: all .3s ease;
      z-index: 100;
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.success { border-color: var(--accent-green); }
    .toast.error { border-color: var(--accent-red); }

    .empty-state {
      text-align: center; padding: 24px;
      color: var(--text-muted); font-size: 13px;
    }

    /* ── VAD Config ── */
    .vad-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0;
    }
    .vad-toggle {
      display: flex; gap: 4px;
    }
    .vad-toggle button {
      padding: 4px 12px; font-size: 12px; font-weight: 500;
      border: 1px solid var(--border); border-radius: 6px;
      background: transparent; color: var(--text-secondary);
      cursor: pointer; transition: all .15s;
    }
    .vad-toggle button.active {
      background: var(--accent-purple); color: white; border-color: var(--accent-purple);
    }
    .vad-toggle button:hover:not(.active) { border-color: var(--border-active); }

    .slider-row { display: flex; align-items: center; gap: 12px; }
    .slider-row input[type="range"] {
      flex: 1; height: 4px; -webkit-appearance: none;
      background: var(--border); border-radius: 2px;
    }
    .slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 14px; height: 14px;
      border-radius: 50%; background: var(--accent-purple);
      cursor: pointer;
    }
    .slider-value { font-size: 12px; font-weight: 600; color: var(--text-primary); min-width: 36px; text-align: right; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="logo">
        <div class="logo-icon">🎤</div>
        <div>
          <h1>ShadowVox</h1>
          <span>Admin Panel</span>
        </div>
      </div>
      <div class="status-badge" id="statusBadge">
        <span class="status-dot"></span>
        <span id="statusText">Connecting...</span>
      </div>
    </header>

    <!-- Waveform Banner -->
    <div class="waveform">
      <canvas id="waveformCanvas"></canvas>
      <div class="waveform-text" id="waveformText">● Bot is starting...</div>
    </div>

    <!-- Grid -->
    <div class="grid grid-3" style="margin-bottom:24px">
      <!-- Status Card -->
      <div class="card">
        <div class="card-title">Connection</div>
        <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="connStatus">—</span></div>
        <div class="stat-row"><span class="stat-label">Guild</span><span class="stat-value" id="connGuild">—</span></div>
        <div class="stat-row"><span class="stat-label">Channel</span><span class="stat-value" id="connChannel">—</span></div>
        <div class="stat-row"><span class="stat-label">Bot</span><span class="stat-value" id="connBot">—</span></div>
      </div>

      <!-- Profiles Card -->
      <div class="card">
        <div class="card-title">Voice Profiles <span id="profileCount" style="color:var(--text-muted)"></span></div>
        <div id="profileList"><div class="empty-state">Loading...</div></div>
      </div>

      <!-- VAD Card -->
      <div class="card">
        <div class="card-title">Voice Activity Detection</div>
        <div class="vad-row">
          <span class="stat-label">Listening</span>
          <div class="vad-toggle" id="vadListening">
            <button data-on="true" class="active">On</button>
            <button data-on="false">Off</button>
          </div>
        </div>
        <div class="vad-row">
          <span class="stat-label">Auto-Clone</span>
          <div class="vad-toggle" id="vadClone">
            <button data-on="true" class="active">On</button>
            <button data-on="false">Off</button>
          </div>
        </div>
        <div class="vad-row">
          <span class="stat-label">Listen to all</span>
          <div class="vad-toggle" id="vadAll">
            <button data-on="true" class="active">All</button>
            <button data-on="false">Profiles</button>
          </div>
        </div>
        <div class="vad-row slider-row">
          <span class="stat-label">Silence</span>
          <input type="range" id="silenceRange" min="200" max="4000" value="1200" />
          <span class="slider-value" id="silenceValue">1.2s</span>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <!-- Speak Form -->
      <div class="card">
        <div class="card-title">Speak Through a Voice</div>
        <div class="speak-form">
          <div class="form-group">
            <label>Voice Profile</label>
            <select id="speakUser"><option>— No profiles loaded —</option></select>
          </div>
          <div class="form-group">
            <label>Text to Speak</label>
            <textarea id="speakText" placeholder="Enter text to speak through the cloned voice..."></textarea>
          </div>
          <button class="btn btn-primary" id="speakBtn" disabled>🔊 Speak</button>
        </div>
      </div>

      <!-- Activity Log -->
      <div class="card">
        <div class="card-title">Activity Log</div>
        <div class="log-container" id="logContainer">
          <div class="empty-state">Waiting for activity...</div>
        </div>
      </div>
    </div>

    <div style="margin-top:12px;text-align:center">
      <button class="btn btn-ghost" onclick="refreshAll()">⟳ Refresh</button>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // ── Waveform Animation ──
    const canvas = document.getElementById('waveformCanvas');
    const ctx = canvas.getContext('2d');
    let waveformPhase = 0;

    function resizeCanvas() {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function drawWaveform(active) {
      const w = canvas.width / devicePixelRatio;
      const h = canvas.height / devicePixelRatio;
      ctx.clearRect(0, 0, w, h);

      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, active ? 'rgba(139,92,246,0.4)' : 'rgba(92,97,112,0.2)');
      gradient.addColorStop(0.5, active ? 'rgba(34,211,238,0.4)' : 'rgba(92,97,112,0.2)');
      gradient.addColorStop(1, active ? 'rgba(139,92,246,0.4)' : 'rgba(92,97,112,0.2)');

      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const amp = active ? h * 0.3 : h * 0.06;
      const freq = active ? 0.04 : 0.06;
      const bars = Math.floor(w / 6);

      for (let i = 0; i <= bars; i++) {
        const x = (i / bars) * w;
        const y = active
          ? h/2 + Math.sin(x * freq + waveformPhase) * amp * (0.5 + 0.5 * Math.sin(x * 0.01))
          : h/2 + Math.sin(x * freq + waveformPhase) * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      waveformPhase += 0.02;
      requestAnimationFrame(() => drawWaveform(active));
    }
    drawWaveform(false);

    // ── State ──
    let state = { bot: null, connection: null, vad: null, profiles: null };
    let polling = false;
    let apiKey = '';

    // Try to get API key from URL param
    const urlParams = new URLSearchParams(window.location.search);
    apiKey = urlParams.get('key') || '';

    function apiHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (apiKey) h['x-api-key'] = apiKey;
      return h;
    }

    // ── Toast ──
    function showToast(msg, type = 'success') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast ' + type + ' show';
      clearTimeout(t._hide);
      t._hide = setTimeout(() => t.classList.remove('show'), 3000);
    }

    // ── Fetch Status ──
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status', { headers: apiHeaders() });
        if (!res.ok) throw new Error('API error');
        state = await res.json();
        renderAll();
      } catch {
        document.getElementById('statusBadge').className = 'status-badge offline';
        document.getElementById('statusText').textContent = 'Offline';
      }
    }

    // ── Render ──
    function renderAll() {
      // Header badge
      const badge = document.getElementById('statusBadge');
      const text = document.getElementById('statusText');
      if (state.bot?.online) {
        badge.className = 'status-badge online';
        text.textContent = state.bot.username + ' • Online';
      } else {
        badge.className = 'status-badge offline';
        text.textContent = 'Offline';
      }

      // Waveform text
      const waveformText = document.getElementById('waveformText');
      if (state.connection?.connected) {
        waveformText.textContent = '● Connected to ' + (state.connection.channelName || 'voice') + ' in ' + (state.connection.guildName || 'guild');
        drawWaveform(true);
      } else {
        waveformText.textContent = '○ Not connected to any voice channel';
        drawWaveform(false);
      }

      // Connection
      document.getElementById('connStatus').textContent = state.connection?.connected ? '✅ Connected' : '❌ Disconnected';
      document.getElementById('connGuild').textContent = state.connection?.guildName || '—';
      document.getElementById('connChannel').textContent = state.connection?.channelName || '—';
      document.getElementById('connBot').textContent = state.bot?.username || '—';

      // Profiles
      const profileList = document.getElementById('profileList');
      document.getElementById('profileCount').textContent = '(' + (state.profiles?.count || 0) + ')';
      if (!state.profiles?.list?.length) {
        profileList.innerHTML = '<div class="empty-state">No profiles yet</div>';
      } else {
        profileList.innerHTML = state.profiles.list.map(p => {
          const initial = (p.username || '?')[0].toUpperCase();
          const time = new Date(p.recordedAt).toLocaleDateString();
          return '<div class="profile-item">' +
            '<div class="profile-avatar">' + initial + '</div>' +
            '<div class="profile-info"><div class="profile-name">' + escapeHtml(p.username) + '</div><div class="profile-meta">Recorded ' + time + ' • ' + (p.sampleDurationMs/1000).toFixed(1) + 's sample</div></div>' +
            '<button class="btn-sm" onclick="deleteProfile(\'' + p.userId + '\')">Delete</button>' +
          '</div>';
        }).join('');
      }

      // Speak dropdown
      const sel = document.getElementById('speakUser');
      if (state.profiles?.list?.length) {
        const currentValue = sel.value;
        sel.innerHTML = '<option value="">Select a voice profile...</option>' +
          state.profiles.list.map(p => '<option value="' + p.userId + '"' + (p.userId === currentValue ? ' selected' : '') + '>' + escapeHtml(p.username) + '</option>').join('');
        document.getElementById('speakBtn').disabled = false;
      } else {
        sel.innerHTML = '<option value="">— No profiles —</option>';
        document.getElementById('speakBtn').disabled = true;
      }

      // VAD
      const vad = state.vad;
      setVadToggle('vadListening', vad?.listening ?? false);
      setVadToggle('vadClone', vad?.config?.autoClone ?? true);
      setVadToggle('vadAll', vad?.config?.listenToAll ?? true);
      const silMs = vad?.config?.silenceDurationMs ?? 1200;
      document.getElementById('silenceRange').value = silMs;
      document.getElementById('silenceValue').textContent = (silMs / 1000).toFixed(1) + 's';

      // Activity log
      const logContainer = document.getElementById('logContainer');
      if (!state.logs?.length) {
        logContainer.innerHTML = '<div class="empty-state">No recent activity</div>';
      } else {
        logContainer.innerHTML = state.logs.slice().reverse().map(log => {
          const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
          const time = new Date(log.timestamp).toLocaleTimeString();
          return '<div class="log-entry"><span class="log-time">' + time + '</span><span class="log-icon">' + (icons[log.level] || '•') + '</span><span class="log-msg">' + escapeHtml(log.message) + '</span></div>';
        }).join('');
      }
    }

    function setVadToggle(id, value) {
      const container = document.getElementById(id);
      if (!container) return;
      container.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', (b.dataset.on === 'true') === value);
      });
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    // ── VAD Toggle Handlers ──
    document.getElementById('vadListening').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      fetch('/api/vad', { method:'POST', headers: apiHeaders(),
        body: JSON.stringify({ enabled: btn.dataset.on === 'true' }) })
        .then(r => r.json()).then(() => fetchStatus()).catch(() => {});
    });
    document.getElementById('vadClone').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      fetch('/api/vad', { method:'POST', headers: apiHeaders(),
        body: JSON.stringify({ autoClone: btn.dataset.on === 'true' }) })
        .then(r => r.json()).then(() => fetchStatus()).catch(() => {});
    });
    document.getElementById('vadAll').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      fetch('/api/vad', { method:'POST', headers: apiHeaders(),
        body: JSON.stringify({ listenToAll: btn.dataset.on === 'true' }) })
        .then(r => r.json()).then(() => fetchStatus()).catch(() => {});
    });
    document.getElementById('silenceRange').addEventListener('input', e => {
      const val = parseInt(e.target.value);
      document.getElementById('silenceValue').textContent = (val / 1000).toFixed(1) + 's';
    });
    document.getElementById('silenceRange').addEventListener('change', e => {
      const val = parseInt(e.target.value);
      fetch('/api/vad', { method:'POST', headers: apiHeaders(),
        body: JSON.stringify({ silenceDurationMs: val }) }).catch(() => {});
    });

    // ── Speak Button ──
    document.getElementById('speakBtn').addEventListener('click', async () => {
      const userId = document.getElementById('speakUser').value;
      const text = document.getElementById('speakText').value.trim();
      if (!userId || !text) { showToast('Select a profile and enter text', 'error'); return; }
      const btn = document.getElementById('speakBtn');
      btn.disabled = true; btn.textContent = '⏳ Cloning...';
      try {
        const res = await fetch('/api/speak', { method:'POST', headers: apiHeaders(),
          body: JSON.stringify({ userId, text }) });
        const data = await res.json();
        if (data.status === 'success') {
          showToast('🔊 Voice cloned and playing!');
          document.getElementById('speakText').value = '';
        } else {
          showToast('❌ ' + (data.error || 'Failed'), 'error');
        }
      } catch { showToast('❌ Network error', 'error'); }
      btn.disabled = false; btn.textContent = '🔊 Speak';
      fetchStatus();
    });

    // ── Delete Profile ──
    async function deleteProfile(userId) {
      try {
        const res = await fetch('/api/profiles/' + userId, { method:'DELETE', headers: apiHeaders() });
        if (res.ok) { showToast('🗑️ Profile deleted'); fetchStatus(); }
        else showToast('❌ Failed to delete', 'error');
      } catch { showToast('❌ Network error', 'error'); }
    }
    window.deleteProfile = deleteProfile;

    // ── Refresh ──
    function refreshAll() { fetchStatus(); }
    window.refreshAll = refreshAll;

    // ── Polling ──
    fetchStatus();
    setInterval(fetchStatus, 3000);
  </script>
</body>
</html>`;
