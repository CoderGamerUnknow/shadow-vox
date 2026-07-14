/**
 * ShadowVox - Voice Profile Store
 *
 * Manages multi-user voice profiles with JSON file persistence.
 * Each profile stores metadata about a user's recorded voice sample
 * that is used by the XTTS-v2 engine for voice cloning.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  /** Discord user snowflake */
  userId: string;
  /** User's display name at time of recording */
  username: string;
  /** Discord guild (server) where the recording was made */
  guildId: string;
  /** Unix timestamp (ms) when the profile was created / last updated */
  recordedAt: number;
  /** Duration of the recorded sample in milliseconds */
  sampleDurationMs: number;
  /** Relative path to the recorded .wav sample */
  samplePath: string;
}

interface PersistedData {
  version: number;
  profiles: Record<string, VoiceProfile>;
}

// ── Store ─────────────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = resolve(process.cwd(), "profiles.json");

export class ProfileStore {
  private profiles = new Map<string, VoiceProfile>();
  private persistencePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath ?? DEFAULT_PERSIST_PATH;
    this.load();
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /** Check if a voice profile exists for a user. */
  hasProfile(userId: string): boolean {
    return this.profiles.has(userId);
  }

  /** Get a user's voice profile. */
  getProfile(userId: string): VoiceProfile | undefined {
    return this.profiles.get(userId);
  }

  /** Return all stored voice profiles. */
  listProfiles(): VoiceProfile[] {
    return Array.from(this.profiles.values());
  }

  /** Number of stored profiles. */
  get count(): number {
    return this.profiles.size;
  }

  // ── Mutations ─────────────────────────────────────────────────────────

  /** Create or update a voice profile. */
  saveProfile(profile: VoiceProfile): void {
    this.profiles.set(profile.userId, profile);
    this.schedulePersist();
  }

  /** Delete a voice profile. Returns true if it existed. */
  deleteProfile(userId: string): boolean {
    const existed = this.profiles.delete(userId);
    if (existed) this.schedulePersist();
    return existed;
  }

  /** Delete all voice profiles. */
  clearAll(): void {
    this.profiles.clear();
    this.schedulePersist();
  }

  // ── Persistence ───────────────────────────────────────────────────────

  /** Load profiles from disk (called once at construction). */
  private load(): void {
    if (!existsSync(this.persistencePath)) return;

    try {
      const raw = readFileSync(this.persistencePath, "utf-8");
      const data = JSON.parse(raw) as PersistedData;

      if (data.version === 1 && data.profiles) {
        for (const profile of Object.values(data.profiles)) {
          this.profiles.set(profile.userId, profile);
        }
        console.log(
          `📂 Loaded ${this.profiles.size} voice profile(s) from disk`
        );
      }
    } catch (err) {
      console.warn("⚠️  Could not load profiles from disk:", err);
    }
  }

  /** Debounced write to disk. */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2_000);
  }

  /** Force an immediate write to disk. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const data: PersistedData = {
      version: 1,
      profiles: Object.fromEntries(this.profiles),
    };

    try {
      writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("❌ Failed to persist profiles:", err);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

/** Global profile store instance. */
export const profileStore = new ProfileStore();
