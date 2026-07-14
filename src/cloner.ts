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
 * Send a user's voice profile and text to the Python TTS server for cloning.
 *
 * @param userId  - Discord user snowflake (used to locate the .wav file)
 * @param text    - The text to synthesize in the cloned voice
 * @returns       - Local filesystem path to the generated audio
 */
export async function generateClonedVoice(
  userId: string,
  text: string
): Promise<string> {
  return Sentry.startSpan(
    {
      name: "voice-clone-http",
      op: "http.post",
      attributes: {
        "clone.user_id": userId,
        "clone.text_length": text.length,
        "clone.api_url": PYTHON_API_URL,
      },
    },
    async () => {
      console.log(`🔊 Requesting voice clone for user ${userId} ...`);

      const response = await axios.post<CloneResult>(
        `${PYTHON_API_URL}/clone`,
        {
          user_id: userId,
          text,
          language: "en",
        },
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
