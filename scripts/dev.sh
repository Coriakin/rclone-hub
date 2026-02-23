#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

DOTENV_FILE="${DOTENV_FILE:-$ROOT_DIR/.env}"

load_dotenv() {
  local env_file="$1"
  if [ ! -f "$env_file" ]; then
    return 0
  fi

  # Preserve explicit shell-provided overrides for these keys.
  local shell_backend_host="${BACKEND_HOST-}"
  local shell_frontend_host="${FRONTEND_HOST-}"
  local shell_backend_port="${BACKEND_PORT-}"
  local shell_frontend_port="${FRONTEND_PORT-}"
  local had_backend_host="${BACKEND_HOST+x}"
  local had_frontend_host="${FRONTEND_HOST+x}"
  local had_backend_port="${BACKEND_PORT+x}"
  local had_frontend_port="${FRONTEND_PORT+x}"

  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a

  if [ -n "$had_backend_host" ]; then BACKEND_HOST="$shell_backend_host"; fi
  if [ -n "$had_frontend_host" ]; then FRONTEND_HOST="$shell_frontend_host"; fi
  if [ -n "$had_backend_port" ]; then BACKEND_PORT="$shell_backend_port"; fi
  if [ -n "$had_frontend_port" ]; then FRONTEND_PORT="$shell_frontend_port"; fi
}

load_dotenv "$DOTENV_FILE"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
BACKEND_PORT_CONFIGURED="${BACKEND_PORT-}"
FRONTEND_PORT_CONFIGURED="${FRONTEND_PORT-}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
MAX_PORT_TRIES=30

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

find_free_port() {
  local start_port="$1"
  local tries=0
  local port="$start_port"
  while [ "$tries" -lt "$MAX_PORT_TRIES" ]; do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
    tries=$((tries + 1))
  done
  return 1
}

ensure_backend_env() {
  if [ ! -d "$BACKEND_DIR/.venv" ]; then
    echo "[dev] Creating backend virtualenv..."
    (
      cd "$BACKEND_DIR"
      python3 -m venv .venv
    )
  fi

  if [ ! -x "$BACKEND_DIR/.venv/bin/uvicorn" ]; then
    echo "[dev] Installing backend dependencies..."
    (
      cd "$BACKEND_DIR"
      source .venv/bin/activate
      python -m pip install --upgrade "pip>=23.2" "setuptools>=68" "wheel>=0.41"
      python -m pip install -e '.[dev]'
    )
  fi
}

ensure_frontend_env() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "[dev] Installing frontend dependencies..."
    (
      cd "$FRONTEND_DIR"
      npm install
    )
  fi
}

cleanup() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo ""
    echo "[dev] Stopping backend (pid=$BACKEND_PID)..."
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

ensure_backend_env
ensure_frontend_env

FREE_BACKEND_PORT="$BACKEND_PORT"
FREE_FRONTEND_PORT="$FRONTEND_PORT"

if port_in_use "$BACKEND_PORT"; then
  if [ -n "$BACKEND_PORT_CONFIGURED" ]; then
    echo "[dev] BACKEND_PORT is set to $BACKEND_PORT but that port is already in use."
    echo "[dev] Stop the existing process or choose a different BACKEND_PORT in .env."
    exit 1
  fi
  FREE_BACKEND_PORT="$(find_free_port "$BACKEND_PORT")" || {
    echo "[dev] Could not find free backend port starting at $BACKEND_PORT"
    exit 1
  }
  if [ "$FREE_BACKEND_PORT" != "$BACKEND_PORT" ]; then
    echo "[dev] Backend port $BACKEND_PORT in use, using $FREE_BACKEND_PORT"
  fi
fi

if port_in_use "$FRONTEND_PORT"; then
  if [ -n "$FRONTEND_PORT_CONFIGURED" ]; then
    echo "[dev] FRONTEND_PORT is set to $FRONTEND_PORT but that port is already in use."
    echo "[dev] Stop the existing process or choose a different FRONTEND_PORT in .env."
    exit 1
  fi
  FREE_FRONTEND_PORT="$(find_free_port "$FRONTEND_PORT")" || {
    echo "[dev] Could not find free frontend port starting at $FRONTEND_PORT"
    exit 1
  }
  if [ "$FREE_FRONTEND_PORT" != "$FRONTEND_PORT" ]; then
    echo "[dev] Frontend port $FRONTEND_PORT in use, using $FREE_FRONTEND_PORT"
  fi
fi

echo "[dev] Starting backend on http://$BACKEND_HOST:$FREE_BACKEND_PORT"
(
  cd "$BACKEND_DIR"
  source .venv/bin/activate
  export RCLONE_HUB_LOG_LEVEL="${RCLONE_HUB_LOG_LEVEL:-DEBUG}"
  exec uvicorn app.main:app --host "$BACKEND_HOST" --port "$FREE_BACKEND_PORT" --reload
) &
BACKEND_PID=$!

API_BASE="http://$BACKEND_HOST:$FREE_BACKEND_PORT/api"
echo "[dev] Starting frontend on http://$FRONTEND_HOST:$FREE_FRONTEND_PORT"
echo "[dev] Frontend will use API base: $API_BASE"
(
  cd "$FRONTEND_DIR"
  export VITE_API_BASE="$API_BASE"
  exec npm run dev -- --host "$FRONTEND_HOST" --port "$FREE_FRONTEND_PORT"
)
