/** 向 pane 注入用户文本（modules.md §4.7）。 */
import type { Binding } from './bind-store.ts';
import { BindStore } from './bind-store.ts';
import { verifyPresence } from './discover.ts';
import { sendKeys } from '../infra/tmux.ts';
import { getProvider } from '../providers/registry.ts';

export type SendResult =
  | { ok: true; paneId: string }
  | {
      ok: false;
      code: 'pane_dead' | 'fingerprint_mismatch' | 'agent_gone' | 'send_failed';
      error: string;
    };

export type SendOptions = {
  enterDelayMs?: number;
  bracketedPaste?: boolean;
};

export async function sendToBinding(
  binding: Binding,
  text: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  // 不止查 pane 还在不在 —— 还要确认前台真的是那个 agent。
  // agent 退出后 shell 回到前台时，这段文本会被 shell 当命令执行。
  const state = await verifyPresence(binding);
  if (state === 'pane_dead') {
    return { ok: false, code: 'pane_dead', error: `pane ${binding.paneId} 已不存在` };
  }
  if (state === 'fingerprint_mismatch') {
    return {
      ok: false,
      code: 'fingerprint_mismatch',
      error: `pane ${binding.paneId} 已被其它进程占用（指纹不符）`,
    };
  }
  if (state === 'agent_gone') {
    return {
      ok: false,
      code: 'agent_gone',
      error: `pane ${binding.paneId} 的前台已不是 ${binding.providerId}（agent 可能已退出）`,
    };
  }

  const provider = getProvider(binding.providerId);
  const formatted = provider?.formatUserText?.(text) ?? { keys: text, enter: true };

  try {
    await sendKeys(binding.paneId, formatted.keys, {
      enter: formatted.enter ?? true,
      enterDelayMs: opts.enterDelayMs,
      bracketedPaste: opts.bracketedPaste,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'send_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, paneId: binding.paneId };
}
