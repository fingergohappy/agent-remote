/** JSON 状态文件：原子写（tmp + rename），读失败返回默认值。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  renameSync(tmp, path);
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 不存在即成功 */
  }
}
