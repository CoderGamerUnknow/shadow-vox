/**
 * ShadowVox - Voice Cloner
 *
 * HTTP client that sends recorded voice data to the local Python
 * XTTS-v2 API and returns the path to the synthesized audio.
 */

import * as Sentry from "@sentry/node";
import axios from "axios";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

export interface CloneResult {
  status: string;
  file: string;
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
 * @returns               - Local filesystem path to the generated audio
 */
export async function generateClonedVoice(
  userId: string,
  text: string,
  speakerWavPath?: string,
  language = "en",
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
      },
    },
    async () => {
      console.log(`🔊 Requesting voice clone for user ${userId} ...`);

      const body: Record<string, unknown> = {
        user_id: userId,
        text,
        language,
      };

      // If a custom speaker path is provided, include it in the request
      if (speakerWavPath) {
        body.speaker_wav_path = speakerWavPath;
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
