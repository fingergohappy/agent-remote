#!/usr/bin/env bash
# Codex hook 入口，两种通路都认（见 hooks/INSTALL.md）：
#  - hooks 引擎（codex ≥ 0.124）：payload 从 stdin 进，与 Claude 同形；
#    需要阻塞授权（PermissionRequest）时在 hooks.json 里加 --blocking。
#  - 遗留 notify：codex 把事件 JSON 作为最后一个参数传进来。
exec "$(dirname "$(readlink -f "$0")")/agent-remote-hook.sh" --provider codex "$@"
