/**
 * 列出「可遥控的 agent 实例」（modules.md §4.2）。
 * core 只负责采集 pane + 进程树，认领与否交给 provider.detect。
 */
import { homedir } from 'node:os';
import { computeFingerprint } from './bind-store.ts';
import { gitBranches } from '../infra/git.ts';
import { listPanes, type TmuxPane } from '../infra/tmux.ts';
import { snapshotProcesses, subtree } from '../infra/process-tree.ts';
import { detectBest } from '../providers/registry.ts';

export type AgentInstance = {
  paneId: string;
  display: string; // ibnk:1.2
  providerId: string;
  label: string;
  title: string;
  cwd: string;
  fg: string;
  pid: number;
  /** 当前 git 分支；不在仓库里就没有 */
  branch?: string;
  confidence: number;
  fingerprint: string;
};

export type DiscoverOptions = {
  /** 空数组 = 不过滤 */
  sessionAllowlist?: string[];
};

export function sessionAllowed(session: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(session);
}

export async function discover(opts: DiscoverOptions = {}): Promise<AgentInstance[]> {
  const panes = await listPanes();
  const candidates = panes.filter((p) => sessionAllowed(p.session, opts.sessionAllowlist));
  if (!candidates.length) return [];

  const snap = await snapshotProcesses();
  const instances: AgentInstance[] = [];
  const matched: { pane: TmuxPane; hit: NonNullable<ReturnType<typeof detectBest>> }[] = [];

  for (const pane of candidates) {
    const tree = subtree(snap, pane.pid).map((n) => ({
      pid: n.pid,
      ppid: n.ppid,
      comm: n.comm,
      args: n.args,
      stat: n.stat,
      tty: n.tty,
    }));

    const hit = detectBest({
      paneId: pane.paneId,
      fgCommand: pane.fg,
      panePid: pane.pid,
      paneTty: pane.tty,
      title: pane.title,
      cwd: pane.cwd,
      processTree: tree,
    });
    if (!hit) continue;

    matched.push({ pane, hit });
  }

  // 分支只读 .git/HEAD，不 fork git 进程；重复的 cwd 只查一次，还有 30s 缓存。
  // 实测十几个 pane 冷启 ~6ms、命中缓存 ~0ms，相对 tmux+ps 那两步是噪声。
  const branches = await gitBranches(matched.map((m) => m.pane.cwd));

  for (const { pane, hit } of matched) {
    instances.push({
      paneId: pane.paneId,
      display: pane.display,
      providerId: hit.result.providerId,
      label: hit.result.label ?? hit.provider.displayName,
      title: pane.title,
      cwd: pane.cwd,
      fg: pane.fg,
      pid: pane.pid,
      confidence: hit.result.confidence,
      fingerprint: computeFingerprint(pane.paneId, pane.pid, hit.result.providerId),
      branch: branches.get(pane.cwd) ?? undefined,
    });
  }

  instances.sort((a, b) => a.display.localeCompare(b.display, 'en'));
  return instances;
}

/**
 * 项目名：给话题名和按钮当短标签用。
 * 家目录返回 `~` —— 拿 basename 会得到用户名（`finger`），毫无信息量。
 */
export function projectLabel(inst: Pick<AgentInstance, 'cwd' | 'display'>): string {
  const home = homedir();
  if (inst.cwd === home) return '~';
  return inst.cwd.split('/').filter(Boolean).pop() || inst.display;
}

/**
 * Topic 名：`🤖 %22 codex · agent-remote`
 * paneId 放前面 —— 它才是绑定主键，侧栏一眼能对上是哪个 pane。
 */
export function instanceTitle(
  inst: Pick<AgentInstance, 'paneId' | 'providerId' | 'cwd' | 'display'>,
): string {
  return `🤖 ${inst.paneId} ${inst.providerId} · ${projectLabel(inst)}`;
}

/**
 * 展示顺序：先按 tmux session，再按 pane 坐标。
 *
 * 文字列表和按钮必须用**同一个**顺序 —— 你是照着上面的列表去找下面的按钮的，
 * 两边错位就会点错 agent。所以排序放在这儿，两边共用一次结果。
 */
export function sortForDisplay(instances: AgentInstance[]): AgentInstance[] {
  const parts = (display: string): [string, string] => {
    const colon = display.indexOf(':');
    return colon > 0 ? [display.slice(0, colon), display.slice(colon + 1)] : [display, ''];
  };
  return [...instances].sort((a, b) => {
    const [sa, pa] = parts(a.display);
    const [sb, pb] = parts(b.display);
    return sa === sb ? pa.localeCompare(pb, 'en', { numeric: true }) : sa.localeCompare(sb);
  });
}

export function findPane(panes: TmuxPane[], paneId: string): TmuxPane | undefined {
  return panes.find((p) => p.paneId === paneId);
}
