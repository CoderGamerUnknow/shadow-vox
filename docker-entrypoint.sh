#!/bin/bash
# ===========================================================================
# ShadowVox V2 — Docker Entrypoint
# ===========================================================================
# Handles startup sequencing, directory creation, and graceful shutdown.
# Runs both the Python TTS server and the Node.js bot in the same container,
# or can run just one service if you're using docker-compose.
# ===========================================================================

set -e

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║   🎤 ShadowVox V2 — Starting Production Services                ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── Create required directories ──────────────────────────────────────────
mkdir -p /app/recordings /app/output /app/logs/self-heal
echo "✅ Runtime directories created"

# ── Validate environment ──────────────────────────────────────────────────
if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "⚠️  DISCORD_BOT_TOKEN is not set. Bot will not connect to Discord."
  echo "   Set it in your .env file or pass it as -e DISCORD_BOT_TOKEN=xxx"
  echo ""
fi

# ── Start Python TTS Server ───────────────────────────────────────────────
echo "🚀 Starting Python TTS engine (XTTS-v2 + Whisper STT)..."
cd /app
python3 python/tts_server.py &
TTS_PID=$!
echo "   TTS server PID: $TTS_PID"
echo "   Listening on http://127.0.0.1:8000"

# Wait for TTS server to be ready
echo "⏳ Waiting for TTS server to be ready..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "✅ TTS server is ready"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "⚠️  TTS server is taking longer than expected to load the model..."
    echo "   This is normal on first start (XTTS-v2 downloads ~1.8GB)"
  fi
  sleep 2
done
echo ""

# ── Start Discord Bot + Admin Panel ───────────────────────────────────────
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  echo "🚀 Starting ShadowVox Discord Bot..."
  cd /app
  bun run src/index.ts &
  BOT_PID=$!
  echo "   Bot PID: $BOT_PID"
  echo "   Admin panel: http://localhost:${ADMIN_PORT:-3000}"
else
  echo "⏸️  Discord bot not started (DISCORD_BOT_TOKEN not set)"
  echo "   Admin panel still available at http://localhost:${ADMIN_PORT:-3000}"
  # Start just the admin server standalone for dashboard testing
  cd /app
  ADMIN_PORT=${ADMIN_PORT:-3000} bunx tsx -e "
    import { startAdminServer } from './src/admin-server.js';
    startAdminServer(${ADMIN_PORT:-3000}, {
      client: { user: { tag: 'ShadowVox' }, isReady: () => true, guilds: { cache: { size: 0 } }, channels: { cache: { get: () => null } } },
      activeConnection: null,
      setActiveConnection: () => {},
      vadDetector: null,
      setVadDetector: () => {},
      defaultCloneText: 'Hello from ShadowVox V2!',
      setDefaultCloneText: () => {},
      startVad: () => {},
      stopVad: () => {},
      activePreset: null,
    } as any);
  " &
  BOT_PID=$!
fi

# ── Graceful Shutdown ──────────────────────────────────────────────────────
shutdown() {
  echo ""
  echo "⏹️  Shutting down services..."
  if [ -n "$BOT_PID" ]; then
    kill -TERM "$BOT_PID" 2>/dev/null && echo "   Bot stopped"
  fi
  if [ -n "$TTS_PID" ]; then
    kill -TERM "$TTS_PID" 2>/dev/null && echo "   TTS server stopped"
  fi
  echo "✅ All services stopped"
  exit 0
}

trap shutdown SIGTERM SIGINT

# ── Wait for any process to exit ──────────────────────────────────────────
echo ""
echo "✅ All services started. Waiting for signals..."
echo "───────────────────────────────────────────────────────────"
wait
