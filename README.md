# agent-remote

手机上的 **coding agent 对讲机**：独立 Telegram Bot + 常驻服务，遥控本机 tmux 里的
Claude Code / Codex / Pi。绑定单位是 **pane（`%14`）**，不是 window —— 一个窗口里开三个 agent 也不会串线。

设计文档在 `~/doc/projects/agent-remote/`（design / decisions / modules / prior-art）。
本仓库是它的实现。

```
Claude hooks   Codex hooks/notify   Pi extension
      │              │                    │
      ▼              ▼                    ▼
 providers/claude  providers/codex   providers/pi   ← 只有这里认识各家的字段
      └──────┬───────┬───────┘
             ▼              ▼
   NormalizedEvent + AgentProvider
             │
   ┌─────────┴──────────────────────────────┐
   │ core: discover · bind · ingress ·      │
   │ notify-policy · send · egress · decision│
   └────────┬──────────────────┬────────────┘
            ▼                  ▼
    tmux (-t %pane_id)   Telegram Bot (Topics)
```

## 能做什么

| | |
|--|--|
| **发现** | `tmux list-panes -a` + 进程树 → 认出哪些 pane 在跑 agent（Codex 前台是 `node` 也认得出） |
| **绑定** | 一个 pane 一个 Telegram Topic；`(chatId, threadId) → paneId` + 指纹防复用 |
| **推送** | hook 事件 + **对话全文**（读 agent 原生 transcript）→ 对应 Topic |
| **回写** | Topic 里打字 → `tmux send-keys -t %N`，不经任何 LLM |
| **补历史** | `/history` 把绑定前的原生会话记录投影进 Topic（Claude jsonl / Codex rollout / Pi session） |
| **授权** | Claude 的 `PreToolUse` / Codex 的 `PermissionRequest` / Pi 的 `tool_call` 可在手机上点允许/拒绝，走结构化响应而非模拟按键 |

Codex ≥ 0.124 有和 Claude 同形的 hooks 引擎，事件与权限回调都全；
更老的版本只有单向的 `notify`（仅「完成」通知），provider 两种格式都认，老配置不迁移也能用。

Pi 没有 shell hook，走的是 `hooks/pi-extension.ts`。`setup` 把它拷到
`~/.pi/agent/extensions/agent-remote.ts`（换机器重跑 setup 即可，不绑仓库路径）。
`--approval` 会写 `PI_APPROVAL=1`，扩展才会拦截 bash / write / edit。已开着的 pi 要重启才能装上扩展。

## 快速开始

### 1. 安装

```bash
# 方式 A：npm（推荐）
npm install -g @fingergohappy2026/agent-remote

# 方式 B：源码
git clone https://github.com/fingergohappy/agent-remote && cd agent-remote
npm install
alias agent-remote='node src/main.ts'   # 下文命令两种方式通用
```

### 2. 一键配置（.env + 两侧 hook）

```bash
agent-remote setup
```

它做这些事：初始化 `~/.config/agent-remote/.env`（自动生成 `INGRESS_SECRET`）；把 hook
合并写入 `~/.claude/settings.json` 与 `~/.codex/hooks.json`；把 Pi 扩展拷到
`~/.pi/agent/extensions/agent-remote.ts` —— 幂等、不碰你已有的其它 hook/扩展、改前自动备份。
`--approval` 追加「手机上批 Claude / Pi 工具调用」，`--uninstall` 干净摘除。
手工装 hook 与逐字段说明见 [hooks/INSTALL.md](hooks/INSTALL.md)，
插件方式见 [plugins/README.md](plugins/README.md)。

然后补上 `~/.config/agent-remote/.env` 里的两个必填项：

- `TELEGRAM_BOT_TOKEN` —— 找 @BotFather 建一个独立 Bot
- `ALLOWED_USERS` —— 你自己的 Telegram user id（白名单）

> 配置目录遵循 XDG：`$XDG_CONFIG_HOME/agent-remote`，未设则 `~/.config/agent-remote`；
> `AGENT_REMOTE_HOME` 可整体覆盖。0.1.1 及更早用的是 `~/.agent-remote` —— 那里若有
> `.env` 且新位置没有，仍会照旧读取，`mv ~/.agent-remote ~/.config/agent-remote` 即完成迁移。

### 3. 启动服务

```bash
agent-remote doctor    # 自检：配置齐不齐、能发现哪些 agent
agent-remote           # 前台启动
```

常驻运行（开机自启、崩溃拉起）见 [systemd/README.md](systemd/README.md)。

### 4. 手机上开工

tmux 里跑起 claude / codex → 给 Bot 发 `/agents` → 点按钮绑定 →
对话全文进话题、打字回传终端、授权请求手机上点。

**要多工位就得有话题（Topics）**，两条路都行：

- BotFather → 你的 Bot → Bot Settings 里给它开 **threads**，私聊就能有话题
- 或者把 Bot 拉进一个开了 Topics 的超级群，给它建话题的权限

判断有没有话题能力不要看 `getChat` 的 `is_forum` —— 开了 threads 的私聊那个字段仍是 false，
但 `createForumTopic` 是能成功的。代码里一律直接试，失败才退化成「整个会话一个工位」。

## 命令

| | |
|--|--|
| `/agents` | 列出可遥控的 agent，点按钮绑定 |
| `/status` | 当前 Topic 绑的是谁、pane 还活着吗 |
| `/history [n]` | 分页浏览会话历史，n 为每页条数（默认 10） |
| `/notify` | 推送级别菜单（全量 / 只推要事 / 静音），点选即生效 |
| `/lang` | 界面语言：默认跟随 Telegram 客户端（中/英），也可手动锁定 |
| `/unbind` | 解绑（**不** kill pane），能关的话题顺手关掉、历史保留 |
| 直接打字 | 发给这个 Topic 绑定的 agent |

`/unbind` 之后的话题去向分两种：超级群 forum 里会被「关闭」（收工，消息都在）；
私聊话题不支持关闭（`closeForumTopic` 报 not a supergroup forum），
只给一个「🗑 删除这个话题」按钮 —— 删会连消息一起清掉，所以交给你点。
反过来，你自己删掉话题，Bot 会在下一次往它发消息撞到 400 时自动解绑（D17）。

## 推送级别

绑定 = 这个 agent 的完整对话都转播到话题里，**包括它的每一条回复**。

| level | 推什么 |
|-------|--------|
| `info`（默认） | 全量：agent 的每条回复、你在终端敲的话，加上要你动手的事件 |
| `important` | 只推要你知道的：完成、等待输入、需要授权、提问、失败 |
| `off` | 不推（仍可打字、仍可 `/history`） |

info 下**不推**「✅ 完成」这类空洞事件 —— 回复原文镜像已经送到了，再补一条只是噪声。
`important` 下没有镜像，完成通知是唯一信号，照推。

**agent 的回复是怎么拿到的**：Claude 的 `Stop` hook 只带 session_id / transcript_path，
**不含回复正文**。所以 info 下另有一路 `core/transcript-watcher`，按 byte offset 增量读
agent 自己的会话文件（Claude 的 jsonl / Codex 的 rollout），把新增的往来追加到话题。
镜像游标持久化在 `~/.config/agent-remote/mirror-cursors.json`：重启后从上次位置续读，
间隙写入的对话不丢；只有首次见到某个 transcript 文件才从末尾起跟（不回放陈年历史）。

绑定即推送：不做「人在终端前」的揣测 —— 绑了就发，级别由 `/notify` 控制。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test，170+ 个用例
npm run check       # 两个一起
npm run build       # 编译到 dist/（生产可用 node dist/main.js）
```

源码直接用 Node 的 TypeScript 支持跑，没有构建步骤也能开发。

### 目录

```
src/
  main.ts          组装与启动
  config.ts        env / ~/.config/agent-remote/.env
  app/             用例编排：bind / notify / chat / history / decision / mirror
  core/            discover · bind-store · ingress · notify-policy · transcript-watcher ·
                   send · egress-queue · decision-broker · agent-index · activity
  providers/       claude/ codex/ pi/ registry types  ← 只有这层认识各家格式
  telegram/        bot · commands · topics · format
  infra/           tmux · process-tree · http · state-fs · logger
hooks/             装到 agent 那边的薄脚本
plugins/           Claude Code / Codex 插件壳（hook 注册的分发通道，见 plugins/README.md）
```

**依赖方向只许向下。** `providers/` 不得 import `telegram/`，`core/` 不得解析任何
provider 私有字段 —— 加新 agent 应该只写一个 provider 包 + 注册一行，不改 bind/Topic/egress。
例外说明：`telegram/format.ts` 是无副作用的纯文案层，`app/` 可以用它；
`app/` 不得 import `telegram/` 的其它模块（bot / commands / topics 持有 grammY 与网络副作用）。

### 加一个新 provider

1. `src/providers/<id>/` 实现 `AgentProvider`：`detect` + `normalizeIngress` 必须有，
   `fetchHistory` / `buildDecisionUi` 按真实能力给
2. `capabilities` 如实填 —— UI 只渲染为 true 的按钮，**不做兑现不了的 UI**
3. `main.ts` 里 `registerProvider(...)`
4. `hooks/` 里加一个入口（Claude/Codex 是 shell wrapper；Pi 是 `pi-extension.ts`）

## 状态

| 状态 | 在哪 | 持久 |
|------|------|------|
| 绑定 | `~/.config/agent-remote/bindings.json` | ✅ |
| 配置 | `~/.config/agent-remote/.env` | ✅ |
| 待决策 | 内存（TTL；重启断掉被 hold 的 hook，agent 退回本机权限框） | ❌ |
| discover / 活跃度 | 内存 | ❌ |
| **对话历史** | **只在 Telegram Topic 里**（D8） | TG 侧 |

不自建对话审计库：换 Bot 或删 Topic 则历史不可恢复，这是明确接受的取舍。

## 安全

- `ALLOWED_USERS` 白名单，`ALLOWED_CHATS` 可选再收紧
- `SESSION_ALLOWLIST` 限制能被遥控的 tmux session
- ingress 只听 127.0.0.1 + HMAC-SHA256 验签
- **发送前查在场**：不止 fingerprint（pane 没换人），还要确认前台确实是那个 agent ——
  agent 退出后 shell 回到前台时拒发，否则那句话会被 shell 当命令执行
- 往 pane 里写字等于拿到那台机器的手 —— Bot token 泄露即等价于 shell 泄露，token 文件 600
