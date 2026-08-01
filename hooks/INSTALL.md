# Hook 安装

两端 hook 都只做一件事：**补上 `paneId` → HMAC 签名 → POST 到本机 ingress**。
业务逻辑全在常驻服务里，hook 挂了也不会拖垮 agent（任何失败都静默退出 0）。

依赖：`curl`、`jq`、`openssl`。

先确认服务在跑：

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"pid":…}
```

下面假设仓库在 `~/code/mycode/agent-remote`，按实际路径替换。

---

## Claude Code

编辑 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh" }] }
    ]
  }
}
```

| hook | 用途 |
|------|------|
| `SessionStart` | 建立 `paneId ↔ sessionId` 映射，`/history` 才能精确定位会话 |
| `Notification` | 等待输入 / 需要授权 → 推手机 |
| `Stop` | 完成通知 |
| `UserPromptSubmit` | **不推送**，只用于会话索引与镜像触发 |
| `SessionEnd` | 会话结束 |

已经有别的 `Notification` hook（比如桌面通知）？两条并列写进同一个 `hooks` 数组即可，互不影响。

### 手机上点「允许 / 拒绝」（可选）

想在 Telegram 上批准工具调用，再加一条 **阻塞式** `PreToolUse`：

```json
"PreToolUse": [
  {
    "matcher": "Bash|Write|Edit",
    "hooks": [
      {
        "type": "command",
        "command": "~/code/mycode/agent-remote/hooks/claude-hook.sh --blocking",
        "timeout": 130
      }
    ]
  }
]
```

行为：hook 会一直等到你在 Telegram 上点按钮，或 `DECISION_TIMEOUT_SEC`（默认 90 秒）超时。
**超时不会替你决定** —— hook 输出空，Claude 退回本机 TUI 的权限框照常问你。

hook 内部的 curl 等待自动取 `DECISION_TIMEOUT_SEC + 40s`；但上面 settings.json 里的
`"timeout": 130` 是 Claude 侧的死数字 —— 改大 `DECISION_TIMEOUT_SEC` 时要同步它 ≥ 新值 + 40。

`matcher` 建议只挂高风险工具。挂 `.*` 会让每次工具调用都等你在手机上点一下。

---

## Codex

Codex 走 `notify` 程序（不是 stdin hook）：codex 把事件 JSON 作为最后一个参数传给它。

编辑 `~/.codex/config.toml`：

```toml
notify = ["/home/你的用户名/code/mycode/agent-remote/hooks/codex-hook.sh"]
```

路径必须是**绝对路径**，`~` 不会展开。

实测 codex 0.146.0 只发一种事件 `agent-turn-complete`，所以 Codex 侧目前只有「完成」通知，
没有权限/提问回调 —— 这也是 `codexProvider.capabilities.semanticPermission = false` 的原因，
Telegram 上不会给 Codex 显示批准按钮（不做兑现不了的 UI）。

`/history` 对 Codex 照常可用，读的是 `~/.codex/sessions/**/rollout-*.jsonl`。

---

## 验证

```bash
# 1. 在 tmux 里跑一个 claude，随便让它干点活
# 2. 手机上 /agents → 绑定它
# 3. 让它跑完一轮 → Topic 里应该出现它的回复正文
# 4. 在 Topic 里打字 → 桌面 pane 里应该出现你的输入

# 看服务日志判断事件有没有到：
LOG_LEVEL=debug node src/main.ts
```

回复正文来自 transcript 镜像，不是 hook —— Claude 的 Stop hook 不带正文。
所以第 3 步没反应有两种可能：推送级别不是 `info`（`/notify` 看一眼），
或者 hook 压根没送到（日志里搜 `ingress`）。等待授权、失败这类事件才走 hook。
