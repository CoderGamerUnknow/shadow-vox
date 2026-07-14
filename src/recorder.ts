/**
 * ShadowVox - Voice Recorder
 *
 * Joins a Discord voice channel, subscribes to a specific user's audio
 * stream, decodes Opus → PCM, and saves it as a .wav file for the
 * Python TTS engine.
 */

import { createWriteStream, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import {
  VoiceConnection,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";
import { execSync } from "node:child_process";

const RECORDINGS_DIR = join(process.cwd(), "recordings");

// Ensure the recordings directory exists
mkdirSync(RECORDINGS_DIR, { recursive: true });

/**
 * Convert raw PCM to a WAV file using FFmpeg.
 * Assumes input: 48kHz, 16-bit signed, stereo PCM.
 */
async function convertPcmToWav(userId: string): Promise<string> {
  const pcmPath = join(RECORDINGS_DIR, `${userId}.pcm`);
  const wavPath = join(RECORDINGS_DIR, `${userId}.wav`);

  if (!existsSync(pcmPath)) {
    throw new Error(`PCM file not found: ${pcmPath}`);
  }

  console.log(`🔄 Converting PCM → WAV for user ${userId}`);

  try {
    execSync(
      `ffmpeg -y -f s16le -ar 48000 -ac 2 -i "${pcmPath}" "${wavPath}"`,
      { stdio: "pipe" }
    );
    // Clean up the raw PCM file
    unlinkSync(pcmPath);
    console.log(`✅ WAV saved: ${wavPath}`);
    return wavPath;
  } catch (err) {
    console.error("❌ FFmpeg conversion failed:", err);
    throw new Error("FFmpeg conversion failed. Ensure ffmpeg is installed.");
  }
}

/**
 * Record a target user's voice from a Discord voice connection.
 *
 * @param connection - Active @discordjs/voice VoiceConnection
 * @param userId     - Snowflake ID of the user to record
 * @returns          - Path to the saved .wav file
 */
export async function recordUserVoice(
  connection: VoiceConnection,
  userId: string
): Promise<string> {
  const receiver = connection.receiver;

  if (!receiver) {
    throw new Error("Voice connection has no receiver available");
  }

  return new Promise<string>((resolve, reject) => {
    const pcmPath = join(RECORDINGS_DIR, `${userId}.pcm`);
    const fileWriter = createWriteStream(pcmPath);

    // Subscribe to the user's Opus stream, ending after 1s of silence
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    });

    // Decode Opus → 48 kHz, 16-bit signed, stereo PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    console.log(`🎙️ Recording voice for user: ${userId}`);

    pipeline(opusStream, decoder, fileWriter)
      .then(async () => {
        console.log(`✅ Recording saved: ${pcmPath}`);
        const wavPath = await convertPcmToWav(userId);
        resolve(wavPath);
      })
      .catch((err) => {
        console.error("❌ Recording pipeline error:", err);
        reject(err);
      });
  });
}
