/**
 * tmux CLI 封装。modules.md §4.1。
 * 约束：所有 send/capture 一律使用 `-t %N`，禁止只传 window/session。
 * 本模块不认识 claude/codex —— 那是 provider.detect 的事。
 */
import { execFile, spawn } from 'node:child_process';

export type TmuxPane = {
  paneId: string; // %14
  session: string;
  window: number;
  index: number;
  fg: string; // pane_current_command
  pid: number; // pane_pid
  tty: string; // pane_tty，如 /dev/pts/5
  title: string;
  cwd: string;
  display: string; // session:window.index
};

/**
 * 字段分隔符用 \x1f（unit separator），不用 \t：
 * pane_title 是应用可任意设置的（shell PROMPT、vim titlestring），
 * 里面混进一个 tab 就会让 cwd 错位到 title 的后半段，绑定与 detect 全跟着错。
 */
const SEP = '\x1f';

const FIELDS = [
  '#{pane_id}',
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_current_command}',
  '#{pane_pid}',
  '#{pane_tty}',
  '#{pane_title}',
  '#{pane_current_path}',
].join(SEP);

export class TmuxError extends Error {}

function run(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      args,
      { timeout: opts.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });
}

/** 把内容经 stdin 灌进一个 tmux paste buffer（避开 argv 长度限制）。 */
function loadBuffer(name: string, content: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['load-buffer', '-b', name, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', () => resolve({ code: 1, stderr: 'tmux load-buffer 启动失败' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.on('error', () => {
      /* close 事件里统一处理 */
    });
    child.stdin.end(content, 'utf8');
  });
}

export function isPaneId(s: string): boolean {
  return /^%\d+$/.test(s);
}

export async function listPanes(): Promise<TmuxPane[]> {
  const r = await run(['list-panes', '-a', '-F', FIELDS]);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || 'tmux list-panes failed';
    // 「没有 server」两种表现都算空列表：server 从未启动（error connecting，
    // socket 文件不存在）和 server 刚退出（no server running）。
    // 对 daemon 来说这不是错误 —— 没有 tmux 就是没有可遥控的 agent。
    if (/no server running|error connecting/i.test(msg)) return [];
    throw new TmuxError(msg);
  }
  const panes: TmuxPane[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    // tmux ≤3.4 会把格式串里的控制字符转成八进制字面量（\x1f → 反斜杠+037），
    // 3.5+ 才原样输出。两种都认。title 恰好含字面 "\037" 文本的风险，
    // 与 title 含真 \x1f 同级 —— 选 \x1f 时就已接受（见 SEP 注释）。
    const parts = line.includes(SEP) ? line.split(SEP) : line.split('\\037');
    if (parts.length < 9) continue;
    const [paneId, session, windowS, indexS, fg, pidS, tty, title, cwd] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const pid = Number(pidS);
    if (!isPaneId(paneId) || !Number.isFinite(pid)) continue;
    const window = Number(windowS);
    const index = Number(indexS);
    panes.push({
      paneId,
      session,
      window,
      index,
      fg,
      pid,
      tty,
      title,
      cwd,
      display: `${session}:${windowS}.${indexS}`,
    });
  }
  return panes;
}

export async function paneAlive(paneId: string): Promise<boolean> {
  if (!isPaneId(paneId)) return false;
  const r = await run(['display-message', '-p', '-t', paneId, '#{pane_id}'], { timeoutMs: 3000 });
  return r.code === 0 && r.stdout.trim() === paneId;
}

/** 返回 pane 的当前展示坐标 session:win.pane；pane 已死则 null。 */
export async function displayOf(paneId: string): Promise<string | null> {
  if (!isPaneId(paneId)) return null;
  const r = await run(
    ['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}.#{pane_index}'],
    { timeoutMs: 3000 },
  );
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}

/** 返回 pane 的 pane_pid；pane 已死则 null。用于 fingerprint 校验。 */
export async function panePid(paneId: string): Promise<number | null> {
  if (!isPaneId(paneId)) return null;
  const r = await run(['display-message', '-p', '-t', paneId, '#{pane_pid}'], { timeoutMs: 3000 });
  // tmux 对不存在的 pane 不报错：退出码 0 + 空输出。
  // 这里必须先判空 —— Number('') 是 0 而不是 NaN，会把死掉的 pane 当成 pid 0。
  const raw = r.stdout.trim();
  if (r.code !== 0 || !raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 超过这个长度就走 paste buffer，避免 argv 长度上限 */
const ARGV_SAFE_LEN = 2000;

let bufferSeq = 0;

export type SendKeysOptions = {
  enter?: boolean;
  /** 文本与 Enter 之间的间隔，给 TUI 处理粘贴的时间 */
  enterDelayMs?: number;
  /** 多行/长文本走 tmux paste buffer，避免 TUI 把每个换行当提交 */
  bracketedPaste?: boolean;
};

/**
 * 向 pane 注入字面文本。
 *
 * 多行或超长文本走 `load-buffer` + `paste-buffer -p -r`：
 *   -r  保留 LF，不替换成 CR（否则每一行都会被 TUI 当成一次提交）
 *   -p  由 tmux 判断应用是否请求了 bracketed paste，需要时才加控制码
 *
 * 不能自己往 `send-keys -l` 里拼 ESC[200~ —— 实测 tmux 会把中间的 LF 吃掉，
 * 多行文本被拼成一行。
 */
export async function sendKeys(
  paneId: string,
  text: string,
  opts: SendKeysOptions = {},
): Promise<void> {
  if (!isPaneId(paneId)) throw new TmuxError(`非法 pane id: ${paneId}`);
  if (!text) throw new TmuxError('空文本');

  const wantPaste = opts.bracketedPaste ?? true;
  const usePaste = (wantPaste && text.includes('\n')) || text.length > ARGV_SAFE_LEN;

  if (usePaste) {
    const buffer = `agent-remote-${process.pid}-${++bufferSeq}`;
    const loaded = await loadBuffer(buffer, text);
    if (loaded.code !== 0) {
      throw new TmuxError(loaded.stderr.trim() || 'tmux load-buffer failed');
    }
    const pasted = await run(['paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', paneId]);
    if (pasted.code !== 0) {
      await run(['delete-buffer', '-b', buffer]); // paste 失败时 -d 不生效，手动收尾
      throw new TmuxError(pasted.stderr.trim() || 'tmux paste-buffer failed');
    }
  } else {
    const r = await run(['send-keys', '-t', paneId, '-l', '--', text]);
    if (r.code !== 0) {
      throw new TmuxError(r.stderr.trim() || r.stdout.trim() || 'send-keys failed');
    }
  }

  if (opts.enter ?? true) {
    const delay = opts.enterDelayMs ?? 150;
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
    const r2 = await run(['send-keys', '-t', paneId, 'Enter']);
    if (r2.code !== 0) {
      throw new TmuxError(r2.stderr.trim() || 'send-keys Enter failed');
    }
  }
}

/** 抓取 pane 可见内容（仅用于状态/调试，不作为对话历史 —— 见 D8）。 */
export async function capturePane(paneId: string, lines = 60): Promise<string> {
  if (!isPaneId(paneId)) throw new TmuxError(`非法 pane id: ${paneId}`);
  const r = await run(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
  if (r.code !== 0) throw new TmuxError(r.stderr.trim() || 'capture-pane failed');
  return r.stdout;
}

/** 由 pid 反查所属 pane（hook 未带 TMUX_PANE 时的兜底）。 */
export async function paneIdOfPid(pid: number): Promise<string | null> {
  const panes = await listPanes();
  const hit = panes.find((p) => p.pid === pid);
  return hit ? hit.paneId : null;
}
