# 插件（免手改配置的 hook 注册通道）

插件只负责**注册 hook / 扩展**；常驻服务与 `~/.config/agent-remote/.env` 仍要按仓库根
README 先装好 —— 服务不在时 hook 静默退出 0，先装插件后启服务也不炸。

| 目录 | 给谁 | 带哪些 hook |
|------|------|-------------|
| `claude/` | Claude Code | SessionStart / UserPromptSubmit / Notification / Stop / SessionEnd |
| `codex/` | Codex ≥ 0.124 | SessionStart / UserPromptSubmit / Stop / SessionEnd / **PermissionRequest（阻塞授权）** |
| `pi/` | Pi | session_start / before_agent_start / agent_settled / session_compact / session_shutdown |

安装：

- **Claude Code**：`/plugin marketplace add fingergohappy/agent-remote` → `/plugin install agent-remote@agent-remote`。
  阻塞式手机授权（`PreToolUse`）刻意不进插件 —— matcher 和 timeout 该由你自己定，
  用 `node src/main.ts setup --approval` 或照 [hooks/INSTALL.md](../hooks/INSTALL.md) 手工加。
- **Codex**：`codex /plugins` 打开插件浏览器安装，或走 `codex plugin marketplace add`。
  首次触发 hook 时 codex 会要求确认信任，确认一次即可。
- **Pi**（换机器最省事）：`agent-remote setup` 把扩展拷到
  `~/.pi/agent/extensions/agent-remote.ts`，不依赖仓库路径。
  也可以 `pi install ./plugins/pi`（或任何机器上的绝对路径）。

## 维护约定

`scripts/` / `extensions/` 里是 `hooks/` 同名文件的**副本**（插件安装时会被整目录拷走，
不能 symlink 出去）。改了 `hooks/*.sh` 或 `hooks/pi-extension.ts` 后跑 `npm run sync:plugins`；
`test/plugins-sync.test.ts` 会在副本漂移时把测试跑红。
