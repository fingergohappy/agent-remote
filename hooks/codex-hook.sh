#!/usr/bin/env bash
# Codex notify 入口。codex 会把事件 JSON 作为最后一个参数传进来。
exec "$(dirname "$(readlink -f "$0")")/agent-remote-hook.sh" --provider codex "$@"
