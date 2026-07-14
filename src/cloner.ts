/**
 * ShadowVox V2 - Voice Cloner
 *
 * HTTP client that sends recorded voice data to the local Python
 * XTTS-v2 API and returns the path to the synthesized audio.
 *
 * V2 Features:
 *   • Effect parameter for Voicelab audio processing
 *   • Voice-to-Voice pipeline (STT → TTS)
 */

import * as Sentry from "@sentry/node";
import axios from "axios";
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import { FormData } from "undici";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

export interface CloneResult {
  status: string;
  file: string;
  duration_seconds: number | null;
  effect_used?: string;
}

export interface V2VResult {
  status: string;
  transcribed_text: string;
  cloned_file: string;
  duration_seconds: number | null;
}

/**
 * Send a voice profile or preset reference to the Python TTS server for cloning.
 *
 * @param userId          - Discord user snowflake or preset ID (used for output naming)
 * @param text            - The text to synthesize in the cloned voice
 * @param speakerWavPath  - Optional path to a reference .wav file.
 *                           If omitted, the server looks for recordings/{userId}.wav.
 *                           If provided (e.g. presets/{presetId}.wav), that file is used.
 * @param language        - Language code for multilingual TTS (default: "en")
 * @param effect          - V2.2: Audio effect ('none' | 'walkie-talkie' | 'demon' | 'echo')
 * @returns               - Local filesystem path to the generated audio
 */
export async function generateClonedVoice(
  userId: string,
  text: string,
  speakerWavPath?: string,
  language = "en",
  effect = "none",
): Promise<string> {
  return Sentry.startSpan(
    {
      name: "voice-clone-http",
      op: "http.post",
      attributes: {
        "clone.user_id": userId,
        "clone.text_length": text.length,
        "clone.speaker_wav": speakerWavPath ?? "default",
        "clone.api_url": PYTHON_API_URL,
        "clone.effect": effect,
      },
    },
    async () => {
      console.log(`🔊 Requesting voice clone for user ${userId} (effect: ${effect}) ...`);

      const body: Record<string, unknown> = {
        user_id: userId,
        text,
        language,
        effect, // V2.2: Send effect to the Python server
      };

      // If a custom speaker path is provided, sanitize and include it
      if (speakerWavPath) {
        // Resolve to absolute path and validate it's within the project directory
        const resolved = resolve(speakerWavPath);
        const cwd = process.cwd();
        if (!resolved.startsWith(cwd)) {
          throw new Error("Speaker WAV path is outside the allowed project directory");
        }
        body.speaker_wav_path = resolved;
      }

      const response = await axios.post<CloneResult>(
        `${PYTHON_API_URL}/clone`,
        body,
        { timeout: 60_000 }
      );

      if (response.data.status === "success") {
        console.log(`✅ Voice cloned successfully → ${response.data.file}`);
        Sentry.getActiveSpan()?.setAttribute("clone.output_file", response.data.file);
        if (response.data.duration_seconds != null) {
          Sentry.getActiveSpan()?.setAttribute("clone.duration_seconds", response.data.duration_seconds);
        }
        return response.data.file;
      }

      throw new Error(`Voice cloning API returned: ${response.data.status}`);
    },
  );
}

/**
 * V2.3: Voice-to-Voice pipeline.
 * Sends an audio recording to the Python server, which transcribes it
 * with Whisper-tiny, then clones the voice of the target user,
 * and returns the path to the synthesized audio.
 *
 * @param sourceUserId   - The user who spoke (recorded audio)
 * @param targetUserId   - The user whose voice to clone into
 * @param audioPath      - Path to the recorded .wav file
 * @param effect         - V2.2: Audio effect to apply
 * @returns               - Path to the synthesized audio file
 */
export async function sendVoiceToVoice(
  sourceUserId: string,
  targetUserId: string,
  audioPath?: string,
  effect = "none",
): Promise<string | null> {
  return Sentry.startSpan(
    {
      name: "v2v-pipeline",
      op: "http.post",
      attributes: {
        "v2v.source_user": sourceUserId,
        "v2v.target_user": targetUserId,
        "v2v.effect": effect,
      },
    },
    async () => {
      try {
        if (!audioPath) {
          // Use the default recorded path for the source user
          const { join } = await import("node:path");
          audioPath = resolve(process.cwd(), "recordings", `${sourceUserId}.wav`);
        }

        console.log(`🗣️  V2V: ${sourceUserId} → ${targetUserId}`);

        const form = new FormData();
        form.append("audio", createReadStream(audioPath), `v2v_${sourceUserId}.wav`);
        form.append("source_user_id", sourceUserId);
        form.append("target_user_id", targetUserId);
        form.append("language", "en");
        form.append("effect", effect);

        const response = await axios.post<V2VResult>(
          `${PYTHON_API_URL}/voice-to-voice`,
          form,
          {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 120_000,
          }
        );

        if (response.data.status === "success") {
          console.log(
            `✅ V2V: "${response.data.transcribed_text.slice(0, 60)}..." → ${response.data.cloned_file}`
          );
          Sentry.getActiveSpan()?.setAttribute("v2v.transcribed_text", response.data.transcribed_text);
          Sentry.getActiveSpan()?.setAttribute("v2v.output_file", response.data.cloned_file);
          return response.data.cloned_file;
        }

        console.warn(`⚠️  V2V returned non-success: ${response.data.status}`);
        return null;
      } catch (err) {
        console.error("❌ V2V pipeline error:", err);
        return null;
      }
    },
  );
}

/**
 * Check if the Python TTS server is running and healthy.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/health`, {
      timeout: 5_000,
    });
    return response.data.status === "ok" || response.data.model_loaded;
  } catch {
    return false;
  }
}
