#!/usr/bin/env bash
# ===========================================================================
# 🕐 ShadowVox Cron Installer
# ===========================================================================
# Installs or removes the nightly self-heal cron job into the user's crontab.
#
# Usage:
#   ./cron/install-cron.sh                    # Install with default schedule
#   ./cron/install-cron.sh --schedule "0 5 * * *"   # Custom schedule
#   ./cron/install-cron.sh --remove           # Remove the cron job
#   ./cron/install-cron.sh --status           # Check if installed
#   ./cron/install-cron.sh --test             # Test-run the cron script once
#
# Default schedule: runs daily at 3:00 AM server time.
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_SCRIPT="$SCRIPT_DIR/self-heal.sh"
CRON_LOG_DIR="$PROJECT_ROOT/logs/self-heal"
CRON_ID="# shadowvox-selfheal-cron"

# Colors
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

# Default schedule: daily at 3:00 AM server local time
DEFAULT_SCHEDULE="0 3 * * *"

# ── Helpers ─────────────────────────────────────────────────────────────────

print_banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  🕐 ShadowVox Cron Installer                                   ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
}

check_prerequisites() {
  local ok=true

  if [ ! -f "$CRON_SCRIPT" ]; then
    echo -e "  ${RED}✗${NC} Cron script not found at: $CRON_SCRIPT"
    ok=false
  fi

  if [ ! -x "$CRON_SCRIPT" ]; then
    echo -e "  ${YELLOW}⚠${NC} Making cron script executable..."
    chmod +x "$CRON_SCRIPT"
  fi

  if ! command -v crontab &>/dev/null; then
    echo -e "  ${RED}✗${NC} crontab command not found — install cron first:"
    echo "       sudo apt-get install cron   # Debian/Ubuntu"
    echo "       sudo yum install cronie     # RHEL/CentOS"
    ok=false
  fi

  if ! command -v bun &>/dev/null && ! command -v node &>/dev/null; then
    echo -e "  ${RED}✗${NC} Neither bun nor node found — install Node.js ≥ 18 or Bun"
    ok=false
  fi

  $ok
}

get_crontab() {
  crontab -l 2>/dev/null || true
}

job_line() {
  local schedule="${1:-$DEFAULT_SCHEDULE}"
  echo "$schedule cd $PROJECT_ROOT && $CRON_SCRIPT --fix >> $CRON_LOG_DIR/crontab-stdout.log 2>&1"
}

has_job() {
  get_crontab | grep -qF "$CRON_ID"
}

# ── Commands ────────────────────────────────────────────────────────────────

cmd_install() {
  local schedule="${1:-$DEFAULT_SCHEDULE}"

  echo "  📋 Schedule:  $schedule"
  echo "  📂 Project:   $PROJECT_ROOT"
  echo "  📜 Script:    $CRON_SCRIPT"
  echo ""

  # Ensure log directory exists
  mkdir -p "$CRON_LOG_DIR"

  if has_job; then
    echo -e "  ${YELLOW}⚠${NC} Cron job is already installed. Replacing..."
    cmd_remove
  fi

  local current_crontab
  current_crontab="$(get_crontab)"

  # Add the job
  local new_job
  new_job="$(job_line "$schedule")"

  {
    echo "$current_crontab"
    echo "$CRON_ID"
    echo "$new_job"
    echo "# end of shadowvox-selfheal"
  } | crontab -

  echo -e "  ${GREEN}✓${NC} Cron job installed successfully!"
  echo ""
  echo "  Run daily at: $(echo "$schedule" | awk '{print $2 ":" $1}' | sed 's/^0//') server time"
  echo "  To verify:     crontab -l | grep shadowvox-selfheal"
  echo "  Logs:          $CRON_LOG_DIR"
  echo "  Stdout:        $CRON_LOG_DIR/crontab-stdout.log"
  echo ""

  # Suggest running a test
  echo -e "  ${CYAN}💡${NC} Run a test:  ${BOLD}./cron/install-cron.sh --test${NC}"
}

cmd_remove() {
  if ! has_job; then
    echo -e "  ${YELLOW}⚠${NC} No ShadowVox cron job found — nothing to remove."
    return
  fi

  local current_crontab
  current_crontab="$(get_crontab)"

  # Filter out the cron job lines
  local filtered
  filtered="$(echo "$current_crontab" | grep -vF "$CRON_ID" | grep -vF "# end of shadowvox-selfheal" | grep -vF "$CRON_SCRIPT" || true)"

  echo "$filtered" | crontab -

  echo -e "  ${GREEN}✓${NC} Cron job removed successfully."
}

cmd_status() {
  echo "━━━ 🔍 Cron Job Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  if has_job; then
    echo -e "  ${GREEN}✓${NC} Self-heal cron job is INSTALLED"
    echo ""
    echo "  Current crontab entry:"
    get_crontab | grep -A2 "$CRON_ID" | while IFS= read -r line; do
      echo "    ${CYAN}$line${NC}"
    done
    echo ""
    echo "  Log directory: $CRON_LOG_DIR"
    echo ""

    # Show recent runs
    local latest_log
    latest_log="$CRON_LOG_DIR/latest.log"
    if [ -f "$latest_log" ]; then
      local latest_time
      latest_time="$(stat -c '%Y' "$latest_log" 2>/dev/null || echo '0')"
      local now
      now="$(date +%s)"
      local age=$(( (now - latest_time) / 3600 ))
      echo "  🕐 Last run: $(stat -c '%y' "$latest_log" 2>/dev/null | cut -d'.' -f1) ($(( age ))h ago)"
    else
      echo "  🕐 No runs recorded yet"
    fi
  else
    echo -e "  ${YELLOW}⚠${NC} Self-heal cron job is NOT installed"
    echo ""
    echo "  Install with: ${BOLD}./cron/install-cron.sh${NC}"
  fi
}

cmd_test() {
  echo "━━━ 🧪 Test Run ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo -e "  ${YELLOW}⚠${NC} Running the self-heal script once (this may take a moment)..."
  echo ""

  if [ ! -x "$CRON_SCRIPT" ]; then
    chmod +x "$CRON_SCRIPT"
  fi

  bash "$CRON_SCRIPT" --diagnose
  local exit_code=$?

  echo ""
  if [ "$exit_code" -eq 0 ]; then
    echo -e "  ${GREEN}✓${NC} Test run completed successfully (exit code: $exit_code)"
  else
    echo -e "  ${YELLOW}⚠${NC} Test run completed with warnings (exit code: $exit_code)"
  fi
  echo "  Check the log file for full output."
  echo ""

  return "$exit_code"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  print_banner

  if ! check_prerequisites; then
    echo ""
    echo -e "  ${RED}[!] Prerequisites not met — aborting.${NC}"
    exit 1
  fi

  case "${1:-}" in
    --remove|-r)
      cmd_remove
      ;;
    --status|-s)
      cmd_status
      ;;
    --test|-t)
      cmd_test
      ;;
    --schedule)
      if [ -z "${2:-}" ]; then
        echo -e "  ${RED}[!] --schedule requires a cron expression argument${NC}"
        echo "  Example: ./cron/install-cron.sh --schedule \"30 4 * * *\""
        exit 1
      fi
      cmd_install "$2"
      ;;
    *)
      cmd_install
      ;;
  esac
}

main "$@"
