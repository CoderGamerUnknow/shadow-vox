#!/usr/bin/env bash
# ===========================================================================
# ⚕️  ShadowVox Self-Heal Cron Script
# ===========================================================================
# Runs the self-heal engine with --fix mode on the production server.
# Designed to be scheduled via crontab (recommended: daily at 3 AM).
#
# Usage:
#   ./cron/self-heal.sh                    # Full run with --fix
#   ./cron/self-heal.sh --diagnose         # Read-only diagnostic (no fixes)
#   ./cron/self-heal.sh --upgrade          # Fix + code upgrades
#
# What it does:
#   1. Acquires a lockfile (prevents overlapping runs)
#   2. Changes to the project root directory
#   3. Runs the self-heal engine with appropriate flags
#   4. Captures output, exit code, and timing
#   5. Trims old logs (keeps last 30 days)
#   6. Sends a notification if critical issues are found
#   7. Exits with 0 on success, 1+ on failure
# ===========================================================================

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCKFILE="/tmp/shadowvox-selfheal.lock"
LOG_DIR="$PROJECT_ROOT/logs/self-heal"
LOG_FILE="$LOG_DIR/self-heal-$(date +%Y-%m-%d-%H%M%S).log"
LAST_LOG_LINK="$LOG_DIR/latest.log"
MODE="${1:---fix}"
MAX_LOG_AGE_DAYS=30
NOTIFY_THRESHOLD_ERRORS=1        # Notify if any errors found
NOTIFY_THRESHOLD_WARNINGS=20     # Notify if this many warnings

# Color output (disabled when not in terminal)
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

# ── Lockfile (prevent concurrent runs) ──────────────────────────────────────

ensure_lock() {
  if [ -f "$LOCKFILE" ]; then
    local pid
    pid="$(cat "$LOCKFILE" 2>/dev/null || echo '')"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo -e "${RED}[!] Lockfile held by PID $pid — self-heal is already running. Exiting.${NC}" >&2
      echo "[!] Lockfile held by PID $pid — self-heal is already running. Exiting." >&2
      exit 1
    fi
    echo -e "${YELLOW}[!] Stale lockfile found (PID $pid not running). Removing.${NC}" >&2
    echo "[!] Stale lockfile found (PID $pid not running). Removing." >&2
    rm -f "$LOCKFILE"
  fi
  echo "$$" > "$LOCKFILE"
  trap 'rm -f "$LOCKFILE"' EXIT
}

# ── Logging ─────────────────────────────────────────────────────────────────

init_logging() {
  mkdir -p "$LOG_DIR"
  # Remove old logs
  find "$LOG_DIR" -name 'self-heal-*.log' -mtime "+$MAX_LOG_AGE_DAYS" -delete 2>/dev/null || true

  # Tee output to both stdout/stderr AND the log file
  exec > >(tee -a "$LOG_FILE") 2>&1
  ln -sf "$LOG_FILE" "$LAST_LOG_LINK"

  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  ⚕️  ShadowVox Self-Heal Cron Job                              ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  📅  Started:     $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "  📂  Project:     $PROJECT_ROOT"
  echo "  🔧  Mode:        $MODE"
  echo "  📝  Log:         $LOG_FILE"
  echo ""
}

# ── Pre-flight Checks ───────────────────────────────────────────────────────

preflight_checks() {
  echo "━━━ 🔍 Pre-flight Checks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Change to project root
  cd "$PROJECT_ROOT"

  # 1. Check that Node/Bun is available
  if command -v bun &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} bun $(bun --version)"
  elif command -v node &>/dev/null; then
    echo -e "  ${YELLOW}⚠${NC} Node.js $(node --version) (bun preferred — falling back)"
    BUN_CMD="npx tsx"
  else
    echo -e "  ${RED}✗${NC} No JavaScript runtime found (need bun or node)"
    return 1
  fi
  local BUN_CMD="${BUN_CMD:-bunx tsx}"

  # 2. Check that the self-heal script exists
  if [ ! -f "$PROJECT_ROOT/src/self-heal.ts" ]; then
    echo -e "  ${RED}✗${NC} src/self-heal.ts not found!"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} Self-heal engine found"

  # 3. Check that node_modules exists
  if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo -e "  ${YELLOW}⚠${NC} node_modules/ not found — running bun install"
    bun install 2>&1
  fi
  echo -e "  ${GREEN}✓${NC} Dependencies installed"

  # 4. Check disk space
  local avail_kb
  avail_kb="$(df -k "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
  if [ "$avail_kb" -lt 1048576 ]; then
    echo -e "  ${YELLOW}⚠${NC} Low disk space: $(( avail_kb / 1024 )) MB remaining"
  else
    echo -e "  ${GREEN}✓${NC} Disk space: $(( avail_kb / 1024 )) MB available"
  fi

  # 5. Check Python if the TTS server might be needed during upgrades
  if command -v python3 &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
  fi

  echo ""
}

# ── Run Self-Heal ───────────────────────────────────────────────────────────

run_self_heal() {
  echo "━━━ ⚕️  Running Self-Heal ($MODE) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local start_time
  start_time="$(date +%s)"

  cd "$PROJECT_ROOT"

  # Run the self-heal engine
  if [ "$MODE" = "--diagnose" ]; then
    bunx tsx src/self-heal.ts 2>&1
    local exit_code=$?
  elif [ "$MODE" = "--upgrade" ]; then
    bunx tsx src/self-heal.ts --fix --upgrade 2>&1
    local exit_code=$?
  else
    bunx tsx src/self-heal.ts --fix 2>&1
    local exit_code=$?
  fi

  local end_time
  end_time="$(date +%s)"
  local elapsed=$(( end_time - start_time ))

  echo ""
  echo "━━━ 📊 Run Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  ⏱️  Duration:   ${elapsed}s"
  echo "  🔚 Exit code:  $exit_code"
  echo ""

  return $exit_code
}

# ── Post-Run: Check for Critical Issues ─────────────────────────────────────

post_run_check() {
  local exit_code=$1

  echo "━━━ 📋 Post-Run Analysis ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # If --ci was run, read the report JSON
  local report_file="$PROJECT_ROOT/self-heal-report.json"
  if [ -f "$report_file" ]; then
    local errors
    local warnings
    local type_errors
    errors="$(jq -r '.summary.errors // 0' "$report_file" 2>/dev/null || echo '0')"
    warnings="$(jq -r '.summary.warnings // 0' "$report_file" 2>/dev/null || echo '0')"
    type_errors="$(jq -r '.typeErrors // 0' "$report_file" 2>/dev/null || echo '0')"
    test_failures="$(jq -r '.testFailures // 0' "$report_file" 2>/dev/null || echo '0')"
    auto_fixed="$(jq -r '.summary.autoFixed // 0' "$report_file" 2>/dev/null || echo '0')"

    echo "  ❌ Errors:          $errors"
    echo "  ⚠️  Warnings:       $warnings"
    echo "  ℹ️  TypeScript errs: $type_errors"
    echo "  ℹ️  Test failures:   $test_failures"
    echo "  🛠️  Auto-fixed:      $auto_fixed"

    # Decide if notification is needed
    local should_notify=false
    if [ "$errors" -ge "$NOTIFY_THRESHOLD_ERRORS" ]; then
      should_notify=true
    fi
    if [ "$warnings" -ge "$NOTIFY_THRESHOLD_WARNINGS" ]; then
      should_notify=true
    fi

    if $should_notify && [ "$exit_code" -ne 0 ]; then
      echo ""
      echo -e "  ${RED}⚠️  CRITICAL: $errors error(s), $warnings warning(s) found!${NC}"
      echo "  ⚠️  Check the log file for details:"
      echo "      $LOG_FILE"
    fi

    # Move the report to logs for record-keeping
    local report_dest="$LOG_DIR/report-$(date +%Y-%m-%d-%H%M%S).json"
    cp "$report_file" "$report_dest"
    ln -sf "$report_dest" "$LOG_DIR/latest-report.json"
    echo ""
    echo "  📄 Report archived: $report_dest"

    # Remove the report from project root
    rm -f "$report_file"
  else
    echo "  ℹ️  No CI report file found (running without --ci output)"
  fi
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "━━━ 🧹 Cleanup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  # Remove old reports (keep last 60 days)
  find "$LOG_DIR" -name 'report-*.json' -mtime "+$MAX_LOG_AGE_DAYS" -delete 2>/dev/null || true
  echo "  🗑️  Old reports cleaned (retention: ${MAX_LOG_AGE_DAYS}d)"
  echo ""

  # Final log line
  local final_exit=$1
  if [ "$final_exit" -eq 0 ]; then
    echo -e "${GREEN}✅ Self-heal cron job completed successfully.${NC}"
    echo "✅ Self-heal cron job completed successfully."
  else
    echo -e "${RED}❌ Self-heal cron job completed with exit code $final_exit.${NC}"
    echo "❌ Self-heal cron job completed with exit code $final_exit."
  fi
  echo ""
  echo "  📝 Log: $LOG_FILE"
  echo "  ────────────────────────────────────────────────────────"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  ensure_lock
  init_logging

  if ! preflight_checks; then
    echo -e "${RED}[!] Pre-flight checks failed — aborting.${NC}"
    echo "[!] Pre-flight checks failed — aborting."
    cleanup 1
    exit 1
  fi

  set +e  # Allow non-zero exit from self-heal
  run_self_heal
  local exit_code=$?
  set -e

  post_run_check "$exit_code"
  cleanup "$exit_code"
  exit "$exit_code"
}

main
