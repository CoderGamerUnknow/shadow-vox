/**
 * ShadowVox V2 - Main Bot Entry Point
 *
 * V2 Upgrades:
 *   • Consent & Privacy Safeguard — users must approve recording
 *   • Voicelab Effects — Walkie-Talkie, Demon, Echo filters
 *   • Voice-to-Voice Mode — whisper STT → clone pipeline
 *   • Live Audio Waveform — WebSocket amplitude streaming
 */

// ⚠️  Sentry instrumentation MUST be the first import
import "./instrument.js";
import * as Sentry from "@sentry/node";

import {
  Client,
  GatewayIntentBits,
  Events,
  VoiceState,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import "dotenv/config";

import { recordUserVoice } from "./recorder.js";
import { generateClonedVoice, healthCheck, sendVoiceToVoice } from "./cloner.js";
import { playClonedAudio } from "./player.js";
import { VoiceActivityDetector } from "./vad.js";
import { profileStore, type VoiceProfile } from "./profiles.js";
import {
  VOICE_PRESETS,
  findPreset,
  getPresetsByCategory,
  CATEGORY_META,
  type VoicePreset,
} from "./presets.js";

// ── Consent State ────────────────────────────────────────────────────────
// Tracks which users have approved/denied voice recording.
// Consent clears when the user leaves the voice channel.
type ConsentStatus = "pending" | "approved" | "denied";
const consentState = new Map<string, ConsentStatus>();

function getConsent(userId: string): ConsentStatus {
  return consentState.get(userId) ?? "pending";
}

function setConsent(userId: string, status: ConsentStatus) {
  consentState.set(userId, status);
}

function clearConsent(userId: string) {
  consentState.delete(userId);
}

// ── Constants ─────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const TARGET_VOICE_CHANNEL_ID = process.env.TARGET_VOICE_CHANNEL_ID;
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3000", 10);
const ADMIN_ENABLED = process.env.ADMIN_DISABLED !== "true";

/** Number of available presets (those with .wav files on disk). */
const availablePresetCount = VOICE_PRESETS.filter((p) => p.available).length;

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

/** Currently active voice preset (null = use recorded profile). */
let activePreset: VoicePreset | null = null;

/** User → preset overrides for auto-cloning specific users with presets. */
const userPresetOverrides = new Map<string, string>();

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

  // Register slash commands
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN!);
    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: [
        {
          name: "generate-readme",
          description: "Dynamically generate and update the project README.md",
        },
      ],
    });
    console.log("✅ Slash command /generate-readme registered");
  } catch (err) {
    console.warn("⚠️  Could not register slash command:", err);
    Sentry.captureException(err);
  }

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
      activePreset,
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
  } catch (err) {
    console.error("❌ Failed to connect to voice channel");
    Sentry.captureException(err);
    connection.destroy();
  }
}

function startVad(connection: VoiceConnection) {
  if (vadDetector) {
    vadDetector.stop();
  }

  // V2.1: Wire up consent check into VAD config
  const consentCheck = (userId: string): boolean => {
    const status = getConsent(userId);
    if (status === "denied") {
      console.log(`🔇 VAD: ${userId} denied consent — not recording`);
      return false;
    }
    if (status === "pending") {
      console.log(`⏳ VAD: ${userId} has not consented — skipping`);
      // Auto-setting to pending — user will need to click approve
      return false;
    }
    return true; // approved
  };

  vadDetector = new VoiceActivityDetector(
    connection,
    {
      cloneText: defaultCloneText,
      consentCheck, // V2.1: Pass consent check function
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
        Sentry.addBreadcrumb({ category: "vad", message: `VAD error for ${userId}: ${error}`, level: "error" });
        Sentry.captureException(new Error(`VAD error for ${userId}: ${error}`));
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
      case "voice":
        await handleVoice(message, args, rest);
        break;
      // ── V2 Commands ────────────────────────────────────────────
      case "vad":
        await handleVadCommand(message, args);
        break;
      case "effect":
        await handleEffectCommand(message, args, rest);
        break;
      case "v2v":
        await handleV2VCommand(message, args);
        break;
      case "consent":
        await handleConsentCommand(message, args);
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
    Sentry.addBreadcrumb({ category: "command", message: `Command '${command}' failed`, level: "error" });
    Sentry.captureException(err);
    const safeMsg = String(err).slice(0, 200).replace(/[\r\n]/g, " ");
    await message.reply(`❌ An error occurred: \`${safeMsg}\``).catch(() => {});
  }
});

// ── Slash Command & Button Handler ─────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle button interactions (consent, V2V)
  if (interaction.isButton()) {
    const [action, userId] = interaction.customId.split(":");

    if (action === "consent-approve") {
      setConsent(userId, "approved");
      await interaction.reply({
        content: "✅ **Recording Approved** — Your voice may now be captured for cloning.",
        ephemeral: true,
      });
      console.log(`✅ Consent granted by ${userId}`);
      return;
    }

    if (action === "consent-deny") {
      setConsent(userId, "denied");
      await interaction.reply({
        content: "🔇 **Recording Denied** — Your voice will never be captured. You can rejoin VC and click \"Approve\" to change this.",
        ephemeral: true,
      });
      console.log(`🔇 Consent denied by ${userId}`);
      return;
    }

    if (action === "v2v-start") {
      // Voice-to-Voice: bot will listen and auto-transcribe
      if (!activeConnection) {
        await interaction.reply({ content: "❌ Bot is not in a voice channel.", ephemeral: true });
        return;
      }
      if (vadDetector) {
        vadDetector.setConfig({ v2vMode: true, v2vTargetUserId: userId });
      }
      await interaction.reply({
        content: "🗣️ **Voice-to-Voice Mode ON** — Speak and I'll repeat in the target user's voice!",
        ephemeral: true,
      });
      return;
    }

    if (action === "v2v-stop") {
      if (vadDetector) {
        vadDetector.setConfig({ v2vMode: false, v2vTargetUserId: "" });
      }
      await interaction.reply({
        content: "⏹️ **Voice-to-Voice Mode OFF**",
        ephemeral: true,
      });
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "generate-readme") {
    // Defer the reply since generation may take a moment
    await interaction.deferReply({ ephemeral: false });

    try {
      const { generateReadme } = await import("./docs-generator.js");
      const result = generateReadme();
      const sizeKb = (result.size / 1024).toFixed(1);

      await interaction.editReply({
        embeds: [
          {
            color: 0x8b5cf6,
            title: "📝 README.md Generated",
            description:
              `File written to \`${result.path}\`\n` +
              `**Size:** ${sizeKb} KB\n` +
              `**Last Updated:** <t:${Math.floor(Date.now() / 1000)}:F>`,
            fields: [
              {
                name: "📁 Project Tree",
                value: "Source files, dependencies, and commands were scanned",
                inline: true,
              },
              {
                name: "💬 Commands",
                value: "Prefix commands and REST API routes are documented",
                inline: true,
              },
              {
                name: "🔑 Env Vars",
                value: "All environment variables are documented",
                inline: true,
              },
            ],
            footer: {
              text: `ShadowVox • Generated at ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
            },
          },
        ],
      });
    } catch (err) {
      console.error("❌ /generate-readme failed:", err);
      Sentry.captureException(err);
      await interaction.editReply({
        content: `❌ Failed to generate README: \`${err}\``,
      });
    }
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

    // V2.1: Send consent request to everyone in the channel
    await message.reply(`✅ Joined **${voiceChannel.name}** — VAD is active`);
    await requestConsent(message, connection);
  } catch {
    connection.destroy();
    activeConnection = null;
    await message.reply("❌ Failed to join voice channel");
  }
}

/**
 * V2.1: Send consent buttons to all members in the voice channel.
 * Each user sees an ephemeral [Approve] [Deny] prompt.
 */
async function requestConsent(message: any, connection: VoiceConnection) {
  const channel = message.member?.voice.channel;
  if (!channel) return;

  const members = channel.members.filter((m: any) => !m.user.bot);
  if (members.size === 0) return;

  const approveBtn = new ButtonBuilder()
    .setCustomId(`consent-approve:${message.author.id}`)
    .setLabel("✅ Approve Recording")
    .setStyle(ButtonStyle.Success);

  const denyBtn = new ButtonBuilder()
    .setCustomId(`consent-deny:${message.author.id}`)
    .setLabel("🚫 Deny")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, denyBtn);

  const embed = {
    color: 0x8b5cf6,
    title: "🔒 Voice Recording Consent Required",
    description:
      "This bot can clone voices for entertainment purposes.\n" +
      "**Your privacy matters.** By clicking Approve, you consent to having " +
      "your voice captured, processed by a local AI model, and played back " +
      "in the voice channel.\n\n" +
      "Click **Deny** if you do not want your voice recorded. " +
      "Your choice will be respected until you leave the channel.",
    fields: [
      {
        name: "How it works",
        value:
          "1. You speak in VC → your Opus audio is captured\n" +
          "2. The audio is decoded and sent to a local Python AI\n" +
          "3. The AI clones your voice and speaks the text\n" +
          "4. **No audio leaves your server** — everything runs locally",
        inline: false,
      },
      {
        name: "Data handling",
        value:
          "• Audio is processed in real-time and discarded after cloning\n" +
          "• Voice profiles are stored locally as .wav files\n" +
          "• You can delete your profile anytime with `!deleteprofile`\n" +
          "• No data is sent to third-party services",
        inline: false,
      },
    ],
    footer: { text: "You can change your mind by leaving and rejoining VC" },
  };

  // Send ephemeral consent request to each member
  for (const [, member] of members) {
    try {
      await member.send({ embeds: [embed], components: [row] }).catch(() => {
        // Can't DM — skip
      });
    } catch {
      // Silently skip users who can't be DMed
    }
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
    Sentry.captureException(err);
    const safeErr = String(err).slice(0, 200).replace(/[\r\n]/g, " ");
    await message.reply(`❌ Recording failed: \`${safeErr}\``);
  }
}

/** !voice — List or select a voice preset */
async function handleVoice(message: any, args: string[], rest: string) {
  const sub = args[1]?.toLowerCase();

  // !voice list — show all presets grouped by category
  if (!sub || sub === "list" || sub === "all") {
    const categories = Array.from(new Set(VOICE_PRESETS.map((p) => p.category)));
    const lines: string[] = [];

    for (const cat of categories) {
      const meta = CATEGORY_META[cat];
      const presets = VOICE_PRESETS.filter((p) => p.category === cat);
      const avail = presets.filter((p) => p.available).length;
      lines.push(`**${meta?.emoji ?? "📁"} ${meta?.label ?? cat}** (${avail}/${presets.length} ready)`);
      for (const p of presets) {
        const status = p.available ? "✅" : "⏳";
        lines.push(`  ${status} ${p.emoji} **${p.name}** — \`!voice ${p.id}\``);
      }
      lines.push("");
    }

    // Chunk the response if it's too long (Discord limit: 2000 chars)
    const full = lines.join("\n");
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      if ((current + "\n" + line).length > 1900 && current) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);

    await message.reply({
      embeds: [
        {
          color: 0x8b5cf6,
          title: `🎭 Voice Presets (${VOICE_PRESETS.length})`,
          description:
            `**${availablePresetCount} presets available** • Use \`!voice <name>\` to select\n` +
            `Use \`!voice off\` to return to your own voice\n` +
            `Place .wav files in \`presets/\` to activate presets`,
          fields: [
            {
              name: "Current Preset",
              value: activePreset
                ? `${activePreset.emoji} **${activePreset.name}**`
                : "🎤 Your own voice (no preset)",
              inline: false,
            },
            {
              name: "Quick Select",
              value:
                "`!voice morgan` → Morgan Freeman\n" +
                "`!voice arnold` → Arnold Schwarzenegger\n" +
                "`!voice yoda` → Yoda\n" +
                "`!voice off` → Back to your voice",
              inline: false,
            },
          ],
          footer: { text: `Use !voice <id> to select • Total: ${VOICE_PRESETS.length} presets` },
        },
      ],
    });
    return;
  }

  // !voice off / none — clear preset, use recorded voice
  if (sub === "off" || sub === "none" || sub === "clear") {
    activePreset = null;  vadDetector?.setConfig({ activePresetId: "" });
  await message.reply("🎤 Voice preset cleared — you'll now use your recorded voice.");
  return;
}

  // !voice <name> — select a preset by ID or name
  const query = sub || rest;
  const preset = findPreset(query);

  if (!preset) {
    // Try fuzzy search
    const fuzzy = VOICE_PRESETS.filter(
      (p) =>
        p.id.includes(query) ||
        p.name.toLowerCase().includes(query),
    );
    if (fuzzy.length === 1) {
      // Exact fuzzy match → auto-select
      if (!fuzzy[0].available) {
        await message.reply(
          `⏳ Preset **${fuzzy[0].emoji} ${fuzzy[0].name}** is not yet available. ` +
            `Add \`presets/${fuzzy[0].id}.wav\` to activate it.`,
        );
        return;
      }
      activePreset = fuzzy[0];
      vadDetector?.setConfig({ activePresetId: fuzzy[0].id });
      await message.reply(
        `✅ Voice preset set to ${fuzzy[0].emoji} **${fuzzy[0].name}**!\n` +
          `💡 Try \`!say Hello, this is ${fuzzy[0].name}!\``,
      );
      return;
    }
    if (fuzzy.length > 1) {
      await message.reply(
        `❓ Multiple presets match "${query}":\n` +
          fuzzy.map((p) => `  ${p.emoji} \`${p.id}\` — ${p.name}`).join("\n"),
      );
      return;
    }
    await message.reply(
      `❌ No preset found for "${query}". Try \`!voice list\` to see all presets.`,
    );
    return;
  }

  if (!preset.available) {
    await message.reply(
      `⏳ Preset **${preset.emoji} ${preset.name}** is not yet available. ` +
        `Place \`presets/${preset.id}.wav\` in the presets folder to activate it.`,
    );
    return;
  }

  activePreset = preset;
  vadDetector?.setConfig({ activePresetId: preset.id });
  const categoryLabel = CATEGORY_META[preset.category]?.label ?? preset.category;
  await message.reply({
    embeds: [
      {
        color: 0x8b5cf6,
        title: `✅ Voice Preset: ${preset.emoji} ${preset.name}`,
        description: preset.description,
        fields: [
          { name: "Category", value: categoryLabel, inline: true },
          { name: "Language", value: preset.language.toUpperCase(), inline: true },
          {
            name: "Try it",
            value: `\`!say Hello, I'm ${preset.name}!\``,
            inline: false,
          },
        ],
        footer: { text: `Use !voice off to return to your own voice` },
      },
    ],
  });
}

/** !say <text> — Clone and speak (uses active preset or recorded profile) */
async function handleSay(message: any, text: string) {
  if (!text) {
    await message.reply("❌ Usage: `!say <text to speak>`");
    return;
  }

  // Sanitize input: strip control characters and limit length
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, 500);

  const userId = message.author.id;

  if (!activeConnection) {
    await message.reply("❌ I'm not in a voice channel. Use `!join` first.");
    return;
  }

  // If a preset is active, use the preset's reference audio
  if (activePreset) {
    if (!activePreset.available) {
      await message.reply(
        `⏳ Preset **${activePreset.emoji} ${activePreset.name}** is not available. ` +
          `Select another preset or use \`!voice off\` to use your recorded voice.`,
      );
      return;
    }
    await message.reply(`🗣️ ${activePreset.emoji} Speaking as **${activePreset.name}**...`);
    try {
      const audioPath = await generateClonedVoice(
        `preset_${activePreset.id}`,
        text,
        activePreset.wavPath,
        activePreset.language,
      );
      playClonedAudio(activeConnection, audioPath);
      await message.reply(`🔊 ${activePreset.emoji} **${activePreset.name}** said it!`);
    } catch (err) {
      Sentry.captureException(err);
      await message.reply(`❌ Voice cloning failed: \`${err}\``);
    }
    return;
  }

  // No preset — use the sender's recorded profile
  if (!profileStore.hasProfile(userId)) {
    await message.reply(
      "❌ No voice profile found for you. Record one with `!record` " +
        "or select a preset with `!voice list`.",
    );
    return;
  }

  await message.reply(`🗣️ Generating cloned voice...`);
  try {
    const audioPath = await generateClonedVoice(userId, text);
    playClonedAudio(activeConnection, audioPath);
    await message.reply(`🔊 Playing cloned voice!`);
  } catch (err) {
    Sentry.captureException(err);
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

// ── V2 Commands ──────────────────────────────────────────────────────────

/** !effect — Set the audio effect for voice cloning */
async function handleEffectCommand(message: any, args: string[], rest: string) {
  const sub = args[1]?.toLowerCase();

  if (!sub || sub === "list" || sub === "help") {
    await message.reply({
      embeds: [{
        color: 0x8b5cf6,
        title: "🎛️ Voicelab Effects",
        description:
          "Apply audio effects to make your cloned voice sound cooler.\n\n" +
          "**Available effects:**\n" +
          "📻 `walkie-talkie` — Narrow bandpass radio filter\n" +
          "👹 `demon` — Deep pitch shift + distortion\n" +
          "🌊 `echo` — Multi-tap reverb with space\n" +
          "🎤 `none` — Natural, no effect (default)\n\n" +
          "**Usage:** `!effect walkie-talkie`\n" +
          "**Check:** `!effect current`",
      }],
    });
    return;
  }

  if (sub === "current" || sub === "status") {
    const current = (vadDetector?.getConfig().effect) || "none";
    const names: Record<string, string> = {
      none: "🎤 None (natural voice)",
      "walkie-talkie": "📻 Walkie-Talkie",
      demon: "👹 Demon",
      echo: "🌊 Echo/Reverb",
    };
    await message.reply(`🎛️ Current effect: ${names[current] || current}`);
    return;
  }

  const validEffects = ["none", "walkie-talkie", "demon", "echo"];
  if (!validEffects.includes(sub)) {
    await message.reply(`❌ Unknown effect "${sub}". Try \`!effect list\` to see options.`);
    return;
  }

  vadDetector?.setConfig({ effect: sub });
  const names: Record<string, string> = {
    none: "🎤 None (natural voice)",
    "walkie-talkie": "📻 Walkie-Talkie",
    demon: "👹 Demon",
    echo: "🌊 Echo/Reverb",
  };
  await message.reply(`✅ Effect set to: ${names[sub]}`);
}

/** !v2v — Voice-to-Voice mode control */
async function handleV2VCommand(message: any, args: string[]) {
  const sub = args[1]?.toLowerCase();

  if (!sub || sub === "status") {
    const config = vadDetector?.getConfig();
    const isOn = config?.v2vMode ?? false;
    const target = config?.v2vTargetUserId || "none";
    await message.reply(
      `🗣️ **Voice-to-Voice:** ${isOn ? "✅ ON" : "❌ OFF"}\n` +
      `**Target voice:** ${target}\n\n` +
      `Commands:\n` +
      `  \`!v2v on\` — Enable V2V mode\n` +
      `  \`!v2v off\` — Disable V2V mode\n` +
      `  \`!v2v target @user\` — Set whose voice to clone into`,
    );
    return;
  }

  if (sub === "on") {
    vadDetector?.setConfig({ v2vMode: true });
    await message.reply("🗣️ **Voice-to-Voice ON** — Speak and I'll repeat in the target user's voice!");
    return;
  }

  if (sub === "off") {
    vadDetector?.setConfig({ v2vMode: false, v2vTargetUserId: "" });
    await message.reply("⏹️ **Voice-to-Voice OFF**");
    return;
  }

  if (sub === "target") {
    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      await message.reply("❌ Mention a user: `!v2v target @username`");
      return;
    }
    vadDetector?.setConfig({ v2vTargetUserId: targetUser.id });
    await message.reply(`🎯 V2V target set to **${targetUser.username}** — speech will be cloned into their voice.`);
    return;
  }

  await message.reply("❌ Usage: `!v2v [on|off|target @user|status]`");
}

/** !consent — Check or manage voice recording consent */
async function handleConsentCommand(message: any, args: string[]) {
  const sub = args[1]?.toLowerCase();

  if (!sub || sub === "status") {
    const targetUser = message.mentions.users.first() || message.author;
    const status = getConsent(targetUser.id);
    const statusEmoji: Record<ConsentStatus, string> = {
      approved: "✅ Approved",
      denied: "🔇 Denied",
      pending: "⏳ Pending",
    };
    await message.reply(
      `🔒 **Consent for ${targetUser.username}:** ${statusEmoji[status]}`
    );
    return;
  }

  if (sub === "request") {
    // Re-send consent request
    if (!activeConnection) {
      await message.reply("❌ Not connected to a voice channel.");
      return;
    }
    await requestConsent(message, activeConnection);
    return;
  }

  if (sub === "approve" || sub === "allow") {
    const targetUser = message.mentions.users.first() || message.author;
    setConsent(targetUser.id, "approved");
    await message.reply(`✅ Consent approved for **${targetUser.username}**`);
    return;
  }

  if (sub === "deny" || sub === "block") {
    const targetUser = message.mentions.users.first() || message.author;
    setConsent(targetUser.id, "denied");
    await message.reply(`🔇 Consent denied for **${targetUser.username}**`);
    return;
  }

  await message.reply(
    "❌ Usage: `!consent [status|request|approve|deny] [@user]`\n" +
    "When the bot joins VC, you'll receive an ephemeral Approve/Deny prompt.",
  );
}

// ── Start ─────────────────────────────────────────────────────────────────

console.log("🚀 Starting ShadowVox ...");
client.login(TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  Sentry.captureException(err);
  process.exit(1);
});
