/**
 * hooks 入口（modules.md §4.5）：验签 → 交给 provider.normalize → 丢给 app 的 notify-flow。
 * 本模块不解析任何 provider 私有字段。
 *
 * 阻塞类事件（permission）：hook 的这一次 POST 会被 hold 住，直到用户在 TG 点按钮
 * 或超时，响应体里带回 provider 生成的 hookResponse。
 */
import { createServer, type Server } from 'node:http';
import type { Config } from '../config.ts';
import { logger } from '../infra/logger.ts';
import { readBody, sendJson, verifySignature } from '../infra/http.ts';
import { allProviders, getProvider } from '../providers/registry.ts';
import type { NormalizedEvent } from '../providers/types.ts';
import type { DecisionBroker } from './decision-broker.ts';

const log = logger('ingress');

export type IngressDeps = {
  config: Config;
  broker: DecisionBroker;
  /**
   * 事件已 normalize，交给 app 层做绑定查找与推送。
   * `held: true` = app 层真的建了待决策并推了按钮，这次请求才值得 hold；
   * 光看事件属性（blocking）hold 会在 provider 没有决策能力时让 hook 白等超时。
   */
  onEvent(event: NormalizedEvent): Promise<{ bound: boolean; held: boolean }>;
};

function normalizeWith(
  providerId: string | undefined,
  raw: unknown,
  headers: Record<string, string | undefined>,
): NormalizedEvent | null {
  const explicit = getProvider(providerId);
  if (explicit) return explicit.normalizeIngress(raw, headers);

  // 没声明 provider：让所有 provider 试，谁认得算谁的
  for (const p of allProviders()) {
    try {
      const event = p.normalizeIngress(raw, headers);
      if (event) return event;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

export function createIngressServer(deps: IngressDeps): Server {
  const { config, broker, onEvent } = deps;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${config.ingressHost}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        return;
      }

      if (req.method !== 'POST' || url.pathname !== '/ingress') {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (err) {
        sendJson(res, 413, { ok: false, error: String(err) });
        return;
      }

      const signature = req.headers['x-agent-remote-signature'];
      if (!verifySignature(config.ingressSecret, body, asString(signature))) {
        log.warn('HMAC 校验失败，丢弃');
        sendJson(res, 401, { ok: false, error: 'bad signature' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }

      // 支持两种形状：裸 provider payload，或 { provider, raw }
      const envelope = parsed as { provider?: string; raw?: unknown };
      const hasEnvelope =
        envelope && typeof envelope === 'object' && 'raw' in envelope && 'provider' in envelope;
      const raw = hasEnvelope ? envelope.raw : parsed;
      const providerId = hasEnvelope
        ? envelope.provider
        : asString(req.headers['x-agent-remote-provider']) ??
          (parsed as { provider?: string })?.provider;

      const event = normalizeWith(providerId, raw, flattenHeaders(req.headers));
      if (!event) {
        log.warn('normalize 失败', { providerId });
        sendJson(res, 400, { ok: false, error: 'unrecognized payload' });
        return;
      }

      let held = false;
      try {
        ({ held } = await onEvent(event));
      } catch (err) {
        log.error('事件处理失败', err);
        sendJson(res, 500, { ok: false, error: 'handler failed' });
        return;
      }

      // 阻塞式决策：hold 住这次请求，等用户拍板。
      // 只在 app 层**真的建了待决策**时 hold —— 没绑定、或 provider 没有决策
      // 能力时都没人会去点按钮，hold 满 90s 只会让终端前的你干等着。
      if (held && event.correlationId) {
        const provider = getProvider(event.providerId);
        const { resolved, response } = await broker.wait(
          event.correlationId,
          broker.timeoutMs,
        );
        if (resolved) {
          sendJson(res, 200, { ok: true, decided: true, hookResponse: response ?? {} });
        } else {
          const fallback = provider?.decisionTimeoutResponse?.(event) ?? {};
          broker.expire(event.correlationId, fallback);
          sendJson(res, 200, { ok: true, decided: false, timeout: true, hookResponse: fallback });
        }
        return;
      }

      sendJson(res, 200, { ok: true });
    })().catch((err) => {
      log.error('未捕获异常', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  });
}

function asString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function flattenHeaders(h: NodeJS.Dict<string | string[]>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k] = asString(v);
  return out;
}
