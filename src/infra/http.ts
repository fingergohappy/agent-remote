/** localhost HTTP 小工具：读 body、HMAC 验签、JSON 响应。 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 2 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('body 过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function sign(secret: string, body: Buffer | string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret: string, body: Buffer, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = sign(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
