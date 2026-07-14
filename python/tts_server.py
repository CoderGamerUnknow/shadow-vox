"""
ShadowVox V2 - Local Voice-Cloning API Server

V2 Upgrades:
  • Voicelab Effects — Walkie-Talkie, Demon, Echo audio filters
  • Voice-to-Voice — integrate Whisper-tiny STT → XTTS clone pipeline
  • Effect parameter in /clone endpoint

Usage:
  python tts_server.py
  # Server starts on http://127.0.0.1:8000
"""

import os
import re
import sys
import logging
import json
import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from TTS.api import TTS

# ── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("shadow-vox")

# ── Paths ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent  # project root
RECORDINGS_DIR = BASE_DIR / "recordings"
OUTPUT_DIR = BASE_DIR / "output"

RECORDINGS_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# ── App ────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="ShadowVox V2 TTS Engine",
    description="V2: Voice cloning + Voicelab effects + Voice-to-Voice pipeline",
    version="2.0.0",
)

# Lazy-load the model singleton
_model: TTS | None = None


def get_model() -> TTS:
    """Load and cache the XTTS-v2 model (first call downloads ~1.8 GB)."""
    global _model
    if _model is not None:
        return _model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("⏳ Loading XTTS-v2 model on '%s' ... (may take a minute)", device)

    _model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)

    log.info("✅ XTTS-v2 model ready on '%s'", device)
    return _model


# ── Whisper STT (lazy-load) ──────────────────────────────────────────────
_whisper_model = None


def get_whisper_model():
    """Load Whisper-tiny for Voice-to-Voice STT pipeline."""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    try:
        import whisper
        log.info("⏳ Loading Whisper-tiny model ...")
        _whisper_model = whisper.load_model("tiny")
        log.info("✅ Whisper-tiny loaded")
        return _whisper_model
    except ImportError:
        log.warning("⚠️  whisper not installed — V2V unavailable. pip install openai-whisper")
        return None


# ── Schemas ────────────────────────────────────────────────────────────────

class CloneRequest(BaseModel):
    text: str
    user_id: str
    language: str = "en"
    effect: str = "none"  # V2.2: 'none' | 'walkie-talkie' | 'demon' | 'echo'


class CloneResponse(BaseModel):
    status: str
    file: str
    duration_seconds: float | None = None
    effect_used: str = "none"


class V2VResponse(BaseModel):
    status: str
    transcribed_text: str
    cloned_file: str
    duration_seconds: float | None = None


# ── V2.2: Audio Effects Engine ────────────────────────────────────────────

def apply_effect(input_path: str, effect: str) -> str:
    """
    Apply an audio effect to the synthesized WAV file.
    Returns the path to the processed file.

    Effects:
      - 'walkie-talkie': Bandpass filter (300-3400Hz) + radio compression
      - 'demon': Pitch shift down 8 semitones + distortion
      - 'echo': Reverb with multiple delays
      - 'none': No processing
    """
    if effect == "none" or not effect:
        return input_path

    output_path = input_path.replace(".wav", f"_{effect}.wav")
    if output_path == input_path:
        output_path = str(Path(input_path).parent / f"{Path(input_path).stem}_{effect}.wav")

    try:
        ffmpeg = "ffmpeg"

        if effect == "walkie-talkie":
            # Bandpass filter: 300-3400Hz (narrow radio-like) + compression
            cmd = [
                ffmpeg, "-y", "-i", input_path,
                "-af", "highpass=f=300,lowpass=f=3400,compand=attacks=0.1:decays=0.1:points=-80/-80|-30/-10|-20/-20|0/0:gain=5",
                output_path,
            ]
        elif effect == "demon":
            # Pitch shift down by 8 semitones (rubberband) + slight distortion
            cmd = [
                ffmpeg, "-y", "-i", input_path,
                "-af", "asetrate=48000*0.667,aresample=48000,equalizer=f=100:t=q:w=1:g=5,acrusher=bits=8:mode=log:aa=1",
                output_path,
            ]
        elif effect == "echo":
            # Reverb with multiple delays and feedback
            cmd = [
                ffmpeg, "-y", "-i", input_path,
                "-af", "aecho=0.8:0.7:100|300|500:0.5|0.3|0.15,volume=1.5",
                output_path,
            ]
        else:
            return input_path

        result = subprocess.run(cmd, capture_output=True, timeout=30, text=True)
        if result.returncode == 0:
            log.info(f"   ✨ Applied effect '{effect}' → {output_path}")
            return output_path
        else:
            log.warning(f"   ⚠️  Effect '{effect}' failed: {result.stderr[:200]}")
            return input_path

    except FileNotFoundError:
        log.warning("   ⚠️  FFmpeg not found — effects disabled")
        return input_path
    except subprocess.TimeoutExpired:
        log.warning(f"   ⚠️  Effect '{effect}' timed out")
        return input_path


# ── V2.3: Voice-to-Voice Pipeline ────────────────────────────────────────

async def transcribe_audio(audio_path: str) -> str:
    """Transcribe audio to text using Whisper-tiny."""
    model = get_whisper_model()
    if model is None:
        raise HTTPException(status_code=503, detail="Whisper STT not available (install openai-whisper)")

    try:
        import whisper
        result = model.transcribe(audio_path, language="en")
        text = result.get("text", "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="No speech detected in audio")
        log.info(f"   📝 Transcribed: \"{text[:80]}...\"")
        return text
    except Exception as e:
        log.exception("Whisper transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


# ── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Health-check endpoint for the Node.js bot to poll."""
    model_loaded = _model is not None
    whisper_loaded = _whisper_model is not None
    return {
        "status": "ok" if model_loaded else "loading",
        "model_loaded": model_loaded,
        "whisper_loaded": whisper_loaded,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }


@app.post("/clone", response_model=CloneResponse)
def clone_voice(request: CloneRequest):
    """
    Clone a user's voice using their recorded reference audio and
    synthesise the provided text in that voice.
    V2.2: Supports optional 'effect' parameter.
    """
    # Security: sanitize user_id to prevent path traversal
    safe_id = re.sub(r'[^a-zA-Z0-9_@.\\-]', '', request.user_id)[:128]
    if not safe_id:
        raise HTTPException(status_code=400, detail="Invalid user_id")

    # Also check for a custom speaker_wav_path from the body
    speaker_wav_path_override = getattr(request, 'speaker_wav_path', None)
    if speaker_wav_path_override:
        speaker_wav = Path(str(speaker_wav_path_override)).resolve()
        # Ensure it's within the project directory
        if not str(speaker_wav).startswith(str(BASE_DIR.resolve())):
            raise HTTPException(status_code=400, detail="speaker_wav_path is outside allowed directory")
        if not speaker_wav.exists():
            raise HTTPException(status_code=404, detail=f"Speaker file not found: {speaker_wav}")
    else:
        speaker_wav = RECORDINGS_DIR / f"{safe_id}.wav"

    if not speaker_wav.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Reference recording not found for user '{safe_id}'. "
                   f"Please record their voice first.",
        )

    output_path = OUTPUT_DIR / f"{safe_id}_cloned.wav"

    try:
        model = get_model()

        log.info("🎙️  Cloning voice for user '%s' ...", request.user_id)

        model.tts_to_file(
            text=request.text,
            speaker_wav=str(speaker_wav),
            language=request.language,
            file_path=str(output_path),
        )

        # V2.2: Apply audio effect
        final_path = apply_effect(str(output_path), request.effect)

        duration = None
        if final_path and Path(final_path).exists():
            duration = round(Path(final_path).stat().st_size / 32000, 2)

        log.info("✅ Voice cloned → %s (est. %.1f s, effect=%s)",
                 Path(final_path).name, duration or 0, request.effect)

        return CloneResponse(
            status="success",
            file=final_path,
            duration_seconds=duration,
            effect_used=request.effect,
        )

    except Exception as exc:
        log.exception("❌ Voice cloning failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/voice-to-voice", response_model=V2VResponse)
async def voice_to_voice_endpoint(
    audio: UploadFile = File(...),
    source_user_id: str = Form(...),
    target_user_id: str = Form(...),
    language: str = Form("en"),
    effect: str = Form("none"),
):
    """
    V2.3: Voice-to-Voice Pipeline
    1. Accept uploaded audio file from the bot
    2. Transcribe with Whisper-tiny
    3. Clone using target user's voice profile
    4. Apply effect if specified
    5. Return the final audio file path
    """
    # Save uploaded audio
    audio_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            content = await audio.read()
            tmp.write(content)
            audio_path = tmp.name

        # Step 1: Transcribe
        log.info(f"🗣️  V2V: Transcribing audio from '{source_user_id}' ...")
        transcribed_text = await transcribe_audio(audio_path)

        # Step 2: Get target profile
        target_wav = RECORDINGS_DIR / f"{re.sub(r'[^a-zA-Z0-9_@.\\-]', '', target_user_id)[:128]}.wav"
        if not target_wav.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Target user '{target_user_id}' has no recorded voice profile",
            )

        # Step 3: Clone
        output_path = OUTPUT_DIR / f"v2v_{source_user_id}_to_{target_user_id}.wav"
        model = get_model()
        model.tts_to_file(
            text=transcribed_text,
            speaker_wav=str(target_wav),
            language=language,
            file_path=str(output_path),
        )

        # Step 4: Apply effect
        final_path = apply_effect(str(output_path), effect)

        duration = None
        if Path(final_path).exists():
            duration = round(Path(final_path).stat().st_size / 32000, 2)

        log.info(f"✅ V2V complete: \"{transcribed_text[:60]}...\" → {target_user_id}")

        return V2VResponse(
            status="success",
            transcribed_text=transcribed_text,
            cloned_file=final_path,
            duration_seconds=duration,
        )

    except Exception as exc:
        log.exception("❌ V2V pipeline failed")
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if audio_path and os.path.exists(audio_path):
            os.unlink(audio_path)


# ── Entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("TTS_PORT", "8000"))
    log.info("🚀 Starting ShadowVox V2 TTS server on port %d ...", port)
    uvicorn.run(
        "tts_server:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
    )
