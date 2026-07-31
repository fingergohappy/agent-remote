/**
 * transcript 文件读取工具（provider 共用，不含任何 provider 私有格式）。
 * 会话 jsonl 可以很大，只读尾部；增量镜像则按 byte offset 往后追。
 */
import { open, stat } from 'node:fs/promises';

const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** 读文件尾部若干行；文件超大时只读尾部字节并丢弃可能被截断的首行。 */
export async function readTailLines(path: string, maxLines: number): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  if (size === 0) return [];

  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const length = size - start;

  const fh = await open(path, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }

  const lines = text.split('\n');
  if (start > 0 && lines.length) lines.shift(); // 首行可能被截断
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  return nonEmpty.slice(-maxLines);
}

/** 增量镜像的游标：认文件 + 已读到的字节位置 */
export type StreamCursor = { file: string; offset: number };

export type IncrementalRead = {
  cursor: StreamCursor;
  lines: string[];
  /** 首次看到这个文件 —— 调用方通常应该丢弃内容，只记住位置，避免重放历史 */
  fresh: boolean;
};

/**
 * 从上次位置往后读新增的完整行。
 *
 * - 换了文件（新会话）或文件被截断 → 重新定位到末尾，标记 fresh
 * - 只返回以 \n 收尾的完整行；写了一半的那行留到下次
 */
export async function readIncremental(
  file: string,
  cursor: StreamCursor | undefined,
): Promise<IncrementalRead | null> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return null;
  }

  const sameFile = cursor?.file === file;
  if (!sameFile || cursor === undefined || cursor.offset > size) {
    // 新文件、或被重写/截断：从当前末尾开始跟，不回放已有内容
    return { cursor: { file, offset: size }, lines: [], fresh: true };
  }
  if (cursor.offset === size) {
    return { cursor, lines: [], fresh: false };
  }

  const length = size - cursor.offset;
  const fh = await open(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, cursor.offset);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }

  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    // 还没写完一整行，原地等
    return { cursor, lines: [], fresh: false };
  }

  const complete = text.slice(0, lastNewline);
  const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

  return {
    cursor: { file, offset: cursor.offset + consumed },
    lines: complete.split('\n').filter((l) => l.trim().length > 0),
    fresh: false,
  };
}
