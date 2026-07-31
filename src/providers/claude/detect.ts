/** Claude Code 的 pane 识别：只声明签名，判定逻辑在 detect-foreground.ts。 */
import { makeDetector } from '../detect-foreground.ts';

export const detectClaude = makeDetector({
  providerId: 'claude',
  label: 'claude',
  // 原生二进制 / bun 编译版的进程名就是 claude
  comm: /^claude$/,
  // npm 包装器跑在 node 下，靠命令行认：@anthropic-ai/claude-code 或裸路径结尾的 claude
  args: /@anthropic-ai\/claude|claude-code|(^|\/)claude(\s|$)/,
});
