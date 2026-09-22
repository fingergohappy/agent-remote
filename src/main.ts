#!/usr/bin/env node
/**
 * 组装与启动（modules.md §8）：
 *   config → providers → bindings → ingress HTTP → telegram bot → reconcile → ready
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { AgentIndex } from './core/agent-index.ts';
import { BindStore } from './core/bind-store.ts';
import { DecisionBroker } from './core/decision-broker.ts';
import { EchoGuard } from './core/echo-guard.ts';
import { EgressQueue } from './core/egress-queue.ts';
import { createIngressServer } from './core/ingress-http.ts';
import { TranscriptWatcher } from './core/transcript-watcher.ts';
import { TypingIndicator } from './core/typing.ts';
import { handleThreadGone, handleTopicClosedOnSend, reconcileBindings } from './app/bind-flow.ts';
import { handleEvent } from './app/notify-flow.ts';
import { handleMirrored } from './app/mirror-flow.ts';
import type { AppContext } from './app/context.ts';
import { ensureDir } from './infra/state-fs.ts';
import { initI18n } from './i18n.ts';
import { logger, setLogLevel } from './infra/logger.ts';
import { registerProvider } from './providers/registry.ts';
import { claudeProvider } from './providers/claude/index.ts';
import { codexProvider } from './providers/codex/index.ts';
import { piProvider } from './providers/pi/index.ts';
import {
  createBot,
  createTopicManager,
  createTransport,
  createTypingSender,
  installAuth,
  setCommandMenu,
} from './telegram/bot.ts';
import { registerHandlers } from './telegram/commands.ts';
import { discover } from './core/discover.ts';
import { runSetup } from './setup.ts';

const log = logger('main');

const RECONCILE_INTERVAL_MS = 60_000;

function registerProviders(): void {
  registerProvider(claudeProvider);
  registerProvider(codexProvider);
  registerProvider(piProvider);
}

async function runDoctor(): Promise<number> {
  registerProviders();
  let config: Config | null = null;
  try {
    config = loadConfig(process.env, { strict: false });
  } catch (err) {
    process.stdout.write(`配置读取失败: ${String(err)}\n`);
    return 1;
  }

  const lines: string[] = [
    `home            ${config.home}`,
    `ingress         http://${config.ingressHost}:${config.ingressPort}/ingress`,
    `bot token       ${config.botToken ? '已设置' : '❌ 缺失 TELEGRAM_BOT_TOKEN'}`,
    `allowed users   ${config.allowedUsers.length ? config.allowedUsers.join(',') : '❌ 缺失 ALLOWED_USERS'}`,
    `ingress secret  ${config.ingressSecret ? '已设置' : '❌ 缺失 INGRESS_SECRET'}`,
    `session 白名单  ${config.sessionAllowlist.length ? config.sessionAllowlist.join(',') : '(全部)'}`,
    `默认推送级别    ${config.defaultNotifyLevel}`,
    '',
  ];

  try {
    const instances = await discover({ sessionAllowlist: config.sessionAllowlist });
    lines.push(`发现 ${instances.length} 个 agent:`);
    for (const i of instances) {
      lines.push(`  ${i.paneId}  ${i.providerId}  ${i.display}  ${i.cwd}  (${i.confidence})`);
    }
  } catch (err) {
    lines.push(`discover 失败: ${String(err)}`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/** 包版本：dist/main.js 与 src/main.ts 的上一级都是包根 */
function packageVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '未知';
  } catch {
    return '未知';
  }
}

function printHelp(): void {
  process.stdout.write(
    `agent-remote ${packageVersion()} —— 手机遥控本机 tmux 里的 coding agent\n` +
      `\n` +
      `用法:\n` +
      `  agent-remote                 启动常驻服务（Telegram Bot + ingress）\n` +
      `  agent-remote setup           装 hook/扩展、初始化 .env（幂等，改前自动备份）\n` +
      `      --approval               追加「手机上批工具调用」的阻塞式 hook\n` +
      `      --uninstall              摘除 setup 写入的条目，别人的一律不碰\n` +
      `  agent-remote doctor          体检：配置齐不齐、能发现哪些 agent\n` +
      `  agent-remote --version       打印版本\n` +
      `\n` +
      `配置在 ~/.config/agent-remote/.env（字段见包内 .env.example）。\n` +
      `Telegram 里的命令（/agents /bind /history …）在绑定的话题里直接敲。\n`,
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  // 没有 --help 时这里会直接去起服务、撞端口才停，看着像挂了
  if (arg === '--help' || arg === '-h' || arg === 'help') {
    printHelp();
    return;
  }
  if (arg === '--version' || arg === '-v') {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (arg === 'doctor' || arg === '--check') {
    process.exitCode = await runDoctor();
    return;
  }
  if (arg === 'setup') {
    process.exitCode = await runSetup(process.argv.slice(3));
    return;
  }

  // 1. config
  const config = loadConfig();
  setLogLevel(config.logLevel);
  ensureDir(config.home, 0o700);
  initI18n(join(config.home, 'lang.json'));

  // 2. providers
  registerProviders();

  // 3. bindings
  const store = new BindStore(config.bindingsFile);
  log.info(`载入 ${store.list().length} 条绑定`);

  const index = new AgentIndex();
  const echo = new EchoGuard();
  const broker = new DecisionBroker(config.decisionTimeoutMs);
  broker.startGc();

  // 5a. bot（先建，egress 需要它的 api）
  const bot = createBot(config);
  const egress = new EgressQueue(createTransport(bot.api), {
    // 话题被用户删掉后，发送会 400；借这个信号自动解绑
    onThreadGone: (chatId, threadId) => handleThreadGone(app, { chatId, threadId }),
    // 非白名单成员关闭话题时收不到 forum_topic_closed（auth 拦掉了），发送失败兜底
    onTopicClosed: (chatId, threadId) => handleTopicClosedOnSend(app, { chatId, threadId }),
  });

  // 对话镜像：Claude 的 Stop hook 不含回复正文，只能从 transcript 追
  const typing = new TypingIndicator(createTypingSender(bot.api));

  const mirror = new TranscriptWatcher({
    store,
    onMessages: (messages) => handleMirrored(app, messages),
    onIdle: (b) => typing.stop(b.chatId, b.threadId || undefined),
    // 游标落盘：重启不丢「上次读到哪」，间隙写入的对话照常镜像
    cursorFile: join(config.home, 'mirror-cursors.json'),
  });

  const app: AppContext = {
    config,
    store,
    index,
    echo,
    broker,
    egress,
    mirror,
    typing,
    topics: createTopicManager(bot.api),
  };

  installAuth(bot, config);
  registerHandlers(bot, app);

  // 4. ingress HTTP
  const server = createIngressServer({
    config,
    broker,
    onEvent: (event) => handleEvent(app, event),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.ingressPort, config.ingressHost, () => resolve());
  });
  log.info(`ingress 监听 http://${config.ingressHost}:${config.ingressPort}`);

  // 5b. 启动 long polling
  await setCommandMenu(bot);
  void bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => log.info(`bot 已上线 @${me.username}`),
  });

  // 6. 对话镜像：主路径是 hook 触发 + fs.watch，定时轮询只兜底
  mirror.start(config.mirrorIntervalMs);
  log.info(
    config.mirrorIntervalMs > 0
      ? `transcript 镜像已启动（事件驱动，兜底轮询 ${config.mirrorIntervalMs}ms）`
      : 'transcript 镜像已启动（仅事件驱动，无兜底轮询）',
  );

  // 7. reconcile
  const reconcile = async (): Promise<void> => {
    try {
      const instances = await discover({ sessionAllowlist: config.sessionAllowlist });
      index.upsertFromDiscover(instances);
      echo.gc();
      await reconcileBindings(app);
    } catch (err) {
      log.warn('reconcile 失败', err);
    }
  };
  await reconcile();
  mirror.kick(); // 已有绑定立刻定位 transcript，不用干等第一轮兜底轮询
  const timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  timer.unref?.();

  // 8. ready
  log.info('ready');

  const shutdown = (signal: string): void => {
    log.info(`收到 ${signal}，退出中`);
    clearInterval(timer);
    mirror.stop();
    typing.stopAll();
    broker.stopGc();
    server.close();
    void (async () => {
      await bot.stop().catch(() => undefined); // 先停收新消息
      await egress.drain(3000).catch(() => undefined); // 再把已排队的发完，别丢在半路
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('启动失败', err);
  process.exit(1);
});
