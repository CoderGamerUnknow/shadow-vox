"""
ShadowVox - Local Voice-Cloning API Server

A FastAPI server that loads XTTS-v2 and exposes a /clone endpoint
for real-time voice cloning. Accepts a reference .wav file and text,
returns synthesized speech in the cloned voice.
"""

import os
import sys
import logging
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
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
    title="ShadowVox TTS Engine",
    description="Real-time voice cloning API using XTTS-v2",
    version="1.0.0",
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


# ── Schemas ────────────────────────────────────────────────────────────────

class CloneRequest(BaseModel):
    text: str
    user_id: str
    language: str = "en"


class CloneResponse(BaseModel):
    status: str
    file: str
    duration_seconds: float | None = None


# ── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Health-check endpoint for the Node.js bot to poll."""
    model_loaded = _model is not None
    return {
        "status": "ok" if model_loaded else "loading",
        "model_loaded": model_loaded,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }


@app.post("/clone", response_model=CloneResponse)
def clone_voice(request: CloneRequest):
    """
    Clone a user's voice using their recorded reference audio and
    synthesise the provided text in that voice.
    """
    speaker_wav = RECORDINGS_DIR / f"{request.user_id}.wav"

    if not speaker_wav.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Reference recording not found for user '{request.user_id}'. "
                   f"Please record their voice first.",
        )

    output_path = OUTPUT_DIR / f"{request.user_id}_cloned.wav"

    try:
        model = get_model()

        log.info("🎙️  Cloning voice for user '%s' ...", request.user_id)

        model.tts_to_file(
            text=request.text,
            speaker_wav=str(speaker_wav),
            language=request.language,
            file_path=str(output_path),
        )

        duration = None
        if output_path.exists():
            duration = round(output_path.stat().st_size / 32000, 2)  # rough est.

        log.info("✅ Voice cloned → %s (est. %.1f s)", output_path.name, duration or 0)

        return CloneResponse(
            status="success",
            file=str(output_path),
            duration_seconds=duration,
        )

    except Exception as exc:
        log.exception("❌ Voice cloning failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("TTS_PORT", "8000"))
    log.info("🚀 Starting ShadowVox TTS server on port %d ...", port)
    uvicorn.run(
        "tts_server:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
    )
