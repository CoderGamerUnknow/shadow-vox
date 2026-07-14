/**
 * ShadowVox - Voice Recorder
 *
 * Captures a user's audio from a Discord voice connection, decodes
 * Opus → PCM via prism-media, and converts to a .wav file for the
 * Python TTS engine. Supports both manual recording and VAD-triggered
 * recording with configurable end behavior.
 */

import * as Sentry from "@sentry/node";
import { createWriteStream, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import {
  VoiceConnection,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";
import { spawn } from "node:child_process";

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
          convertPcmToWavCore(pcmPath, standardWav)
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
 * Convert a PCM file to WAV using FFmpeg.
 * Core conversion function used by both standard and custom recording flows.
 * Assumes input: 48kHz, 16-bit signed, stereo PCM.
 */
async function convertPcmToWavCore(
  pcmPath: string,
  wavPath: string,
): Promise<string> {
  if (!existsSync(pcmPath)) {
    throw new Error(`PCM file not found: ${pcmPath}`);
  }

  console.log(`🔄 Converting PCM → WAV: ${pcmPath}`);

  return Sentry.startSpan(
    {
      name: "ffmpeg-convert",
      op: "audio.transcode",
      attributes: {
        "audio.input_path": pcmPath,
        "audio.output_path": wavPath,
      },
    },
    async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("ffmpeg", [
            "-y",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "-i", pcmPath,
            wavPath,
          ], { timeout: 15_000 });
          proc.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
          });
          proc.on("error", reject);
        });
        // Clean up the raw PCM file
        unlinkSync(pcmPath);
        console.log(`✅ WAV saved: ${wavPath}`);
        return wavPath;
      } catch (err) {
        console.error("❌ FFmpeg conversion failed:", err);
        throw new Error("FFmpeg conversion failed. Ensure ffmpeg is installed.");
      }
    },
  );
}
