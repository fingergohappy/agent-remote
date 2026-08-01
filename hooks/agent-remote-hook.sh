#!/usr/bin/env bash
# agent-remote 统一 hook 入口。
#
#   agent-remote-hook.sh --provider claude [--blocking]   # payload 从 stdin 读
#   agent-remote-hook.sh --provider codex  "<json>"       # payload 是最后一个参数
#
# 职责只有：补 paneId → HMAC 签名 → POST 到本机 ingress。
# --blocking 时会等服务端回决策，并把 hookResponse 打到 stdout（Claude PreToolUse 用）。
#
# 铁律：任何失败都不能拖垮 agent —— 静默退出 0。

set -uo pipefail

PROVIDER=""
BLOCKING=0
ARG_PAYLOAD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --blocking) BLOCKING=1; shift ;;
    *) ARG_PAYLOAD="$1"; shift ;;
  esac
done

[ -n "$PROVIDER" ] || exit 0

HOME_DIR="${AGENT_REMOTE_HOME:-$HOME/.agent-remote}"
ENV_FILE="$HOME_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  # 只取需要的键，避免把整个 .env 灌进环境
  while IFS='=' read -r key value; do
    case "$key" in
      INGRESS_HOST|INGRESS_PORT|INGRESS_SECRET|DECISION_TIMEOUT_SEC)
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        export "$key=$value"
        ;;
    esac
  done < <(grep -E '^(INGRESS_HOST|INGRESS_PORT|INGRESS_SECRET|DECISION_TIMEOUT_SEC)=' "$ENV_FILE" 2>/dev/null)
fi

HOST="${INGRESS_HOST:-127.0.0.1}"
PORT="${INGRESS_PORT:-8787}"
SECRET="${INGRESS_SECRET:-}"

[ -n "$SECRET" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v openssl >/dev/null 2>&1 || exit 0

# ── 读原始 payload ────────────────────────────────────────────────────────────
if [ -n "$ARG_PAYLOAD" ]; then
  RAW="$ARG_PAYLOAD"
else
  RAW="$(cat)"
fi
[ -n "$RAW" ] || exit 0
echo "$RAW" | jq -e . >/dev/null 2>&1 || exit 0

# ── 补 agent-remote 需要的字段 ────────────────────────────────────────────────
# TMUX_PANE 是 agent 启动时继承下来的 %N，hook 子进程照样拿得到。
PANE="${TMUX_PANE:-}"
CORRELATION=""
if [ "$BLOCKING" = "1" ]; then
  CORRELATION="$(openssl rand -hex 4)"
fi

# 注意：这里不补进程 pid —— hook 自己的 $$ 与 agent 的 pane_pid 无关，
# 传上去只会让服务端的 pid 反查在 PID 复用时误投到别的 pane。
PAYLOAD="$(
  echo "$RAW" | jq -c \
    --arg pane "$PANE" \
    --arg provider "$PROVIDER" \
    --arg cwd "$PWD" \
    --arg corr "$CORRELATION" \
    '. + {provider: $provider}
       + (if $pane != "" then {paneId: $pane} else {} end)
       + (if $corr != "" then {correlationId: $corr} else {} end)
       + (if (.cwd // "") == "" then {cwd: $cwd} else {} end)'
)" || exit 0

SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"

# ── 发送 ──────────────────────────────────────────────────────────────────────
URL="http://$HOST:$PORT/ingress"

if [ "$BLOCKING" = "1" ]; then
  # 等待时长跟着 .env 的 DECISION_TIMEOUT_SEC 走（+40s 余量），不写死 ——
  # 否则改了服务端超时，这里就会提前掐断连接。
  # 注意 Claude settings.json 里 PreToolUse 的 timeout 也要 ≥ 这个值。
  MAX_TIME=$(( ${DECISION_TIMEOUT_SEC:-90} + 40 ))
  # 服务端 hold 住这次请求直到用户拍板或超时，响应里带 hookResponse
  RESPONSE="$(
    curl -sS --max-time "$MAX_TIME" -X POST "$URL" \
      -H 'Content-Type: application/json' \
      -H "X-Agent-Remote-Signature: $SIG" \
      -H "X-Agent-Remote-Provider: $PROVIDER" \
      --data-binary "$PAYLOAD" 2>/dev/null
  )" || exit 0

  # 拿不到决策就什么都不输出 —— agent 回落到自己的本地权限流程
  echo "$RESPONSE" | jq -e '.hookResponse | objects | select(length > 0)' 2>/dev/null || exit 0
  exit 0
fi

curl -sS --max-time 5 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Remote-Signature: $SIG" \
  -H "X-Agent-Remote-Provider: $PROVIDER" \
  --data-binary "$PAYLOAD" >/dev/null 2>&1

exit 0
