/**
 * Codex 的 pane 识别：只声明签名，判定逻辑在 detect-foreground.ts。
 * 注意 D4：npm 包 `@openai/codex` 通过 node 包装器起 native 二进制，
 * 进程名可能是 `codex` 也可能是平台后缀名（内核截断 15 字符），故 comm 用前缀匹配。
 */
import { makeDetector } from '../detect-foreground.ts';

export const detectCodex = makeDetector({
  providerId: 'codex',
  label: 'codex',
  comm: /^codex(-|$)/,
  args: /@openai\/codex|codex-code-mode|codex-linux|(^|\/)codex(\s|$)/,
});
