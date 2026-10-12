import type { ApiErrorCode } from '../contracts/commands.ts';

export function jsonResponse(value: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
}
export function statusFor(code: ApiErrorCode): number {
  if (code === 'unauthenticated') return 401;
  if (code === 'invalid') return 400;
  if (code === 'rate-limited') return 429;
  if (code === 'unavailable') return 503;
  if (code === 'not-found') return 404;
  return 409;
}
/** Count streamed bytes as well as Content-Length; a caller cannot bypass the bound by omitting the header. */
export async function readCommandBody(request: Request): Promise<unknown> {
  const maximum = 16_384;
  if (Number(request.headers.get('Content-Length')) > maximum) throw new RangeError('body-size');
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new RangeError('body-size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
