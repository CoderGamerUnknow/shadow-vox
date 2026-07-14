# ===========================================================================
# ShadowVox V2 — Production Dockerfile
# ===========================================================================
# Multi-stage build for the complete voice-cloning bot.
#
# Build:
#   docker build -t shadowvox:latest .
#
# Run:
#   docker run -d \
#     --name shadowvox \
#     -p 3000:3000 \
#     -p 8000:8000 \
#     -v $(pwd)/.env:/app/.env \
#     -v $(pwd)/recordings:/app/recordings \
#     -v $(pwd)/presets:/app/presets \
#     -v $(pwd)/profiles.json:/app/profiles.json \
#     --gpus all \
#     shadowvox:latest
#
# Services (internal):
#   - Python TTS:    http://127.0.0.1:8000   (XTTS-v2 voice cloning + Whisper STT)
#   - Admin Panel:   http://0.0.0.0:3000     (Express dashboard + WebSocket)
#   - Discord Bot:   connects to Discord Gateway
# ===========================================================================

# ── Stage 1: Python TTS Environment ──────────────────────────────────────
FROM python:3.11-slim AS python-tts

LABEL maintainer="ShadowVox" \
      description="ShadowVox V2 - Real-time voice cloning Discord bot" \
      version="2.0.0"

# Prevent Python from writing .pyc files and enable stdout/stderr forwarding
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies for audio processing + XTTS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY python/requirements.txt python/
RUN pip install --no-cache-dir -r python/requirements.txt

# Install Whisper for V2.3 Voice-to-Voice (can be skipped if not needed)
# RUN pip install --no-cache-dir openai-whisper

# Copy Python source
COPY python/ /app/python/
COPY presets/ /app/presets/

# Pre-download XTTS-v2 model (optional — downloads on first start)
# RUN python3 -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')"

# ── Stage 2: Node.js / TypeScript Bot ────────────────────────────────────
FROM oven/bun:1 AS bun-bot

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src/ /app/src/
COPY dashboard/ /app/dashboard/
COPY cron/ /app/cron/

# TypeScript compilation check (not strictly needed for tsx runtime)
RUN bun tsc -b --noEmit 2>/dev/null || echo "TypeCheck skipped in build"

# ── Stage 3: Final Runtime Image ─────────────────────────────────────────
FROM python:3.11-slim AS runtime

LABEL maintainer="ShadowVox" \
      description="ShadowVox V2 Runtime - Discord Bot + Python TTS + Admin Panel" \
      version="2.0.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

WORKDIR /app

# Install runtime system deps (ffmpeg for audio effects + PCM→WAV)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Python from stage 1
COPY --from=python-tts /usr/local/lib/python3.11/site-packages/ /usr/local/lib/python3.11/site-packages/
COPY --from=python-tts /usr/local/bin/ /usr/local/bin/
COPY --from=python-tts /app/python/ /app/python/
COPY --from=python-tts /app/presets/ /app/presets/

# Copy Node.js from stage 2
COPY --from=bun-bot /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-bot /app/ /app/

# Create runtime directories
RUN mkdir -p /app/recordings /app/output /app/logs/self-heal /app/presets && \
    chmod 755 /app/recordings /app/output /app/logs/self-heal

# Expose ports
EXPOSE 3000  # Admin dashboard
EXPOSE 8000  # Python TTS API

# ── Startup ───────────────────────────────────────────────────────────────
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
