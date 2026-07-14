/**
 * ShadowVox - Voice Preset Library
 *
 * 40 built-in celebrity-inspired voice presets organized by category.
 * Users can select any preset via !voice <name> or the dashboard dropdown.
 *
 * Each preset requires a reference .wav file in the presets/ directory
 * named {presetId}.wav. If the file doesn't exist, the preset appears
 * as "unavailable" until the user provides the audio sample.
 *
 * ⚠️  Legal Disclaimer: These presets are parodic/fan-created voice
 *     profiles for entertainment. Users assume responsibility for
 *     complying with voice likeness and publicity rights laws.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export interface VoicePreset {
  /** Unique identifier for the preset (e.g. "morgan-freeman") */
  id: string;
  /** Display name (e.g. "Morgan Freeman") */
  name: string;
  /** Emoji / flag icon for UI display */
  emoji: string;
  /** Category grouping */
  category: PresetCategory;
  /** Short description / character note */
  description: string;
  /** Full path to the reference .wav file */
  wavPath: string;
  /** Whether the reference audio file exists on disk */
  available: boolean;
  /** The language code this preset works best with */
  language: string;
}

export type PresetCategory =
  | "iconic-voices"
  | "hollywood-legends"
  | "comedians"
  | "animated"
  | "tech-giants"
  | "music-icons"
  | "political"
  | "sci-fi";

// ── Presets Directory ─────────────────────────────────────────────────────

export const PRESETS_DIR = resolve(process.cwd(), "presets");
mkdirSync(PRESETS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────

function createPreset(
  id: string,
  name: string,
  emoji: string,
  category: PresetCategory,
  description: string,
  language = "en",
): VoicePreset {
  const wavPath = join(PRESETS_DIR, `${id}.wav`);
  return {
    id,
    name,
    emoji,
    category,
    description,
    wavPath,
    available: existsSync(wavPath),
    language,
  };
}

// ── 40 Voice Presets ──────────────────────────────────────────────────────

const PRESETS_DATA: Array<[string, string, string, PresetCategory, string, string?]> = [
  // ── Iconic Voices ───────────────────────────────────────────────────
  ["morgan-freeman",     "Morgan Freeman",    "🎬", "iconic-voices", "Smooth, authoritative narration — the voice of God himself"],
  ["david-attenborough", "David Attenborough","🌿", "iconic-voices", "Calm, wise British naturalist — makes anything sound like a nature documentary"],
  ["james-earl-jones",   "James Earl Jones",  "🌌", "iconic-voices", "Deep, resonant, powerful — the voice of Darth Vader and Mufasa"],
  ["fran-drescher",      "Fran Drescher",     "💅", "iconic-voices", "High-pitched, nasally, unmistakable New York accent — The Nanny's voice"],
  ["gilbert-gottfried",  "Gilbert Gottfried","🦜", "iconic-voices", "Loud, shrill, grating — the most distinctive voice in comedy"],
  ["christopher-walken", "Christopher Walken","🐄", "iconic-voices", "Staccato, dramatic pauses, utterly unique cadence — more cowbell"],
  ["william-shatner",    "William Shatner",   "🚀", "iconic-voices", "Over-dramatic, choppy delivery — Captain Kirk's signature style"],

  // ── Hollywood Legends ───────────────────────────────────────────────
  ["arnold-schwarzenegger","Arnold Schwarzenegger","💪","hollywood-legends","Austrian accent, iconic one-liners — 'I'll be back'"],
  ["scarlett-johansson", "Scarlett Johansson","💋","hollywood-legends","Smooth, husky, confident — Black Widow and Her's AI voice"],
  ["samuel-l-jackson",   "Samuel L. Jackson",  "🔥","hollywood-legends","Loud, intense, motherf*****g iconic — you know the voice"],
  ["tom-hanks",          "Tom Hanks",         "🎭","hollywood-legends","Friendly, everyman warmth — Forrest Gump to Woody"],
  ["meryl-streep",       "Meryl Streep",      "👑","hollywood-legends","Versatile, refined, classy — the greatest living actress"],
  ["keanu-reeves",       "Keanu Reeves",      "💻","hollywood-legends","Calm, deliberate, understated — Neo meets John Wick"],
  ["robert-downey-jr",   "Robert Downey Jr.", "🤖","hollywood-legends","Sarcastic, witty, fast-talking — Tony Stark persona"],
  ["leonardo-dicaprio",  "Leonardo DiCaprio", "🥂","hollywood-legends","Passionate, intense, rising inflection — Oscar-winner energy"],
  ["cate-blanchett",     "Cate Blanchett",    "🎪","hollywood-legends","Elegant, commanding, regal — Galadriel to Carol Danvers"],
  ["ryan-reynolds",      "Ryan Reynolds",     "😂","hollywood-legends","Sarcastic, self-deprecating, rapid-fire — Deadpool humor"],
  ["zendaya",            "Zendaya",           "✨","hollywood-legends","Cool, modern, confident — Euphoria meets MJ energy"],

  // ── Comedians ───────────────────────────────────────────────────────
  ["eddie-murphy",       "Eddie Murphy",      "😆","comedians","Energetic, character-driven, hilarious — Donkey to Raw"],
  ["robin-williams",     "Robin Williams",    "⚡","comedians","Rapid-fire impressions, manic energy, pure joy — Mrs. Doubtfire"],
  ["jim-carrey",         "Jim Carrey",        "🤪","comedians","Rubber-faced vocal acrobatics — Ace Ventura energy"],
  ["ricky-gervais",      "Ricky Gervais",     "🍺","comedians","Dry British wit, sarcastic, blunt — 'The Office' deadpan"],
  ["dave-chappelle",     "Dave Chappelle",    "💨","comedians","Smooth, thoughtful, cutting — storytelling at its finest"],
  ["kathy-burke",        "Kathy Burke",       "🏆","comedians","Gravelly London accent, sharp-tongued, hilarious"],
  ["john-cleese",        "John Cleese",       "🐍","comedians","Booming, posh British, slightly unhinged — Monty Python legend"],

  // ── Animated ────────────────────────────────────────────────────────
  ["mickey-mouse",       "Mickey Mouse",      "🐭","animated","Classic high-pitched friendly squeak — the most famous mouse"],
  ["spongeBob",          "SpongeBob SquarePants","🍍","animated","High-pitched, bubbly, infectious laugh — absorbent and yellow"],
  ["homer-simpson",      "Homer Simpson",     "🍩","animated","Dopey, lovable, iconic 'D'oh!' — Springfield's finest"],
  ["stewie-griffin",     "Stewie Griffin",    "🔫","animated","British-accented toddler genius — diabolical and hilarious"],
  ["shrek",              "Shrek",             "🧅","animated","Scottish-accented, gruff but lovable ogre — 'WHAT ARE YOU DOING IN MY SWAMP?'"],
  ["elmo",               "Elmo",              "🟥","animated","High-pitched, cheerful, third-person cute — Sesame Street favorite"],

  // ── Tech Giants ─────────────────────────────────────────────────────
  ["steve-jobs",         "Steve Jobs",        "🍎","tech-giants","Confident, deliberate, reality-distortion-field energy"],
  ["elon-musk",          "Elon Musk",         "🚗","tech-giants","Slightly awkward, technically-minded, visionary — sometimes surprising"],
  ["bill-gates",         "Bill Gates",        "💻","tech-giants","Thoughtful, measured, soft-spoken — Microsoft founder calm"],

  // ── Music Icons ─────────────────────────────────────────────────────
  ["taylor-swift",       "Taylor Swift",      "🎤","music-icons","Sweet, narrative, girl-next-door with a country twinge"],
  ["beyonce",            "Beyoncé",           "👑","music-icons","Commanding, soulful, powerful — Queen Bey energy"],
  ["drake",              "Drake",             "🏆","music-icons","Smooth, laid-back, slightly melancholic — Toronto accent"],
  ["elvis-presley",      "Elvis Presley",     "🎸","music-icons","Smooth Southern drawl, iconic — the King of Rock 'n' Roll"],

  // ── Political ───────────────────────────────────────────────────────
  ["barack-obama",       "Barack Obama",      "🇺🇸","political","Thoughtful, eloquent, rhythmic — 'Yes We Can' cadence"],
  ["winston-churchill",  "Winston Churchill", "🇬🇧","political","Booming British, defiant, inspiring — 'We shall fight on the beaches'"],

  // ── Sci-Fi ──────────────────────────────────────────────────────────
  ["yoda",               "Yoda",              "🟢","sci-fi","Backwards-speaking, wise, ancient Jedi Master — 'Do or do not'"],
  ["gollum",             "Gollum / Sméagol",  "💍","sci-fi","Wretched, dual-personality, hissing — 'My precious'"],
];

// ── Preset Store ──────────────────────────────────────────────────────────

export const VOICE_PRESETS: VoicePreset[] = PRESETS_DATA.map(([id, name, emoji, category, description, language]) =>
  createPreset(id, name, emoji, category, description, language),
);

// ── Lookup Helpers ────────────────────────────────────────────────────────

/** Find a preset by its ID (case-insensitive). */
export function findPreset(idOrName: string): VoicePreset | undefined {
  const key = idOrName.toLowerCase().trim();
  return VOICE_PRESETS.find(
    (p) => p.id === key || p.name.toLowerCase() === key,
  );
}

/** Get all presets in a specific category. */
export function getPresetsByCategory(category: PresetCategory): VoicePreset[] {
  return VOICE_PRESETS.filter((p) => p.category === category);
}

/** Get all unique categories. */
export function getPresetCategories(): PresetCategory[] {
  const cats = new Set(VOICE_PRESETS.map((p) => p.category));
  return Array.from(cats);
}

/** Refresh the availability status of all presets (checks disk). */
export function refreshPresetsAvailability(): void {
  for (const preset of VOICE_PRESETS) {
    (preset as VoicePreset).available = existsSync(preset.wavPath);
  }
}

/** Refresh a single preset's availability. */
export function refreshPresetAvailability(id: string): void {
  const preset = findPreset(id);
  if (preset) {
    (preset as VoicePreset).available = existsSync(preset.wavPath);
  }
}

// ── Category Display Info ────────────────────────────────────────────────

export const CATEGORY_META: Record<PresetCategory, { label: string; emoji: string }> = {
  "iconic-voices":    { label: "Iconic Voices",    emoji: "🎙️" },
  "hollywood-legends":{ label: "Hollywood Legends", emoji: "🎬" },
  "comedians":        { label: "Comedians",         emoji: "😂" },
  "animated":         { label: "Animated",          emoji: "🐭" },
  "tech-giants":      { label: "Tech Giants",       emoji: "💻" },
  "music-icons":      { label: "Music Icons",       emoji: "🎵" },
  "political":        { label: "Political",         emoji: "🌍" },
  "sci-fi":           { label: "Sci-Fi & Fantasy",  emoji: "🚀" },
};

// ── Refresh on module load ────────────────────────────────────────────────
refreshPresetsAvailability();
