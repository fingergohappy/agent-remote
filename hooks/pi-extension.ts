/**
 * agent-remote 的 Pi 扩展。
 *
 * 职责只有：补 paneId / session / transcript → HMAC 签名 → POST 到本机 ingress。
 * 任何失败都不能拖垮 pi —— 静默吞掉。
 *
 * 源在仓库 hooks/pi-extension.ts。
 * `agent-remote setup` 拷到 ~/.pi/agent/extensions/agent-remote.ts（换机器重跑 setup 即可）；
 * 也可以 `pi install git:github.com/fingergohappy/agent-remote` 装 plugins/pi 这包。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type IngressCfg = {
  host: string;
  port: number;
  secret: string;
  timeoutSec: number;
  approval: boolean;
};

type HookResponse = { block?: boolean; reason?: string };

function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function truthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

function resolveHome(): string {
  if (process.env.AGENT_REMOTE_HOME) return process.env.AGENT_REMOTE_HOME;
  const xdg = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-remote');
  if (existsSync(join(xdg, '.env'))) return xdg;
  const legacy = join(homedir(), '.agent-remote');
  return existsSync(join(legacy, '.env')) ? legacy : xdg;
}

function loadCfg(): IngressCfg | null {
  const file = parseEnvFile(join(resolveHome(), '.env'));
  const get = (k: string): string | undefined => process.env[k] ?? file[k];
  const secret = get('INGRESS_SECRET');
  if (!secret) return null;
  const timeout = Number(get('DECISION_TIMEOUT_SEC'));
  return {
    host: get('INGRESS_HOST') || '127.0.0.1',
    port: Number(get('INGRESS_PORT')) || 8787,
    secret,
    timeoutSec: Number.isFinite(timeout) && timeout >= 1 ? Math.floor(timeout) : 90,
    approval: truthy(get('PI_APPROVAL')),
  };
}

function sessionOf(ctx: {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
}): { session_id?: string; transcript_path?: string; cwd?: string; paneId?: string } {
  let sessionId: string | undefined;
  let transcript: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId?.();
  } catch {
    /* 会话替换后 ctx 可能作废 */
  }
  try {
    transcript = ctx.sessionManager?.getSessionFile?.();
  } catch {
    /* 同上 */
  }
  return {
    session_id: sessionId || process.env.PI_SESSION_ID,
    transcript_path: transcript || process.env.PI_SESSION_FILE,
    cwd: ctx.cwd || process.cwd(),
    paneId: process.env.TMUX_PANE,
  };
}

async function post(
  cfg: IngressCfg,
  ctx: Parameters<typeof sessionOf>[0] & { signal?: AbortSignal },
  extra: Record<string, unknown>,
  blocking: boolean,
): Promise<{ hookResponse?: HookResponse } | null> {
  const correlationId = blocking ? randomBytes(4).toString('hex') : '';
  const payload: Record<string, unknown> = {
    provider: 'pi',
    ...sessionOf(ctx),
    ...extra,
  };
  if (correlationId) payload.correlationId = correlationId;
  if (!payload.paneId) delete payload.paneId;
  if (!payload.session_id) delete payload.session_id;
  if (!payload.transcript_path) delete payload.transcript_path;

  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', cfg.secret).update(body).digest('hex');
  const ms = blocking ? (cfg.timeoutSec + 40) * 1000 : 5000;
  const signals: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (ctx.signal) signals.push(ctx.signal);
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/ingress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Remote-Signature': sig,
        'X-Agent-Remote-Provider': 'pi',
      },
      body,
      signal,
    });
    if (!res.ok) return null;
    if (!blocking) return {};
    const json = (await res.json()) as { hookResponse?: HookResponse };
    return json && typeof json === 'object' ? json : {};
  } catch {
    return null;
  }
}

export default function (pi: {
  on: (event: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) => void;
}): void {
  const cfg = loadCfg();
  if (!cfg) return;

  const fire = (
    name: string,
    extra: Record<string, unknown> = {},
    blocking = false,
  ) => {
    return async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const result = await post(cfg, ctx as never, { hook_event_name: name, ...extra, ...pick(event) }, blocking);
      if (blocking && result?.hookResponse?.block) {
        return { block: true, reason: result.hookResponse.reason };
      }
    };
  };

  pi.on('session_start', fire('session_start'));
  pi.on('before_agent_start', fire('user_prompt'));
  pi.on('agent_settled', fire('agent_settled'));
  pi.on('session_compact', fire('session_compact'));
  pi.on('session_shutdown', async (event, ctx) => {
    await post(
      cfg,
      ctx as never,
      { hook_event_name: 'session_shutdown', reason: event.reason },
      false,
    );
  });

  if (cfg.approval) {
    pi.on('tool_call', async (event, ctx) => {
      const name = typeof event.toolName === 'string' ? event.toolName : '';
      if (name !== 'bash' && name !== 'write' && name !== 'edit') return;
      const result = await post(
        cfg,
        ctx as never,
        { hook_event_name: 'tool_call', tool_name: name, tool_input: event.input },
        true,
      );
      if (result?.hookResponse?.block) {
        return { block: true, reason: result.hookResponse.reason };
      }
    });
  }
}

function pick(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof event.reason === 'string') out.reason = event.reason;
  return out;
}
