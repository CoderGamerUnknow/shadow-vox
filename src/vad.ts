/**
 * ShadowVox - Voice Activity Detection (VAD) System
 *
 * Listens to a Discord voice connection's speaking events and
 * automatically records users when they talk. If a user has a
 * voice profile, the system can optionally auto-clone their voice
 * and play it back — creating a real-time voice mirror.
 */

import {
  VoiceConnection,
  EndBehaviorType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { profileStore, type VoiceProfile } from "./profiles.js";
import { recordUserVoice } from "./recorder.js";
import { generateClonedVoice } from "./cloner.js";
import { playClonedAudio } from "./player.js";

// ── Configuration ─────────────────────────────────────────────────────────

export interface VadConfig {
  /** Master toggle — set false to pause VAD without destroying the detector. */
  enabled: boolean;
  /**
   * Milliseconds of silence before the recording stream ends.
   * Lower = more responsive, higher = captures more context.
   */
  silenceDurationMs: number;
  /**
   * Minimum milliseconds between auto-clone triggers for the same user.
   * Prevents rapid-fire re-cloning while audio is still playing.
   */
  cooldownMs: number;
  /** The default text to speak when auto-cloning a voice. */
  cloneText: string;
  /**
   * If true, listen to ALL speaking users. If false, only listen
   * to users who already have a profile saved.
   */
  listenToAll: boolean;
  /**
   * If true, automatically clone and play back when a user with a
   * profile stops speaking.
   */
  autoClone: boolean;
  /**
   * If true, automatically save a voice profile when a NEW user
   * (without a profile) stops speaking.
   */
  autoProfile: boolean;
}

const DEFAULTS: VadConfig = {
  enabled: true,
  silenceDurationMs: 1200,
  cooldownMs: 8_000,
  cloneText:
    "Hello, I am your voice clone. I can sound just like you!",
  listenToAll: true,
  autoClone: true,
  autoProfile: true,
};

// ── Event Types ───────────────────────────────────────────────────────────

export type VadEventCallback = {
  onRecordingStart?: (userId: string) => void;
  onRecordingComplete?: (userId: string, wavPath: string) => void;
  onCloneStart?: (userId: string) => void;
  onCloneComplete?: (userId: string, audioPath: string) => void;
  onError?: (userId: string, error: string) => void;
};

// ── Detector ──────────────────────────────────────────────────────────────

export class VoiceActivityDetector {
  private connection: VoiceConnection;
  private config: VadConfig;
  private callbacks: VadEventCallback;

  /** Tracks currently active recordings (userId → start time). */
  private activeRecordings = new Map<string, number>();

  /** Tracks last-trigger timestamps to enforce cooldowns. */
  private lastTriggered = new Map<string, number>();

  /** Whether the speaking event listeners are currently attached. */
  private listening = false;

  /** Bound handler reference for cleanup. */
  private boundStartHandler: (userId: string) => void;
  private boundEndHandler: (userId: string) => void;

  constructor(
    connection: VoiceConnection,
    config?: Partial<VadConfig>,
    callbacks?: VadEventCallback,
  ) {
    this.connection = connection;
    this.config = { ...DEFAULTS, ...config };
    this.callbacks = callbacks ?? {};

    this.boundStartHandler = this.onSpeakingStart.bind(this);
    this.boundEndHandler = this.onSpeakingEnd.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Start listening for voice activity. */
  start(): void {
    if (this.listening) return;

    const receiver = this.connection.receiver;
    if (!receiver) {
      console.error("❌ VAD: No receiver available on voice connection");
      return;
    }

    // The SpeakingMap emits "start" and "end" with the userId
    receiver.speaking.on("start", this.boundStartHandler);
    receiver.speaking.on("end", this.boundEndHandler);

    this.listening = true;
    console.log(
      `🎤 VAD started (autoClone=${this.config.autoClone}, listenToAll=${this.config.listenToAll})`,
    );
  }

  /** Stop listening and clean up. */
  stop(): void {
    if (!this.listening) return;

    const receiver = this.connection.receiver;
    if (receiver) {
      receiver.speaking.off("start", this.boundStartHandler);
      receiver.speaking.off("end", this.boundEndHandler);
    }

    this.listening = false;
    console.log("⏹️  VAD stopped");
  }

  /** Update VAD configuration on the fly. */
  setConfig(config: Partial<VadConfig>): void {
    this.config = { ...this.config, ...config };
    console.log("⚙️  VAD config updated", this.config);
  }

  /** Get current config (for display). */
  getConfig(): VadConfig {
    return { ...this.config };
  }

  /** Whether the detector is actively listening. */
  get isListening(): boolean {
    return this.listening;
  }

  // ── Speaking Handlers ──────────────────────────────────────────────────

  private async onSpeakingStart(userId: string): Promise<void> {
    if (!this.config.enabled) return;

    // If not listening to all, require an existing profile
    if (!this.config.listenToAll && !profileStore.hasProfile(userId)) {
      return;
    }

    // Don't record if there's already an active recording for this user
    if (this.activeRecordings.has(userId)) return;

    const receiver = this.connection.receiver;
    if (!receiver) return;

    this.activeRecordings.set(userId, Date.now());
    this.callbacks.onRecordingStart?.(userId);

    // Silently record — the Promise resolves when the stream ends
    recordUserVoice(this.connection, userId, {
      endBehavior: EndBehaviorType.AfterSilence,
      silenceDuration: this.config.silenceDurationMs,
    })
      .then((wavPath) => this.onRecordingFinished(userId, wavPath))
      .catch((err) => {
        console.warn(`⚠️  VAD recording error for ${userId}:`, err.message);
        this.activeRecordings.delete(userId);
        this.callbacks.onError?.(userId, err.message);
      });
  }

  private onSpeakingEnd(userId: string): void {
    // Nothing extra needed — the recording stream handles its own end
  }

  // ── Post-Recording Pipeline ────────────────────────────────────────────

  private async onRecordingFinished(
    userId: string,
    wavPath: string,
  ): Promise<void> {
    this.activeRecordings.delete(userId);

    // Determine duration
    const startTime = this.activeRecordings.get(userId);
    const durationMs = startTime ? Date.now() - startTime : 0;

    console.log(
      `🎤 VAD captured ${userId} (${(durationMs / 1000).toFixed(1)}s) → ${wavPath}`,
    );

    this.callbacks.onRecordingComplete?.(userId, wavPath);

    const hasProfile = profileStore.hasProfile(userId);

    // Auto-profile: save recording for new users
    if (!hasProfile && this.config.autoProfile) {
      // Try to get the username from the connection
      let username = userId;
      try {
        const member = this.connection.joinConfig;
        // We can cache usernames, but we just store the userId for now
        // The username will be filled if available
      } catch {
        // noop
      }

      const profile: VoiceProfile = {
        userId,
        username: userId,
        guildId: this.connection.joinConfig.guildId,
        recordedAt: Date.now(),
        sampleDurationMs: durationMs,
        samplePath: wavPath,
      };
      profileStore.saveProfile(profile);
      console.log(`📝 Auto-saved voice profile for ${userId}`);
    }

    // Auto-clone: if the user has a profile (or just got one) and auto-clone is on
    if (this.config.autoClone && (hasProfile || this.config.autoProfile)) {
      await this.triggerClone(userId);
    }
  }

  private async triggerClone(userId: string): Promise<void> {
    // Cooldown check
    const last = this.lastTriggered.get(userId) ?? 0;
    if (Date.now() - last < this.config.cooldownMs) {
      console.log(`⏳ VAD cooldown active for ${userId}, skipping clone`);
      return;
    }
    this.lastTriggered.set(userId, Date.now());

    this.callbacks.onCloneStart?.(userId);
    console.log(`🗣️  VAD auto-cloning voice for ${userId} ...`);

    try {
      const audioPath = await generateClonedVoice(userId, this.config.cloneText);
      this.callbacks.onCloneComplete?.(userId, audioPath);

      playClonedAudio(this.connection, audioPath);
      console.log(`🔊 VAD played cloned voice for ${userId}`);
    } catch (err) {
      console.error(`❌ VAD clone failed for ${userId}:`, err);
      this.callbacks.onError?.(userId, String(err));
    }
  }
}
