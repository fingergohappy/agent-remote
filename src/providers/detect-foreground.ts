/**
 * 基于进程树的「前台作业」检测，各 provider 用签名复用同一套逻辑。
 *
 * 判定语义：pane 被认领，当且仅当该 provider 的 agent 进程是 pane 终端的
 * **前台作业**——而不是「子树里出现过它的名字」。误认领的代价很高：
 * send-keys 会把用户消息当 shell 命令直接执行。因此三道硬门槛：
 *
 *  1. 挂起（stat 首字母 T/t，即 Ctrl-Z 进后台）的进程不认领——
 *     此时前台是 shell，按键到不了 agent；
 *  2. 控制终端必须就是 pane 的 tty——排除 nvim :term 等嵌套终端里跑的
 *     agent，那种 pane 的按键先经过外层程序，不能直接注入；
 *  3. 必须在前台进程组（stat 含 '+'）——setsid/nohup 起的不算。
 *
 * 归属对 pane_pid 的深度负责：claude 用 Bash 工具跑 codex 子进程时，
 * 用户面对的是 claude，浅者胜。confidence 由深度主导、命中方式微调，
 * 保证跨 provider 竞争时深度差先于命中方式起作用。
 */
import type { DetectContext, DetectProcess, DetectResult } from './types.ts';

export type AgentSignature = {
  providerId: string;
  label: string;
  /** agent 本体的进程名（ps comm，内核截断为 15 字符） */
  comm: RegExp;
  /** 包装器场景（node 启动器等）下，单个进程完整命令行的特征 */
  args: RegExp;
};

/** 进程名直接命中比命令行特征命中更可信，但差距小于一层深度的惩罚 */
const COMM_BASE = 0.95;
const ARGS_BASE = 0.92;
const DEPTH_PENALTY = 0.05;
/** 深到离谱也保持在认领阈值之上——签名命中且过了三道门槛就该认领 */
const MIN_CLAIM = 0.55;

function isStopped(stat: string | undefined): boolean {
  return !!stat && (stat[0] === 'T' || stat[0] === 't');
}

function inForegroundGroup(stat: string | undefined): boolean {
  return !stat || stat.includes('+');
}

/** ps 给 `pts/5`，tmux 给 `/dev/pts/5`；任一侧缺失（采集降级）则不设卡 */
function onPaneTty(procTty: string | undefined, paneTty: string | undefined): boolean {
  if (!procTty || !paneTty) return true;
  if (procTty === '?') return false;
  const norm = (t: string) => t.replace(/^\/dev\//, '');
  return norm(procTty) === norm(paneTty);
}

/** 沿 ppid 链走回 panePid 数深度；链断（快照不全）就按已走的层数算 */
function depthOf(byPid: Map<number, DetectProcess>, pid: number, panePid: number): number {
  let depth = 0;
  let cur = pid;
  while (cur !== panePid && depth < 50) {
    const node = byPid.get(cur);
    if (!node || node.ppid === cur) break;
    cur = node.ppid;
    depth++;
  }
  return depth;
}

export function detectForegroundAgent(
  ctx: DetectContext,
  sig: AgentSignature,
): DetectResult | null {
  const fg = (ctx.fgCommand || '').trim();

  // ps 快照失败时的降级：只信 tmux 的 pane_current_command——
  // 它本身就取自前台进程组，直接同名才认领
  if (!ctx.processTree.length) {
    return sig.comm.test(fg)
      ? { providerId: sig.providerId, confidence: 0.9, label: sig.label }
      : null;
  }

  const byPid = new Map(ctx.processTree.map((p) => [p.pid, p]));
  let best: DetectResult | null = null;

  for (const p of ctx.processTree) {
    const commHit = sig.comm.test(p.comm);
    const argsHit = !commHit && sig.args.test(p.args);
    if (!commHit && !argsHit) continue;
    if (isStopped(p.stat)) continue;
    if (!onPaneTty(p.tty, ctx.paneTty)) continue;
    if (!inForegroundGroup(p.stat)) continue;

    const base = commHit ? COMM_BASE : ARGS_BASE;
    const depth = depthOf(byPid, p.pid, ctx.panePid);
    const confidence = Math.max(MIN_CLAIM, base - depth * DEPTH_PENALTY);
    if (!best || confidence > best.confidence) {
      best = { providerId: sig.providerId, confidence, label: sig.label };
    }
  }
  return best;
}

export function makeDetector(sig: AgentSignature): (ctx: DetectContext) => DetectResult | null {
  return (ctx) => detectForegroundAgent(ctx, sig);
}
