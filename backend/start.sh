#!/bin/bash
# AutoCert backend startup script.

set -e

PORT=8000
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$APP_DIR/venv"
PID_FILE="$APP_DIR/.server.pid"

cd "$APP_DIR"

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Stopping old backend process (PID: $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null
        sleep 1
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
fi

EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    echo "Port $PORT is occupied, killing process: $EXISTING"
    kill -9 $EXISTING 2>/dev/null || true
    sleep 1
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "Installing Python dependencies..."
pip install -q -r "$APP_DIR/requirements.txt"

mkdir -p "$APP_DIR/logs"

echo ""
echo "Starting AutoCert backend..."
echo "Address: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

uvicorn app.main:app --host 0.0.0.0 --port "$PORT" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

trap "kill $SERVER_PID 2>/dev/null; rm -f $PID_FILE; echo ''; echo 'Stopped'; exit 0" INT TERM

wait "$SERVER_PID"
rm -f "$PID_FILE"
