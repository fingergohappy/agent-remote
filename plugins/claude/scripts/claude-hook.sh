#!/usr/bin/env bash
# Claude Code hook 入口。payload 从 stdin 进。
# 需要阻塞授权（PreToolUse）时在 settings.json 里加 --blocking。
exec "$(dirname "$(readlink -f "$0")")/agent-remote-hook.sh" --provider claude "$@"
