/**
 * 进程树采集。一次 `ps` 全量快照后在内存里建树 —— discover 会对几十个 pane 取子树，
 * 逐 pane fork `ps --ppid` 太贵（archive 的 Python 版就是那样）。
 *
 * stat / tty 供 provider.detect 判断「是不是 pane 的前台作业」：
 *  - stat 首字母 T/t = 挂起（Ctrl-Z），此时 pane 的按键到不了该进程；
 *  - stat 含 '+' = 在其控制终端的前台进程组；
 *  - tty = 控制终端，用于识别嵌套终端（nvim :term 等）里的进程。
 */
import { execFile } from 'node:child_process';

export type ProcNode = {
  pid: number;
  ppid: number;
  /** ps STAT 列，如 `Ssl+`、`Tl` */
  stat: string;
  /** 控制终端，如 `pts/5`；无终端为 `?` */
  tty: string;
  comm: string;
  args: string;
};

export type ProcessSnapshot = {
  byPid: Map<number, ProcNode>;
  children: Map<number, number[]>;
};

export async function snapshotProcesses(): Promise<ProcessSnapshot> {
  const raw = await new Promise<string>((resolve) => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,stat=,tty=,comm=,args='],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? '' : (stdout ?? '')),
    );
  });

  const byPid = new Map<number, ProcNode>();
  const children = new Map<number, number[]>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // pid ppid stat tty comm args...
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const stat = m[3] ?? '';
    const tty = m[4] ?? '?';
    const comm = m[5] ?? '';
    const args = m[6] ?? '';
    byPid.set(pid, { pid, ppid, stat, tty, comm, args });
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }

  return { byPid, children };
}

/** BFS 取以 pid 为根的子树（含自身），限制节点数防跑飞。 */
export function subtree(snap: ProcessSnapshot, pid: number, maxNodes = 80): ProcNode[] {
  const out: ProcNode[] = [];
  const seen = new Set<number>();
  const queue: number[] = [pid];

  while (queue.length && out.length < maxNodes) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = snap.byPid.get(cur);
    if (node) out.push(node);
    for (const child of snap.children.get(cur) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return out;
}
