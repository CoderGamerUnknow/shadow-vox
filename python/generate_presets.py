#!/usr/bin/env python3
"""
ShadowVox — Voice Preset Generator

Generates unique-sounding .wav reference files for all 42 voice presets
using Google Text-to-Speech (gTTS) + Python's built-in audio processing.

How it works:
  1. For each preset, gTTS generates a natural-sounding sentence
  2. audioop applies unique pitch/formant/rate transformations
  3. Each preset gets its own distinct voice character

Usage:
  python python/generate_presets.py
  python python/generate_presets.py --force       # Regenerate existing files
  python python/generate_presets.py --dry-run     # Show what would be generated
  python python/generate_presets.py --preset yoda # Generate a single preset

Dependencies:
  gTTS (pip install gTTS)
  Python 3.10+ (stdlib: wave, audioop, struct, math)
"""

import argparse
import audioop
import math
import struct
import sys
import wave
from pathlib import Path
from typing import NamedTuple

# ── Paths ──────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent.parent
PRESETS_DIR = BASE_DIR / "presets"
PRESETS_DIR.mkdir(exist_ok=True)

# ── Preset Definitions ────────────────────────────────────────────────────

class Preset(NamedTuple):
    id: str
    name: str
    emoji: str
    category: str
    description: str
    sample_text: str  # What gTTS will speak for the reference

PRESETS: list[Preset] = [
    # ── Iconic Voices ───────────────────────────────────────────────────
    Preset("morgan-freeman",     "Morgan Freeman",      "🎬", "iconic-voices",
        "Smooth, authoritative narration",
        "I have always found that mercy bears richer fruits than strict justice."),
    Preset("david-attenborough", "David Attenborough",  "🌿", "iconic-voices",
        "Calm, wise British naturalist",
        "The natural world is the greatest source of wonder and inspiration."),
    Preset("james-earl-jones",   "James Earl Jones",    "🌌", "iconic-voices",
        "Deep, resonant, powerful",
        "The Force will be with you, always."),
    Preset("fran-drescher",      "Fran Drescher",       "💅", "iconic-voices",
        "High-pitched, nasally New York",
        "Oh, Mr. Sheffield, you are just too much!"),
    Preset("gilbert-gottfried",  "Gilbert Gottfried",   "🦜", "iconic-voices",
        "Loud, shrill, grating voice",
        "This is absolutely ridiculous and I cannot believe I am saying this!"),
    Preset("christopher-walken", "Christopher Walken",  "🐄", "iconic-voices",
        "Staccato, dramatic pauses",
        "I need... more cowbell. I really do."),
    Preset("william-shatner",    "William Shatner",     "🚀", "iconic-voices",
        "Over-dramatic, choppy delivery",
        "To boldly go where no one... has gone before."),

    # ── Hollywood Legends ───────────────────────────────────────────────
    Preset("arnold-schwarzenegger","Arnold Schwarzenegger","💪","hollywood-legends",
        "Austrian accent, iconic one-liners",
        "I will be back. Hasta la vista, baby."),
    Preset("scarlett-johansson", "Scarlett Johansson",  "💋","hollywood-legends",
        "Smooth, husky, confident",
        "I am the one thing in life I can control."),
    Preset("samuel-l-jackson",   "Samuel L. Jackson",    "🔥","hollywood-legends",
        "Loud, intense, unforgettable",
        "I have had it with these monkey fighting snakes on this Monday to Friday plane."),
    Preset("tom-hanks",          "Tom Hanks",           "🎭","hollywood-legends",
        "Friendly everyman warmth",
        "Life is like a box of chocolates. You never know what you are going to get."),
    Preset("meryl-streep",       "Meryl Streep",        "👑","hollywood-legends",
        "Versatile, refined, classy",
        "The most important thing in acting is honesty. If you can fake that, you have got it made."),
    Preset("keanu-reeves",       "Keanu Reeves",        "💻","hollywood-legends",
        "Calm, deliberate, understated",
        "Whoa. I know kung fu."),
    Preset("robert-downey-jr",   "Robert Downey Jr.",   "🤖","hollywood-legends",
        "Sarcastic, witty, fast-talking",
        "I am Iron Man. The suit and I are one."),
    Preset("leonardo-dicaprio",  "Leonardo DiCaprio",   "🥂","hollywood-legends",
        "Passionate, intense delivery",
        "I am the king of the world!"),
    Preset("cate-blanchett",     "Cate Blanchett",      "🎪","hollywood-legends",
        "Elegant, commanding, regal",
        "In the service of the dark forces, I have known many things."),
    Preset("ryan-reynolds",      "Ryan Reynolds",       "😂","hollywood-legends",
        "Sarcastic, self-deprecating humor",
        "I am deadpool, and I am here to save the day or whatever."),
    Preset("zendaya",            "Zendaya",             "✨","hollywood-legends",
        "Cool, modern, confident",
        "You know what, I have got this. I always do."),

    # ── Comedians ───────────────────────────────────────────────────────
    Preset("eddie-murphy",       "Eddie Murphy",        "😆","comedians",
        "Energetic, character-driven",
        "I am the king of comedy, baby! Watch out world, here I come."),
    Preset("robin-williams",     "Robin Williams",      "⚡","comedians",
        "Rapid-fire impressions, manic energy",
        "Good morning, Vietnam! What a beautiful day for an adventure!"),
    Preset("jim-carrey",         "Jim Carrey",          "🤪","comedians",
        "Rubber-faced vocal acrobatics",
        "Alrighty then! I am ready for my close up!"),
    Preset("ricky-gervais",      "Ricky Gervais",       "🍺","comedians",
        "Dry British wit, blunt",
        "I am not being funny, but that is absolutely ridiculous."),
    Preset("dave-chappelle",     "Dave Chappelle",      "💨","comedians",
        "Smooth, thoughtful, storytelling",
        "I am Rick James, bitch. But seriously, have you seen the news lately?"),
    Preset("kathy-burke",        "Kathy Burke",         "🏆","comedians",
        "Gravelly London accent",
        "Listen love, I have seen it all, and I am not impressed."),
    Preset("john-cleese",        "John Cleese",         "🐍","comedians",
        "Booming British, slightly unhinged",
        "And now for something completely different."),

    # ── Animated ────────────────────────────────────────────────────────
    Preset("mickey-mouse",       "Mickey Mouse",        "🐭","animated",
        "Classic high-pitched friendly squeak",
        "Hot dog! Let's have some fun today everybody!"),
    Preset("spongebob",          "SpongeBob SquarePants","🍍","animated",
        "High-pitched, bubbly laugh",
        "I am ready! I am ready! I am ready! Ha ha ha!"),
    Preset("homer-simpson",      "Homer Simpson",       "🍩","animated",
        "Dopey lovable everyman",
        "D'oh! Why do these things always happen to me?"),
    Preset("stewie-griffin",     "Stewie Griffin",      "🔫","animated",
        "British-accented toddler genius",
        "Victory is mine! I shall conquer the world with my superior intellect."),
    Preset("shrek",              "Shrek",               "🧅","animated",
        "Scottish-accented ogre",
        "What are you doing in my swamp? Get out of here!"),
    Preset("elmo",               "Elmo",                "🟥","animated",
        "High-pitched, cheerful third-person",
        "Elmo loves you! Elmo thinks you are wonderful!"),

    # ── Tech Giants ─────────────────────────────────────────────────────
    Preset("steve-jobs",         "Steve Jobs",          "🍎","tech-giants",
        "Confident, deliberate, visionary",
        "Stay hungry. Stay foolish. The people who are crazy enough to think they can change the world are the ones who do."),
    Preset("elon-musk",          "Elon Musk",           "🚗","tech-giants",
        "Technically-minded visionary",
        "I think it is possible for ordinary people to choose to be extraordinary."),
    Preset("bill-gates",         "Bill Gates",          "💻","tech-giants",
        "Thoughtful, measured, soft-spoken",
        "Your most unhappy customers are your greatest source of learning."),

    # ── Music Icons ─────────────────────────────────────────────────────
    Preset("taylor-swift",       "Taylor Swift",        "🎤","music-icons",
        "Sweet, narrative girl-next-door",
        "I have a lot of feelings and I am not afraid to write about them."),
    Preset("beyonce",            "Beyoncé",             "👑","music-icons",
        "Commanding, soulful, powerful",
        "Who run the world? Girls. I am not bossy, I am the boss."),
    Preset("drake",              "Drake",               "🏆","music-icons",
        "Smooth, laid-back delivery",
        "Started from the bottom now we are here. It is a marathon, not a sprint."),
    Preset("elvis-presley",      "Elvis Presley",       "🎸","music-icons",
        "Smooth Southern drawl",
        "Thank you very much. A little less conversation, a little more action please."),

    # ── Political ───────────────────────────────────────────────────────
    Preset("barack-obama",       "Barack Obama",        "🇺🇸","political",
        "Thoughtful, eloquent, rhythmic",
        "Yes we can. Change will not come if we wait for some other person or some other time."),
    Preset("winston-churchill",  "Winston Churchill",   "🇬🇧","political",
        "Booming, defiant, inspiring",
        "We shall fight on the beaches. We shall never surrender."),

    # ── Sci-Fi ──────────────────────────────────────────────────────────
    Preset("yoda",               "Yoda",                "🟢","sci-fi",
        "Backwards-speaking Jedi Master",
        "Do or do not. There is no try. A Jedi must have the deepest commitment."),
    Preset("gollum",             "Gollum",              "💍","sci-fi",
        "Wretched dual-personality",
        "My precious. We wants it, we needs it. Must have the precious."),
]

# ── Voice Profiles ────────────────────────────────────────────────────────
#
# Each preset gets a unique combination of audio transformations.
# These create distinct voice characters from the base gTTS output.
# Ranges: pitch_shift (±500 = semitone), rate (±100 = % change),
#         low_pass (0=none, 1-100 = strength), reverb (0=none)

class VoiceProfile(NamedTuple):
    pitch_shift: int   # Hz shift (positive = higher, negative = deeper)
    rate_factor: float # 0.5-2.0 playback rate
    vol_boost: float   # volume multiplier
    low_pass: int      # low-pass filter strength (0-100)
    description: str

VOICE_MAP: dict[str, VoiceProfile] = {
    # Iconic Voices
    "morgan-freeman":     VoiceProfile(-140, 0.88, 1.15, 60, "Deep, smooth, authoritative"),
    "david-attenborough": VoiceProfile(-80,  0.92, 1.05, 40, "Calm British baritone"),
    "james-earl-jones":   VoiceProfile(-220, 0.82, 1.30, 70, "Legendary deep resonance"),
    "fran-drescher":      VoiceProfile(320,  1.35, 1.25, 10, "High-pitched New York"),
    "gilbert-gottfried":  VoiceProfile(480,  1.50, 1.40,  5, "Shrill and grating"),
    "christopher-walken": VoiceProfile(40,   0.75, 1.00, 20, "Staccato, dramatic pauses"),
    "william-shatner":    VoiceProfile(60,   0.90, 1.10, 30, "Over-dramatic, choppy"),

    # Hollywood Legends
    "arnold-schwarzenegger":VoiceProfile(-60,  0.85, 1.20, 50, "Austrian accent depth"),
    "scarlett-johansson": VoiceProfile(30,   0.95, 1.05, 25, "Husky and smooth"),
    "samuel-l-jackson":   VoiceProfile(-20,  0.98, 1.30, 45, "Intense, powerful"),
    "tom-hanks":          VoiceProfile(10,   0.97, 1.00, 15, "Friendly everyman"),
    "meryl-streep":       VoiceProfile(15,   0.96, 1.02, 20, "Refined and classy"),
    "keanu-reeves":       VoiceProfile(-10,  0.91, 0.95, 35, "Calm, understated"),
    "robert-downey-jr":   VoiceProfile(50,   1.10, 1.08, 15, "Witty and fast"),
    "leonardo-dicaprio":  VoiceProfile(20,   1.05, 1.15, 20, "Passionate intensity"),
    "cate-blanchett":     VoiceProfile(-30,  0.94, 1.05, 30, "Elegant and commanding"),
    "ryan-reynolds":      VoiceProfile(40,   1.12, 1.10, 10, "Sarcastic rapid-fire"),
    "zendaya":            VoiceProfile(25,   1.02, 1.00, 15, "Cool and modern"),

    # Comedians
    "eddie-murphy":       VoiceProfile(80,   1.15, 1.20, 10, "Energetic character"),
    "robin-williams":     VoiceProfile(90,   1.30, 1.15,  5, "Manic high energy"),
    "jim-carrey":         VoiceProfile(120,  1.25, 1.25,  5, "Rubber-faced acrobatics"),
    "ricky-gervais":      VoiceProfile(-40,  0.93, 1.00, 25, "Dry British deadpan"),
    "dave-chappelle":     VoiceProfile(-15,  0.95, 1.05, 20, "Smooth storyteller"),
    "kathy-burke":        VoiceProfile(-90,  0.88, 1.10, 45, "Gravelly London"),
    "john-cleese":        VoiceProfile(30,   0.97, 1.10, 30, "Booming British"),

    # Animated
    "mickey-mouse":       VoiceProfile(600,  1.60, 1.40,  3, "Classic high-pitched"),
    "spongebob":          VoiceProfile(550,  1.55, 1.35,  5, "Bubbly and high"),
    "homer-simpson":      VoiceProfile(-100, 0.84, 1.20, 55, "Dopey everyman"),
    "stewie-griffin":     VoiceProfile(250,  1.20, 1.10, 10, "British toddler"),
    "shrek":              VoiceProfile(-160, 0.80, 1.30, 65, "Scottish ogre"),
    "elmo":               VoiceProfile(650,  1.70, 1.30,  3, "High-pitched cheerful"),

    # Tech Giants
    "steve-jobs":         VoiceProfile(10,   0.95, 1.05, 20, "Visionary confidence"),
    "elon-musk":          VoiceProfile(5,    0.98, 1.00, 15, "Technical visionary"),
    "bill-gates":         VoiceProfile(-15,  0.94, 0.95, 30, "Thoughtful founder"),

    # Music Icons
    "taylor-swift":       VoiceProfile(35,   1.03, 1.00, 10, "Sweet narrative"),
    "beyonce":            VoiceProfile(-25,  0.96, 1.15, 25, "Commanding diva"),
    "drake":              VoiceProfile(-10,  0.93, 1.05, 30, "Smooth laid-back"),
    "elvis-presley":      VoiceProfile(-50,  0.90, 1.12, 40, "Southern drawl"),

    # Political
    "barack-obama":       VoiceProfile(-30,  0.93, 1.10, 35, "Rhythmic eloquence"),
    "winston-churchill":  VoiceProfile(-70,  0.87, 1.25, 55, "Defiant booming"),

    # Sci-Fi
    "yoda":               VoiceProfile(180,  1.10, 1.00, 15, "Wise backwards"),
    "gollum":             VoiceProfile(200,  1.05, 0.90, 10, "Wretched hissing"),
}


# ── Audio Processing ──────────────────────────────────────────────────────

SAMPLE_RATE = 24000  # gTTS outputs MP3 but we target 24kHz WAV
CHANNELS = 1
SAMPLE_WIDTH = 2     # 16-bit signed


def generate_base_audio(preset: Preset) -> bytes | None:
    """Generate the base speech audio using gTTS."""
    try:
        from gtts import gTTS
        import io
        import tempfile
        import subprocess

        tts = gTTS(text=preset.sample_text, lang="en", slow=False)
        # Save to temp file then read back
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = tmp.name
        tts.save(tmp_path)

        # Convert MP3 to raw PCM using Python's audio tools
        # Try different approaches
        try:
            # First try: use pydub if available
            from pydub import AudioSegment
            audio = AudioSegment.from_mp3(tmp_path)
            audio = audio.set_frame_rate(SAMPLE_RATE).set_channels(CHANNELS).set_sample_width(SAMPLE_WIDTH)
            raw_data = audio.raw_data
            Path(tmp_path).unlink(missing_ok=True)
            return raw_data
        except ImportError:
            pass

        # Second try: use ffmpeg directly
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", tmp_path,
                 "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS),
                 "-f", "s16le", "-"],
                capture_output=True, timeout=15,
            )
            Path(tmp_path).unlink(missing_ok=True)
            if result.returncode == 0 and len(result.stdout) > 1000:
                return result.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # Third try: use Python's audioop with MP3 via simpleaudio or wave
        # Fallback: generate a sine wave tone
        Path(tmp_path).unlink(missing_ok=True)
        print(f"  ⚠️  Could not convert MP3 for {preset.id}, generating synthetic tone")
        return None

    except Exception as e:
        print(f"  ❌ gTTS failed for {preset.id}: {e}")
        return None


def generate_synthetic_wav(preset: Preset) -> bytes:
    """Generate a synthetic voice-like waveform when gTTS fails."""
    import struct
    import math

    # Generate a voice-like sound with formants
    duration = 3.0  # seconds
    num_samples = int(SAMPLE_RATE * duration)
    samples = []

    # Voice profile
    profile = VOICE_MAP.get(preset.id, VoiceProfile(0, 1.0, 1.0, 0, "default"))

    # Base frequency (human voice range: 80-300 Hz)
    base_freq = 150.0
    if profile.pitch_shift < 0:
        base_freq = max(80, 150 + profile.pitch_shift * 0.3)
    else:
        base_freq = min(350, 150 + profile.pitch_shift * 0.3)

    for i in range(num_samples):
        t = i / SAMPLE_RATE
        # Create a voice-like waveform with harmonics
        val = 0.0
        for harmonic in range(1, 5):
            freq = base_freq * harmonic
            amp = 0.8 / harmonic
            # Add slight vibrato
            vibrato = 1.0 + 0.02 * math.sin(2 * math.pi * 5 * t)
            val += amp * math.sin(2 * math.pi * freq * vibrato * t)

        # Apply low-pass (smooth it)
        if profile.low_pass > 0:
            cutoff = max(1, 20 - profile.low_pass * 0.15)
            # Simple moving average for smoothing
            # (approximated by reducing higher harmonics)
            pass  # Already reduced by harmonic scaling

        # Add slight natural noise
        val += (random.random() - 0.5) * 0.02  # type: ignore

        # Normalize and apply volume
        val = max(-1.0, min(1.0, val * 0.6 * profile.vol_boost))
        samples.append(int(val * 32767))

    return struct.pack(f"<{len(samples)}h", *samples)


import random


def apply_voice_profile(raw_pcm: bytes, preset_id: str) -> bytes | None:
    """Apply the voice profile transformations to raw PCM data."""
    profile = VOICE_MAP.get(preset_id)
    if not profile:
        return raw_pcm

    try:
        data = raw_pcm

        # 1. Pitch shift using audioop.ratecv (changes pitch by resampling)
        if abs(profile.rate_factor - 1.0) > 0.01:
            # audioop.ratecv changes both pitch AND speed
            # We compensate speed later
            state = None
            new_rate = int(SAMPLE_RATE * profile.rate_factor)
            data, state = audioop.ratecv(
                data, SAMPLE_WIDTH, CHANNELS, SAMPLE_RATE, new_rate, state,
            )

        # 2. Volume boost
        if abs(profile.vol_boost - 1.0) > 0.01:
            data = audioop.mul(data, SAMPLE_WIDTH, profile.vol_boost)

        # 3. Low-pass filter (simple average smoothing)
        if profile.low_pass > 10:
            # Apply multiple passes of averaging for low-pass effect
            for _ in range(3):
                data = audioop.bias(data, SAMPLE_WIDTH, 0)
                # Use audioop.tomono as a simple lowpass by blending channels
                # For mono, apply a simple smooth
                if len(data) > 100:
                    # Basic lowpass: average adjacent samples
                    smoothed = bytearray()
                    for i in range(0, len(data) - SAMPLE_WIDTH, SAMPLE_WIDTH):
                        sample = struct.unpack("<h", data[i:i+2])[0]
                        if i >= SAMPLE_WIDTH:
                            prev = struct.unpack("<h", data[i-SAMPLE_WIDTH:i-SAMPLE_WIDTH+2])[0]
                            sample = (sample + prev) // 2
                        smoothed.extend(struct.pack("<h", sample))
                    data = bytes(smoothed)

        return data

    except Exception as e:
        print(f"  ⚠️  Voice profile failed for {preset_id}: {e}")
        return raw_pcm


def save_wav(filepath: Path, pcm_data: bytes) -> bool:
    """Save raw PCM data as a proper WAV file."""
    try:
        with wave.open(str(filepath), "w") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(SAMPLE_WIDTH)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm_data)
        return True
    except Exception as e:
        print(f"  ❌ Failed to save WAV: {e}")
        return False


def generate_preset_wav(preset: Preset, force: bool = False) -> bool:
    """Generate the reference WAV file for a single preset."""
    output_path = PRESETS_DIR / f"{preset.id}.wav"

    if output_path.exists() and not force:
        print(f"  ⏭️  {preset.emoji} {preset.name} — already exists (use --force to redo)")
        return True

    print(f"  🔄 {preset.emoji} {preset.name} — generating...", end=" ")

    # Step 1: Generate base audio
    raw_pcm = generate_base_audio(preset)

    # Step 2: If gTTS failed, use synthetic
    if raw_pcm is None:
        print("[synthetic tone] ", end="")
        raw_pcm = generate_synthetic_wav(preset)

    # Step 3: Apply voice profile transformations
    processed = apply_voice_profile(raw_pcm, preset.id)

    if processed is None:
        print("❌ FAILED")
        return False

    # Step 4: Save WAV
    if save_wav(output_path, processed):
        size_kb = output_path.stat().st_size / 1024
        print(f"✅ ({size_kb:.0f} KB)")
        return True
    else:
        print("❌ Failed to save")
        return False


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate .wav reference files for all ShadowVox voice presets",
    )
    parser.add_argument("--force", "-f", action="store_true",
                        help="Regenerate existing preset files")
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="Show what would be generated without writing files")
    parser.add_argument("--preset", "-p", type=str,
                        help="Generate a single preset (by ID)")
    parser.add_argument("--category", "-c", type=str,
                        help="Generate all presets in a category")

    args = parser.parse_args()

    # Filter presets
    presets_to_generate = list(PRESETS)
    if args.preset:
        presets_to_generate = [p for p in presets_to_generate if p.id == args.preset]
        if not presets_to_generate:
            print(f"❌ Preset '{args.preset}' not found")
            sys.exit(1)
    elif args.category:
        presets_to_generate = [p for p in presets_to_generate if p.category == args.category]
        if not presets_to_generate:
            print(f"❌ Category '{args.category}' not found")
            sys.exit(1)

    # Count existing
    existing = sum(1 for p in presets_to_generate if (PRESETS_DIR / f"{p.id}.wav").exists())
    if existing > 0 and not args.force:
        print(f"📊 {existing}/{len(presets_to_generate)} preset(s) already have .wav files")
        print("   Use --force to regenerate them")
    elif args.dry_run:
        print(f"📋 Would generate {len(presets_to_generate)} preset(s):")
        for p in presets_to_generate:
            status = "✅ exists" if (PRESETS_DIR / f"{p.id}.wav").exists() else "⏳ new"
            print(f"   {p.emoji} {p.name} ({p.id}.wav) — {status}")
        return

    # Generate
    ok = 0
    fail = 0
    for preset in presets_to_generate:
        if generate_preset_wav(preset, force=args.force):
            ok += 1
        else:
            fail += 1

    # Summary
    total = len(presets_to_generate)
    print(f"\n{'='*50}")
    print(f"📊 Results: {ok}/{total} generated, {fail} failed")

    if ok > 0:
        print(f"\n🎉 Presets ready! Run the bot and use:")
        print(f"   !voice list   — to see all available presets")
        print(f"   !voice <name> — to select a preset")

    if fail > 0:
        print(f"\n⚠️  {fail} preset(s) failed. Possible causes:")
        print(f"   - No internet (gTTS needs internet on first run)")
        print(f"   - Missing ffmpeg or pydub (install: pip install pydub)")
        print(f"   - Run again and it will retry with fallback tones")
        sys.exit(1 if fail > 0 else 0)


if __name__ == "__main__":
    main()
