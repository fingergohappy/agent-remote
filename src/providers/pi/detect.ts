/** Pi 的 pane 识别：只声明签名，判定逻辑在 detect-foreground.ts。 */
import { makeDetector } from '../detect-foreground.ts';

export const detectPi = makeDetector({
  providerId: 'pi',
  label: 'pi',
  // 全局安装的 `pi` 二进制，进程名就是 pi
  comm: /^pi$/,
  // npm / npx / asdf 包装器跑在 node 下，靠命令行认
  args: /@earendil-works\/pi-coding-agent|(^|\/)pi-coding-agent(\s|$)|(^|\/)pi(\s|$)/,
});
