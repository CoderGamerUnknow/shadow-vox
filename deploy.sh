#!/usr/bin/env bash
# ===========================================================================
# ShadowVox V2 — Production Deployment Script
# ===========================================================================
# Deploys the complete voice-cloning stack on a fresh Ubuntu 22.04 / Debian
# server. Supports both bare-metal and Docker-based deployment.
#
# Usage:
#   # Quick Docker deploy (recommended)
#   bash deploy.sh --docker
#
#   # Bare-metal deploy (requires manual Python venv setup)
#   bash deploy.sh --bare
#
#   # GPU accelerated (NVIDIA CUDA)
#   bash deploy.sh --docker --gpu
#
# Prerequisites:
#   - Ubuntu 22.04+ or Debian 12+
#   - At least 8GB RAM (16GB recommended with GPU)
#   - At least 20GB free disk space
#   - Docker (for --docker mode) or Python 3.11 + Node.js 18 (for --bare)
#   - NVIDIA GPU + drivers (for --gpu mode, optional but recommended)
# ===========================================================================

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/tmp/shadowvox-deploy-$(date +%Y%m%d-%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Helpers ────────────────────────────────────────────────────────────────
log()  { echo -e "  ${GREEN}✓${NC} $1"; echo "[$(date +%H:%M:%S)] $1" >> "$LOG_FILE"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; echo "[WARN] $1" >> "$LOG_FILE"; }
err()  { echo -e "  ${RED}✗${NC} $1"; echo "[ERR] $1" >> "$LOG_FILE"; }

print_banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║   🎤 ShadowVox V2 — Production Deploy Script                   ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  Log file: $LOG_FILE"
  echo ""
}

# ── Pre-flight Checks ──────────────────────────────────────────────────────
preflight() {
  echo "━━━ 🔍 Pre-flight Checks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # OS check
  if [ ! -f /etc/os-release ]; then
    err "Cannot detect OS. Ubuntu/Debian required."
    exit 1
  fi
  source /etc/os-release
  log "OS: $NAME $VERSION_ID"

  # Check disk space (need at least 10GB for models)
  local avail_kb
  avail_kb="$(df -k "$SCRIPT_DIR" | awk 'NR==2 {print $4}')"
  local avail_gb=$(( avail_kb / 1024 / 1024 ))
  if [ "$avail_gb" -lt 10 ]; then
    err "Only ${avail_gb}GB free. Need at least 10GB (XTTS model ~1.8GB + Whisper ~1GB)"
    exit 1
  fi
  log "Disk: ${avail_gb}GB available"

  # Check RAM
  local total_ram
  total_ram="$(free -m | awk '/^Mem:/{print $2}')"
  if [ "$total_ram" -lt 8000 ]; then
    warn "${total_ram}MB RAM — XTTS needs at least 8GB. GPU mode is strongly recommended."
  else
    log "RAM: ${total_ram}MB"
  fi

  echo ""
}

# ── Docker Mode ────────────────────────────────────────────────────────────
deploy_docker() {
  echo "━━━ 🐳 Docker Deployment ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Install Docker if not present
  if ! command -v docker &>/dev/null; then
    echo "  Installing Docker..."
    curl -fsSL https://get.docker.com | bash 2>&1 >> "$LOG_FILE"
    log "Docker installed"
  else
    log "Docker $(docker --version)"
  fi

  # Install Docker Compose plugin
  if ! docker compose version &>/dev/null; then
    warn "Docker Compose plugin not found — installing..."
    DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
    mkdir -p "$DOCKER_CONFIG/cli-plugins"
    curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
      -o "$DOCKER_CONFIG/cli-plugins/docker-compose"
    chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"
    log "Docker Compose installed"
  fi

  # GPU support
  if [ "${GPU_MODE:-false}" = true ]; then
    echo "  Setting up NVIDIA CUDA support..."
    if ! command -v nvidia-smi &>/dev/null; then
      warn "nvidia-smi not found. Installing NVIDIA Container Toolkit..."
      distribution="$(. /etc/os-release; echo "$ID$VERSION_ID")"
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
      curl -sL "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list" | \
        sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \
        sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
      sudo apt-get update -qq && sudo apt-get install -y -qq nvidia-container-toolkit
      sudo nvidia-ctk runtime configure --runtime=docker
      sudo systemctl restart docker
      log "NVIDIA Container Toolkit installed"
    else
      log "NVIDIA GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
    fi
  fi

  # Ensure .env file exists
  if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo ""
    warn "No .env file found. Creating from .env.example..."
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo ""
    echo -e "  ${CYAN}📝 Edit .env and set your DISCORD_BOT_TOKEN:${NC}"
    echo "    nano $SCRIPT_DIR/.env"
    echo ""
    read -rp "  Press Enter after editing .env (or Ctrl+C to abort)... "
  fi

  # Generate presets if they don't exist
  if [ -z "$(ls -A "$SCRIPT_DIR/presets/"*.wav 2>/dev/null)" ]; then
    echo "  Generating voice presets..."
    pip3 install gTTS -q 2>&1 >> "$LOG_FILE" || true
    python3 "$SCRIPT_DIR/python/generate_presets.py" 2>&1 >> "$LOG_FILE" || warn "Preset generation had issues"
  fi

  # Build and start
  echo "  Building Docker images (this may take a few minutes)..."
  docker compose build 2>&1 | tail -5 >> "$LOG_FILE"
  
  echo "  Starting services..."
  docker compose up -d 2>&1 >> "$LOG_FILE"

  echo ""
  echo "━━━ 📊 Deploy Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  docker compose ps
  echo ""

  log "Deployment complete!"
  echo ""
  echo "  📡 TTS Engine:    http://localhost:8000/health"
  echo "  🌐 Admin Panel:   http://localhost:3000"
  echo "  💬 Bot:           Invite to Discord and use !join"
  echo ""
  echo "  📋 Logs:"
  echo "    docker compose logs -f tts-engine   # TTS server logs"
  echo "    docker compose logs -f bot           # Bot logs"
  echo ""
}

# ── Bare-metal Mode ────────────────────────────────────────────────────────
deploy_bare() {
  echo "━━━ 🖥️  Bare-Metal Deployment ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Prerequisites
  echo "  Installing system dependencies..."
  sudo apt-get update -qq 2>&1 >> "$LOG_FILE"
  sudo apt-get install -y -qq ffmpeg build-essential python3-pip python3-venv curl git 2>&1 >> "$LOG_FILE"
  log "System deps installed (ffmpeg, build tools)"

  # Node.js / Bun
  if ! command -v bun &>/dev/null; then
    echo "  Installing Bun..."
    curl -fsSL https://bun.sh/install | bash 2>&1 >> "$LOG_FILE"
    export PATH="$HOME/.bun/bin:$PATH"
    log "Bun $(bun --version) installed"
  else
    log "Bun $(bun --version)"
  fi

  # Python virtual environment
  if [ ! -d "$SCRIPT_DIR/.venv" ]; then
    echo "  Creating Python virtual environment..."
    python3 -m venv "$SCRIPT_DIR/.venv"
    log "Python venv created"
  fi
  source "$SCRIPT_DIR/.venv/bin/activate"

  # Install Python deps
  echo "  Installing Python packages (XTTS-v2, FastAPI, uvicorn)..."
  pip install -r "$SCRIPT_DIR/python/requirements.txt" --quiet 2>&1 >> "$LOG_FILE"
  log "Python packages installed"

  # Install Whisper for V2.3 (optional)
  echo "  Installing Whisper for Voice-to-Voice (V2.3)..."
  pip install openai-whisper --quiet 2>&1 >> "$LOG_FILE" || warn "Whisper install had issues — V2V will be unavailable"
  log "Whisper installed"

  # Install Node deps
  echo "  Installing Node.js dependencies..."
  cd "$SCRIPT_DIR" && bun install --frozen-lockfile 2>&1 >> "$LOG_FILE"
  log "Node deps installed"

  # Generate presets
  if [ -z "$(ls -A "$SCRIPT_DIR/presets/"*.wav 2>/dev/null)" ]; then
    echo "  Generating voice presets..."
    pip install gTTS -q 2>&1 >> "$LOG_FILE" || true
    python3 "$SCRIPT_DIR/python/generate_presets.py" 2>&1 >> "$LOG_FILE" || warn "Preset generation had issues"
  fi

  # Ensure .env
  if [ ! -f "$SCRIPT_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    warn ".env created from template — edit it with your DISCORD_BOT_TOKEN"
    echo ""
    echo "  nano $SCRIPT_DIR/.env"
    echo ""
    read -rp "  Press Enter after editing .env (or Ctrl+C)... "
  fi

  # Setup cron job
  echo "  Installing self-heal cron job..."
  bash "$SCRIPT_DIR/cron/install-cron.sh" 2>&1 >> "$LOG_FILE" || warn "Cron install had issues"
  log "Cron job installed"

  # Create systemd service
  echo "  Creating systemd service..."
  sudo tee /etc/systemd/system/shadowvox.service > /dev/null <<SERVICE
[Unit]
Description=ShadowVox V2 Voice Cloning Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
Environment=PATH=$SCRIPT_DIR/.venv/bin:/usr/local/bin:/usr/bin
ExecStartPre=$SCRIPT_DIR/.venv/bin/python $SCRIPT_DIR/python/tts_server.py &
ExecStart=$HOME/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=10
StandardOutput=append:$SCRIPT_DIR/logs/bot.log
StandardError=append:$SCRIPT_DIR/logs/bot-error.log

[Install]
WantedBy=multi-user.target
SERVICE
  log "systemd service created"

  # Start services
  echo "  Starting services..."
  sudo systemctl daemon-reload
  # Start Python TTS server
  cd "$SCRIPT_DIR"
  source "$SCRIPT_DIR/.venv/bin/activate"
  nohup python3 python/tts_server.py > "$SCRIPT_DIR/logs/tts.log" 2>&1 &
  log "TTS server started (PID $!)"

  # Wait for TTS
  echo "  Waiting for TTS server to load model..."
  for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
      log "TTS server ready"
      break
    fi
    sleep 2
  done

  # Start bot
  sudo systemctl enable shadowvox 2>&1 >> "$LOG_FILE" || true
  sudo systemctl start shadowvox 2>&1 >> "$LOG_FILE" || warn "systemd start had issues — starting manually"
  if ! sudo systemctl is-active --quiet shadowvox; then
    nohup bun run src/index.ts > "$SCRIPT_DIR/logs/bot.log" 2>&1 &
    log "Bot started manually (PID $!)"
  fi

  log "Deployment complete!"
  echo ""
  echo "  📡 TTS Engine:    http://localhost:8000/health"
  echo "  🌐 Admin Panel:   http://localhost:3000"
  echo "  📋 Bot Logs:      tail -f $SCRIPT_DIR/logs/bot.log"
  echo "  📋 TTS Logs:      tail -f $SCRIPT_DIR/logs/tts.log"
  echo "  🔄 Self-heal:     Daily at 3AM (server time)"
  echo ""
  echo "  💡 Commands:"
  echo "    sudo systemctl status shadowvox    # Check bot status"
  echo "    sudo systemctl restart shadowvox   # Restart bot"
  echo "    ./cron/install-cron.sh --test      # Test self-heal"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
print_banner
preflight

MODE="${1:---docker}"
GPU_MODE=false

for arg in "$@"; do
  case "$arg" in
    --gpu|--cuda) GPU_MODE=true ;;
    --bare|--bare-metal) MODE="--bare" ;;
    --docker) MODE="--docker" ;;
    --help|-h)
      echo "Usage: bash deploy.sh [--docker|--bare] [--gpu]"
      echo ""
      echo "  --docker    Deploy using Docker Compose (default, recommended)"
      echo "  --bare      Deploy directly on the server (no Docker)"
      echo "  --gpu       Enable NVIDIA CUDA GPU acceleration"
      exit 0
      ;;
  esac
done

if [ "$MODE" = "--docker" ]; then
  deploy_docker
else
  deploy_bare
fi

echo ""
echo "  🎤 ShadowVox V2 deployed successfully!"
echo "  Visit the admin panel: http://localhost:3000"
echo "  Or use the bot in Discord: !join"
echo ""
