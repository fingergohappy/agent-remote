/** 结构化日志 → stderr（journald 收集）。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    let rendered: string;
    if (extra instanceof Error) {
      rendered = extra.stack || `${extra.name}: ${extra.message}`;
    } else {
      try {
        rendered = JSON.stringify(extra);
      } catch {
        rendered = String(extra);
      }
    }
    line += ` ${rendered}`;
  }
  process.stderr.write(line + '\n');
}

export type Logger = {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
};

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}
