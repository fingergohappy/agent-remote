/**
 * 当前分支，**不调 git 进程**。
 *
 * `git rev-parse --abbrev-ref HEAD` 一次要 fork/exec 一个进程（本机实测 5~15ms），
 * discover 一轮十几个 pane 就是几百毫秒，还都是重复的仓库。
 * 而分支名就明明白白写在 `.git/HEAD` 里：一次 open+read 就够，快两个数量级。
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 向上找 `.git` 的最大层数，防止在深路径上白走一堆 stat */
const MAX_DEPTH = 12;
/** 分支缓存时长。切分支不会立刻反映，但 discover 本来就是 60s 一轮 */
const TTL_MS = 30_000;

const cache = new Map<string, { branch: string | null; at: number }>();

async function readHead(gitDir: string): Promise<string | null> {
  let head: string;
  try {
    head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return null;
  }
  // 正常在分支上：`ref: refs/heads/feature/x`
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1]!;
  // detached HEAD：文件里就是一个裸 sha，给个短的
  return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : null;
}

/** `.git` 可能是文件而不是目录（worktree / submodule），里面写着真正的 gitdir */
async function resolveGitDir(dotGit: string): Promise<string | null> {
  let st;
  try {
    st = await stat(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  try {
    const content = await readFile(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(content.trim());
    if (!m) return null;
    const target = m[1]!.trim();
    return target.startsWith('/') ? target : join(dirname(dotGit), target);
  } catch {
    return null;
  }
}

/** 不在仓库里、读不出来，一律返回 null —— 分支只是锦上添花，绝不能让它挡住 discover */
export async function gitBranch(cwd: string, now = Date.now()): Promise<string | null> {
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.branch;

  let dir = cwd;
  let branch: string | null = null;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const gitDir = await resolveGitDir(join(dir, '.git'));
    if (gitDir) {
      branch = await readHead(gitDir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到根了
    dir = parent;
  }

  cache.set(cwd, { branch, at: now });
  return branch;
}

/** 一批 cwd 并发查，重复的只查一次 */
export async function gitBranches(cwds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(cwds)];
  const pairs = await Promise.all(
    unique.map(async (cwd) => [cwd, await gitBranch(cwd)] as const),
  );
  return new Map(pairs);
}

export function clearGitCache(): void {
  cache.clear();
}
