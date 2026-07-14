/**
 * ShadowVox - Voice Recorder
 *
 * Captures a user's audio from a Discord voice connection, decodes
 * Opus → PCM via prism-media, and converts to a .wav file for the
 * Python TTS engine. Supports both manual recording and VAD-triggered
 * recording with configurable end behavior.
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

// ── Types ─────────────────────────────────────────────────────────────────

export interface RecordingOptions {
  /**
   * When the recording stream should end.
   * - AfterSilence: ends after N ms of silence
   * - Manual: stream stays open until manually destroyed
   */
  endBehavior: EndBehaviorType;

  /**
   * Duration of silence (ms) before the stream ends when using
   * AfterSilence behavior. Default: 1000
   */
  silenceDuration: number;
}

const DEFAULT_OPTIONS: RecordingOptions = {
  endBehavior: EndBehaviorType.AfterSilence,
  silenceDuration: 1000,
};

// ── PCM → WAV ─────────────────────────────────────────────────────────────

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
      { stdio: "pipe", timeout: 15_000 },
    );
    // Clean up the raw PCM file
    unlinkSync(pcmPath);
    console.log(`✅ WAV saved: ${wavPath}`);
    return wavPath;
  } catch (err) {
    console.error("❌ FFmpeg conversion failed:", err);
    throw new Error(
      "FFmpeg conversion failed. Ensure ffmpeg is installed on the system.",
    );
  }
}

// ── Record ────────────────────────────────────────────────────────────────

/**
 * Record a target user's voice from a Discord voice connection.
 *
 * @param connection - Active @discordjs/voice VoiceConnection
 * @param userId     - Snowflake ID of the user to record
 * @param options    - Optional recording options (end behavior, silence duration)
 * @returns          - Path to the saved .wav file
 */
export async function recordUserVoice(
  connection: VoiceConnection,
  userId: string,
  options?: Partial<RecordingOptions>,
): Promise<string> {
  const receiver = connection.receiver;

  if (!receiver) {
    throw new Error("Voice connection has no receiver available");
  }

  const opts: RecordingOptions = { ...DEFAULT_OPTIONS, ...options };

  // Use a unique PCM filename to prevent collisions when recording
  // the same user rapidly (e.g., VAD triggers)
  const timestamp = Date.now();
  const pcmFilename = `${userId}_${timestamp}.pcm`;
  const pcmPath = join(RECORDINGS_DIR, pcmFilename);

  return new Promise<string>((resolve, reject) => {
    const fileWriter = createWriteStream(pcmPath);

    // Subscribe to the user's Opus stream
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: opts.endBehavior,
        duration: opts.silenceDuration,
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
      .then(() => {
        console.log(`✅ Recording saved: ${pcmPath}`);
        // FFmpeg looks for just {userId}.wav and {userId}.pcm,
        // so we copy/rename to the standard name, then convert
        const standardPcm = join(RECORDINGS_DIR, `${userId}.pcm`);
        const standardWav = join(RECORDINGS_DIR, `${userId}.wav`);

        // Rename the timestamped PCM to the standard name
        try {
          // We just pass the actual pcm path to convert and it'll rename
          convertPcmToWavCustom(pcmPath, standardWav)
            .then((wavPath) => resolve(wavPath))
            .catch(reject);
        } catch (err) {
          reject(err);
        }
      })
      .catch((err) => {
        console.error("❌ Recording pipeline error:", err);
        reject(err);
      });
  });
}

/**
 * Convert a specific PCM file to WAV at the target path.
 * This variant allows custom PCM input paths.
 */
async function convertPcmToWavCustom(
  pcmPath: string,
  wavPath: string,
): Promise<string> {
  if (!existsSync(pcmPath)) {
    throw new Error(`PCM file not found: ${pcmPath}`);
  }

  console.log(`🔄 Converting PCM → WAV: ${pcmPath}`);

  try {
    execSync(
      `ffmpeg -y -f s16le -ar 48000 -ac 2 -i "${pcmPath}" "${wavPath}"`,
      { stdio: "pipe", timeout: 15_000 },
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
