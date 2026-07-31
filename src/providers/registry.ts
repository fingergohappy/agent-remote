/** Provider 注册表（design.md §6.4）。 */
import type { AgentProvider, DetectContext, DetectResult, ProviderId } from './types.ts';

const providers = new Map<ProviderId, AgentProvider>();

/** detect 结果低于此置信度不认领 pane。 */
export const DETECT_THRESHOLD = 0.5;

export function registerProvider(p: AgentProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: ProviderId | undefined): AgentProvider | undefined {
  return id ? providers.get(id) : undefined;
}

export function allProviders(): AgentProvider[] {
  return [...providers.values()];
}

export function resetRegistry(): void {
  providers.clear();
}

export type DetectHit = { provider: AgentProvider; result: DetectResult };

/** 所有 provider 竞争，取 confidence 最高且过阈值的。 */
export function detectBest(ctx: DetectContext): DetectHit | null {
  let best: DetectHit | null = null;
  for (const provider of providers.values()) {
    let result: DetectResult | null;
    try {
      result = provider.detect(ctx);
    } catch {
      continue;
    }
    if (!result || result.confidence < DETECT_THRESHOLD) continue;
    if (!best || result.confidence > best.result.confidence) {
      best = { provider, result };
    }
  }
  return best;
}
