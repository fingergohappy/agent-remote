/**
 * Provider 合约（design.md §6.3）。
 *
 * 边界铁律：
 *  - providers/ 不得 import telegram/ —— 只产出 NormalizedEvent / DecisionUiSpec。
 *  - core 不得解析 provider 私有字段（payload 对 core 是不透明的）。
 *  - UI 只渲染 capabilities 为 true 的按钮，绝不假装未实现的能力。
 */

export type ProviderId = string; // 'claude' | 'codex' | …

export type ProviderCapabilities = {
  /** 结构化权限决策（hook stdout），非 TUI 方向键 */
  semanticPermission: boolean;
  /** AskUser 类结构化问答 */
  structuredQuestion: boolean;
  /** 可读原生会话日志（供 /history 与增强推送） */
  nativeTranscript: boolean;
  /** 从 TG resume 旧会话 */
  resumeSession: boolean;
  /** 从 TG 拉起新进程 */
  spawnFromBot: boolean;
  /** 支持「终端前活跃则静音」所需的活动信号 */
  activitySuppress: boolean;
};

/** Core 只消费这些事件类型；provider 负责把原生 hook 映射过来。 */
export type AgentEventType =
  | 'started'
  | 'output'
  | 'waiting'
  | 'permission'
  | 'question'
  | 'completed'
  | 'failed'
  | 'ended';

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'started',
  'output',
  'waiting',
  'permission',
  'question',
  'completed',
  'failed',
  'ended',
];

export type NormalizedEvent = {
  type: AgentEventType;
  providerId: ProviderId;
  /** 优先 %N；缺失时由 core 用 pid/sessionId/cwd 反查 */
  paneId?: string;
  summary?: string;
  /** provider 原生会话 id */
  sessionId?: string;
  cwd?: string;
  /** provider 原生 transcript 文件路径（若 hook 提供） */
  transcriptPath?: string;
  /** permission/question 的回调关联 id */
  correlationId?: string;
  /** 该事件是否阻塞 agent（需要用户决策才能继续） */
  blocking?: boolean;
  /** provider 私有，core 不解析、不展示 */
  payload?: unknown;
  ts: string;
  /**
   * 仅更新状态、不产生用户可见消息（如 UserPromptSubmit 只用于活跃度打点）。
   * core 会照常更新索引/活跃度，但不进 egress。
   */
  silent?: boolean;
};

/** 进程树节点摘要。stat/tty 缺失（采集降级）时 detect 按「运行中、同终端」放行。 */
export type DetectProcess = {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
  /** ps STAT，如 `Ssl+`；首字母 T/t 为挂起，含 '+' 为前台进程组 */
  stat?: string;
  /** 控制终端，如 `pts/5`；无终端为 `?` */
  tty?: string;
};

export type DetectContext = {
  paneId: string;
  fgCommand: string;
  panePid: number;
  /** pane 的终端设备（tmux pane_tty，如 `/dev/pts/5`） */
  paneTty?: string;
  title: string;
  cwd: string;
  /** 以 panePid 为根的进程子树（BFS 序），由 core 采集后传入 */
  processTree: DetectProcess[];
};

export type DetectResult = {
  providerId: ProviderId;
  confidence: number; // 0..1
  label?: string;
};

export type DecisionUiSpec = {
  prompt: string;
  buttons: { id: string; label: string }[];
};

export type DecisionOutcome = {
  ok: boolean;
  /** 结构化通路不可用时，core 可回退到具名按键 */
  fallbackKeys?: string[];
  /** 展示给用户的结果说明 */
  note?: string;
};

/** 定位一次会话：尽可能精确，逐级降级。 */
export type HistoryRef = {
  paneId: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
};

export type HistoryItem = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts?: string;
  kind?: 'message' | 'tool' | 'reasoning';
};

export type HistoryResult = {
  items: HistoryItem[];
  /** 来源文件，便于用户判断取的是不是那次会话 */
  source?: string;
  nextCursor?: unknown;
};

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** 扫描阶段：是否认领该 pane（多 provider 竞争时取 confidence 最高） */
  detect(ctx: DetectContext): DetectResult | null;

  /** hooks 原始 body → 标准事件；不认识则返回 null */
  normalizeIngress(
    raw: unknown,
    headers?: Record<string, string | undefined>,
  ): NormalizedEvent | null;

  /** 用户在 Topic 里发的纯文本如何注入；默认 core 直接 literal send-keys */
  formatUserText?(text: string): { keys: string; enter?: boolean };

  /** 权限/提问按钮布局；仅当对应 capability 为 true 才会被调用 */
  buildDecisionUi?(event: NormalizedEvent): DecisionUiSpec | null;

  /**
   * 用户点了按钮 → 生成要回给阻塞 hook 的响应体。
   * core 负责写 IPC 文件并唤醒 hook；provider 只决定内容。
   */
  resolveDecision?(
    event: NormalizedEvent,
    decisionId: string,
  ): Promise<{ hookResponse?: unknown } & DecisionOutcome>;

  /** 决策超时后 hook 该拿到什么（fail-open / fail-closed 由 provider 声明） */
  decisionTimeoutResponse?(event: NormalizedEvent): unknown;

  /** 读原生 transcript，用于 /history 接手补齐（D12） */
  fetchHistory?(ref: HistoryRef, opts: { limit: number }): Promise<HistoryResult>;

  /**
   * 可选：原生 transcript 增量（增强推送，失败不影响主路径）。
   * source 是本次追的文件路径 —— core 用它挂 fs.watch 做低延迟镜像，不解析内容。
   */
  pollNativeEnhancements?(
    ref: HistoryRef,
    cursor: unknown,
  ): Promise<{ nextCursor: unknown; messages: HistoryItem[]; source?: string } | null>;

  /** 可选：spawn 命令行 */
  spawnCommand?(opts: { cwd: string; resumeId?: string }): string[];
}
