/**
 * ShadowVox - Main Bot Entry Point
 *
 * A Discord bot that captures voices, manages multi-user voice profiles,
 * and provides a Voice Activity Detection (VAD) system that can
 * automatically clone and playback voices in real-time.
 */

import { Client, GatewayIntentBits, Events, VoiceState } from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import "dotenv/config";

import { recordUserVoice } from "./recorder.js";
import { generateClonedVoice, healthCheck } from "./cloner.js";
import { playClonedAudio } from "./player.js";
import { VoiceActivityDetector, type VadConfig } from "./vad.js";
import { profileStore, type VoiceProfile } from "./profiles.js";

// ── Constants ─────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const TARGET_VOICE_CHANNEL_ID = process.env.TARGET_VOICE_CHANNEL_ID;
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3000", 10);
const ADMIN_ENABLED = process.env.ADMIN_DISABLED !== "true";

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN is not set in .env");
  process.exit(1);
}

// ── State ─────────────────────────────────────────────────────────────────

const prefix = "!";

let activeConnection: VoiceConnection | null = null;
let vadDetector: VoiceActivityDetector | null = null;
let defaultCloneText: string =
  "Hello, I am your voice clone. I can sound just like you!";

function setActiveConnection(conn: VoiceConnection | null) {
  activeConnection = conn;
}

function setVadDetector(vad: VoiceActivityDetector | null) {
  vadDetector = vad;
}

function setDefaultCloneText(text: string) {
  defaultCloneText = text;
}

// ── Client Setup ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient: Client<true>) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(
    `ℹ️  Invite the bot at:\n   https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=3148800&scope=bot`,
  );
  console.log(`📋 ${profileStore.count} voice profile(s) loaded from disk`);

  // Start admin web server
  if (ADMIN_ENABLED) {
    const { startAdminServer } = await import("./admin-server.js");
    startAdminServer(ADMIN_PORT, {
      client: readyClient,
      activeConnection,
      setActiveConnection,
      vadDetector,
      setVadDetector,
      defaultCloneText,
      setDefaultCloneText,
      startVad,
      stopVad,
    });
  }

  // Auto-join the configured voice channel on startup
  if (TARGET_GUILD_ID && TARGET_VOICE_CHANNEL_ID) {
    autoJoinChannel(TARGET_GUILD_ID, TARGET_VOICE_CHANNEL_ID);
  }
});

// ── Voice Connection Helpers ──────────────────────────────────────────────

async function autoJoinChannel(guildId: string, channelId: string) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error(`❌ Guild ${guildId} not found`);
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) {
    console.error(`❌ Channel ${channelId} is not a voice channel`);
    return;
  }

  console.log(`🔊 Joining voice channel: ${channel.name}`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator as any,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    console.log("✅ Connected to voice channel");
    activeConnection = connection;
    startVad(connection);
  } catch {
    console.error("❌ Failed to connect to voice channel");
    connection.destroy();
  }
}

function startVad(connection: VoiceConnection) {
  if (vadDetector) {
    vadDetector.stop();
  }

  vadDetector = new VoiceActivityDetector(
    connection,
    {
      cloneText: defaultCloneText,
    },
    {
      onRecordingStart: (userId) => {
        console.log(`🔴 VAD: ${userId} started speaking`);
      },
      onRecordingComplete: (userId, wavPath) => {
        console.log(`🟢 VAD: ${userId} finished speaking → ${wavPath}`);
      },
      onCloneStart: (userId) => {
        console.log(`🗣️  VAD: cloning voice for ${userId}`);
      },
      onCloneComplete: (userId, audioPath) => {
        console.log(`🔊 VAD: played clone for ${userId}`);
      },
      onError: (userId, error) => {
        console.warn(`⚠️  VAD error for ${userId}: ${error}`);
      },
    },
  );

  vadDetector.start();
}

function stopVad() {
  if (vadDetector) {
    vadDetector.stop();
    vadDetector = null;
  }
}

// ── Command Handler ───────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();
  const rest = args.slice(1).join(" ");

  try {
    switch (command) {
      case "join":
        await handleJoin(message);
        break;
      case "leave":
        await handleLeave(message);
        break;
      case "record":
        await handleRecord(message);
        break;
      case "say":
        await handleSay(message, rest);
        break;
      case "profile":
      case "profiles":
        await handleProfiles(message, args);
        break;
      case "deleteprofile":
        await handleDeleteProfile(message, args);
        break;
      case "setclone":
        await handleSetClone(message, rest);
        break;
      case "vad":
        await handleVadCommand(message, args);
        break;
      case "ping":
        await message.reply("🏓 Pong! Bot is alive.");
        break;
      case "health":
        const ok = await healthCheck();
        await message.reply(
          ok
            ? "✅ Python TTS server is online"
            : "❌ Python TTS server is unreachable (is it running?)",
        );
        break;
      default:
        // Unknown command — ignore silently
        break;
    }
  } catch (err) {
    console.error(`❌ Command '${command}' error:`, err);
    await message.reply(`❌ An error occurred: \`${err}\``).catch(() => {});
  }
});

// ── Voice State Tracking ──────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
  // Detect when bot is disconnected from voice
  if (newState.id === client.user?.id && !newState.channelId) {
    console.log("👋 Bot was disconnected from voice");
    stopVad();
    activeConnection = null;
  }
});

// ── Commands ──────────────────────────────────────────────────────────────

/** !join — Join the caller's voice channel */
async function handleJoin(message: any) {
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) {
    await message.reply("❌ You must be in a voice channel first!");
    return;
  }

  // Leave existing connection first
  if (activeConnection) {
    stopVad();
    activeConnection.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator as any,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    activeConnection = connection;
    startVad(connection);
    await message.reply(`✅ Joined **${voiceChannel.name}** — VAD is active`);
  } catch {
    connection.destroy();
    activeConnection = null;
    await message.reply("❌ Failed to join voice channel");
  }
}

/** !leave — Leave the voice channel */
async function handleLeave(message: any) {
  if (activeConnection) {
    stopVad();
    activeConnection.destroy();
    activeConnection = null;
    await message.reply("👋 Left the voice channel");
  } else {
    await message.reply("❌ Not in a voice channel");
  }
}

/** !record [@user] — Record a user's voice for their profile */
async function handleRecord(message: any) {
  const targetUser = message.mentions.users.first() || message.author;
  const userId = targetUser.id;

  if (!activeConnection) {
    await message.reply("❌ I'm not in a voice channel. Use `!join` first.");
    return;
  }

  await message.reply(`🎙️ Recording voice for **${targetUser.username}** ... speak now!`);

  try {
    const wavPath = await recordUserVoice(activeConnection, userId);
    const profile: VoiceProfile = {
      userId,
      username: targetUser.username,
      guildId: message.guild.id,
      recordedAt: Date.now(),
      sampleDurationMs: 3000, // rough estimate, actual would come from VAD
      samplePath: wavPath,
    };
    profileStore.saveProfile(profile);

    await message.reply(
      `✅ Voice profile saved for **${targetUser.username}**\n` +
        `📝 ${profileStore.count} profile(s) total\n` +
        `💡 Try \`!say <text>\` or enable auto-clone with \`!vad on\``,
    );
  } catch (err) {
    await message.reply(`❌ Recording failed: \`${err}\``);
  }
}

/** !say <text> — Clone the sender's voice and speak */
async function handleSay(message: any, text: string) {
  if (!text) {
    await message.reply("❌ Usage: `!say <text to speak>`");
    return;
  }

  const userId = message.author.id;

  if (!activeConnection) {
    await message.reply("❌ I'm not in a voice channel. Use `!join` first.");
    return;
  }

  if (!profileStore.hasProfile(userId)) {
    await message.reply(
      "❌ No voice profile found for you. Record one first with `!record`.",
    );
    return;
  }

  await message.reply(`🗣️ Generating cloned voice...`);
  try {
    const audioPath = await generateClonedVoice(userId, text);
    playClonedAudio(activeConnection, audioPath);
    await message.reply(`🔊 Playing cloned voice!`);
  } catch (err) {
    await message.reply(`❌ Voice cloning failed: \`${err}\``);
  }
}

/** !profile / !profiles — List or show voice profiles */
async function handleProfiles(message: any, args: string[]) {
  const sub = args[1]?.toLowerCase();

  // !profile @user — show specific profile
  if (sub && message.mentions.users.size > 0) {
    const targetUser = message.mentions.users.first()!;
    const profile = profileStore.getProfile(targetUser.id);

    if (!profile) {
      await message.reply(
        `❌ No voice profile for **${targetUser.username}**`,
      );
      return;
    }

    await message.reply({
      embeds: [
        {
          color: 0x5865f2,
          title: `🎤 Voice Profile: ${profile.username}`,
          fields: [
            { name: "User ID", value: profile.userId, inline: true },
            {
              name: "Recorded",
              value: `<t:${Math.floor(profile.recordedAt / 1000)}:R>`,
              inline: true,
            },
            {
              name: "Sample",
              value: `${(profile.sampleDurationMs / 1000).toFixed(1)}s`,
              inline: true,
            },
          ],
          footer: { text: `${profileStore.count} profile(s) total` },
        },
      ],
    });
    return;
  }

  // !profiles — list all profiles
  const profiles = profileStore.listProfiles();

  if (profiles.length === 0) {
    await message.reply(
      "📭 No voice profiles yet. Record one with `!record` or enable `!vad on`.",
    );
    return;
  }

  const list = profiles
    .map(
      (p, i) =>
        `${i + 1}. **${p.username}** — recorded <t:${Math.floor(p.recordedAt / 1000)}:R>`,
    )
    .join("\n");

  await message.reply({
    embeds: [
      {
        color: 0x5865f2,
        title: `🎤 Voice Profiles (${profiles.length})`,
        description: list,
        footer: { text: "Use !profile @user for details • !deleteprofile @user to remove" },
      },
    ],
  });
}

/** !deleteprofile [@user] — Delete a user's voice profile */
async function handleDeleteProfile(message: any, args: string[]) {
  const targetUser = message.mentions.users.first();

  if (!targetUser) {
    await message.reply("❌ Usage: `!deleteprofile @user`");
    return;
  }

  const existed = profileStore.deleteProfile(targetUser.id);
  if (existed) {
    await message.reply(`🗑️ Deleted voice profile for **${targetUser.username}**`);
  } else {
    await message.reply(
      `❌ No voice profile found for **${targetUser.username}**`,
    );
  }
}

/** !setclone <text> — Set the default clone text for VAD auto-cloning */
async function handleSetClone(message: any, text: string) {
  if (!text) {
    const current = vadDetector?.getConfig().cloneText ?? defaultCloneText;
    await message.reply(`📝 Current clone text: *"${current}"*`);
    return;
  }

  defaultCloneText = text;
  vadDetector?.setConfig({ cloneText: text });

  await message.reply(`✅ Default clone text updated to: *"${text}"*`);
}

/** !vad — Manage voice activity detection */
async function handleVadCommand(message: any, args: string[]) {
  const sub = args[1]?.toLowerCase();

  // !vad status
  if (!sub || sub === "status") {
    const isActive = vadDetector?.isListening ?? false;
    const config = vadDetector?.getConfig();

    const lines = [
      `**VAD Status:** ${isActive ? "✅ Active" : "⏸️ Inactive"}`,
      `**Auto-Clone:** ${config?.autoClone ? "✅ On" : "❌ Off"}`,
      `**Auto-Profile:** ${config?.autoProfile ? "✅ On" : "❌ Off"}`,
      `**Listen to All:** ${config?.listenToAll ? "✅ Yes" : "❌ Only profiled users"}`,
      `**Silence Window:** ${config?.silenceDurationMs ?? "—"}ms`,
      `**Cooldown:** ${((config?.cooldownMs ?? 8000) / 1000).toFixed(0)}s`,
      `**Clone Text:** *"${config?.cloneText ?? defaultCloneText}"*`,
    ];

    await message.reply({
      embeds: [
        {
          color: isActive ? 0x57f287 : 0xed4245,
          title: "🎤 Voice Activity Detection",
          description: lines.join("\n"),
          fields: [
            {
              name: "Commands",
              value:
                "`!vad on` / `!vad off` — toggle\n" +
                "`!vad clone` / `!vad noclone` — toggle auto-clone\n" +
                "`!vad all` / `!vad profiles` — who to listen to\n" +
                "`!vad silence <ms>` — silence threshold\n" +
                "`!vad cooldown <s>` — clone cooldown",
            },
          ],
        },
      ],
    });
    return;
  }

  // !vad on / !vad off
  if (sub === "on" || sub === "enable") {
    if (!activeConnection) {
      await message.reply("❌ Not connected to a voice channel. Use `!join` first.");
      return;
    }
    if (!vadDetector) {
      startVad(activeConnection);
    } else {
      vadDetector.setConfig({ enabled: true });
    }
    await message.reply("✅ VAD enabled — I'll listen and respond to speech.");
    return;
  }

  if (sub === "off" || sub === "disable") {
    vadDetector?.setConfig({ enabled: false });
    await message.reply("⏸️ VAD paused.");
    return;
  }

  // !vad clone / !vad noclone
  if (sub === "clone") {
    vadDetector?.setConfig({ autoClone: true });
    await message.reply("✅ Auto-clone enabled — I'll speak back in your voice.");
    return;
  }
  if (sub === "noclone") {
    vadDetector?.setConfig({ autoClone: false });
    await message.reply("⏸️ Auto-clone disabled — I'll listen but stay silent.");
    return;
  }

  // !vad all / !vad profiles
  if (sub === "all") {
    vadDetector?.setConfig({ listenToAll: true });
    await message.reply("✅ Listening to all users (profiles will be auto-created).");
    return;
  }
  if (sub === "profiles") {
    vadDetector?.setConfig({ listenToAll: false });
    await message.reply(
      "✅ Only listening to users with existing profiles. New users must `!record` first.",
    );
    return;
  }

  // !vad silence <ms>
  if (sub === "silence") {
    const ms = parseInt(args[2], 10);
    if (isNaN(ms) || ms < 200 || ms > 5000) {
      await message.reply("❌ Usage: `!vad silence <200–5000>` (milliseconds)");
      return;
    }
    vadDetector?.setConfig({ silenceDurationMs: ms });
    await message.reply(`✅ Silence threshold set to ${ms}ms`);
    return;
  }

  // !vad cooldown <seconds>
  if (sub === "cooldown") {
    const seconds = parseFloat(args[2]);
    if (isNaN(seconds) || seconds < 1 || seconds > 60) {
      await message.reply("❌ Usage: `!vad cooldown <1–60>` (seconds)");
      return;
    }
    vadDetector?.setConfig({ cooldownMs: seconds * 1000 });
    await message.reply(`✅ Clone cooldown set to ${seconds}s`);
    return;
  }

  await message.reply(
    "❌ Unknown VAD subcommand. Try `!vad status` to see all options.",
  );
}

// ── Start ─────────────────────────────────────────────────────────────────

console.log("🚀 Starting ShadowVox ...");
client.login(TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});
