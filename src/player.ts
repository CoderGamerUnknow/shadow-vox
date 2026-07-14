/**
 * ShadowVox - Audio Player
 *
 * Plays synthesized cloned audio back through a Discord voice connection
 * using @discordjs/voice's AudioPlayer.
 */

import {
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { createReadStream } from "node:fs";

/**
 * Play a cloned audio file back through an active voice connection.
 *
 * @param connection     - Active @discordjs/voice VoiceConnection
 * @param audioFilePath  - Path to the .wav (or other supported) audio file
 */
export function playClonedAudio(
  connection: VoiceConnection,
  audioFilePath: string
): void {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const resource = createAudioResource(audioFilePath);

  console.log(`🔊 Playing audio: ${audioFilePath}`);

  player.play(resource);
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Playing, () => {
    console.log("▶️ Playback started");
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log("✅ Playback finished");
    player.stop();
  });

  player.on("error", (error) => {
    console.error("❌ Playback error:", error.message);
  });
}

/**
 * Play a custom text-to-speech message using the system TTS as a fallback.
 * (Used when the Python server is unavailable.)
 *
 * @param connection - Active VoiceConnection
 * @param text       - Text to speak
 */
export function playFallbackTTS(
  connection: VoiceConnection,
  text: string
): void {
  console.warn("⚠️  Fallback TTS requested (requires local TTS setup)");
  // Future: integrate with say.js or festival for basic TTS fallback
  console.log("💡 Install `say` (macOS) or `espeak` (Linux) for fallback TTS.");
}
