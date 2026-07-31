/** 向 pane 注入用户文本（modules.md §4.7）。 */
import type { Binding } from './bind-store.ts';
import { BindStore } from './bind-store.ts';
import { sendKeys } from '../infra/tmux.ts';
import { getProvider } from '../providers/registry.ts';

export type SendResult =
  | { ok: true; paneId: string }
  | { ok: false; code: 'pane_dead' | 'fingerprint_mismatch' | 'send_failed'; error: string };

export type SendOptions = {
  enterDelayMs?: number;
  bracketedPaste?: boolean;
};

export async function sendToBinding(
  store: BindStore,
  binding: Binding,
  text: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const state = await store.validate(binding);
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

  store.patch(binding.chatId, binding.threadId, {
    lastTelegramSendAt: new Date().toISOString(),
  });

  return { ok: true, paneId: binding.paneId };
}
