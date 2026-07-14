/**
 * ShadowVox - Main Bot Entry Point
 *
 * A Discord bot that captures a user's voice, sends it to a local
 * Python XTTS-v2 server for voice cloning, and plays the result
 * back in the voice channel.
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
import { generateClonedVoice } from "./cloner.js";
import { playClonedAudio } from "./player.js";

// ── Constants ─────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const TARGET_VOICE_CHANNEL_ID = process.env.TARGET_VOICE_CHANNEL_ID;

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN is not set in .env");
  process.exit(1);
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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`ℹ️  Invite the bot at:\n   https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=3148800&scope=bot`);

  // Auto-join the configured voice channel on startup
  if (TARGET_GUILD_ID && TARGET_VOICE_CHANNEL_ID) {
    autoJoinChannel(TARGET_GUILD_ID, TARGET_VOICE_CHANNEL_ID);
  }
});

// ── Auto-Join ─────────────────────────────────────────────────────────────

let activeConnection: VoiceConnection | null = null;

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
  activeConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(activeConnection, VoiceConnectionStatus.Ready, 10_000);
    console.log("✅ Connected to voice channel");
  } catch {
    console.error("❌ Failed to connect to voice channel");
    activeConnection = null;
  }
}

// ── Slash Command: /clone ─────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Simple prefix commands for quick testing
  const prefix = "!";

  if (message.content.startsWith(`${prefix}join`)) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      await message.reply("❌ You must be in a voice channel first!");
      return;
    }

    activeConnection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(activeConnection, VoiceConnectionStatus.Ready, 10_000);
      await message.reply(`✅ Joined **${voiceChannel.name}**`);
    } catch {
      await message.reply("❌ Failed to join voice channel");
      activeConnection = null;
    }
  }

  if (message.content.startsWith(`${prefix}leave`)) {
    if (activeConnection) {
      activeConnection.destroy();
      activeConnection = null;
      await message.reply("👋 Left the voice channel");
    } else {
      await message.reply("❌ Not in a voice channel");
    }
  }

  if (message.content.startsWith(`${prefix}record`)) {
    const userId = message.mentions.users.first()?.id || message.author.id;

    if (!activeConnection) {
      await message.reply("❌ I'm not in a voice channel. Use `!join` first.");
      return;
    }

    await message.reply(`🎙️ Recording voice profile for <@${userId}> ...`);
    try {
      const filePath = await recordUserVoice(activeConnection, userId);
      await message.reply(`✅ Voice profile saved for <@${userId}>`);
    } catch (err) {
      await message.reply(`❌ Recording failed: ${err}`);
    }
  }

  if (message.content.startsWith(`${prefix}say`)) {
    const text = message.content.slice(5).trim();
    if (!text) {
      await message.reply("❌ Usage: `!say <text to speak>`");
      return;
    }

    const userId = message.author.id;
    if (!activeConnection) {
      await message.reply("❌ I'm not in a voice channel. Use `!join` first.");
      return;
    }

    await message.reply(`🗣️ Generating cloned voice...`);
    try {
      const audioPath = await generateClonedVoice(userId, text);
      playClonedAudio(activeConnection, audioPath);
      await message.reply(`🔊 Playing cloned voice in the channel!`);
    } catch (err) {
      await message.reply(`❌ Voice cloning failed: ${err}`);
    }
  }
});

// ── Voice State Tracking (auto-record on speaking) ────────────────────────

client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
  // Automatically detect when someone starts speaking
  if (newState.channelId && newState.id !== client.user?.id) {
    // This is handled by the receiver's subscribe method internally
    // We could trigger recording here if desired
  }
});

// ── Start ─────────────────────────────────────────────────────────────────

console.log("🚀 Starting ShadowVox ...");
client.login(TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});
