#!/bin/bash
# AutoCert 启动脚本

set -e

PORT=8000
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$APP_DIR/venv"
PID_FILE="$APP_DIR/.server.pid"

cd "$APP_DIR"

# ── 杀掉已有进程 ──
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "⏹  停止旧进程 (PID: $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null
        sleep 1
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
fi

EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    echo "⏹  端口 $PORT 被占用，杀掉进程: $EXISTING"
    kill -9 $EXISTING 2>/dev/null || true
    sleep 1
fi

# ── Python 虚拟环境 ──
if [ ! -d "$VENV_DIR" ]; then
    echo "📦 创建 Python 虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "📥 安装 Python 依赖..."
pip install -q -r requirements.txt

# ── 前端构建 ──
if [ -d "$APP_DIR/frontend" ]; then
    echo "🔨 构建前端..."
    cd "$APP_DIR/frontend"
    npm install --silent 2>/dev/null
    npm run build
    cd "$APP_DIR"
fi

# ── 启动服务 ──
echo ""
echo "🚀 AutoCert 启动中..."
echo "   地址: http://localhost:$PORT"
echo "   按 Ctrl+C 停止"
echo ""

uvicorn main:app --host 0.0.0.0 --port $PORT &
SERVER_PID=$!
echo $SERVER_PID > "$PID_FILE"

trap "kill $SERVER_PID 2>/dev/null; rm -f $PID_FILE; echo ''; echo '⏹  已停止'; exit 0" INT TERM

wait $SERVER_PID
rm -f "$PID_FILE"
