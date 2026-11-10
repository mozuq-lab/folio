export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return (!origin || origin === new URL(request.url).origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
}

export class BodyTooLargeError extends Error {
  constructor(message = 'Body too large') {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

export async function readLimitedBytes(body: ReadableStream<Uint8Array> | null, contentLength: string | null, maxBytes: number): Promise<Uint8Array> {
  if (contentLength && Number(contentLength) > maxBytes) {
    await body?.cancel();
    throw new BodyTooLargeError();
  }
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

/** 先頭の maxBytes までを読み、残りは読まずに止める（HTMLの <head> だけが要るときに、大きいページでも途中まで使う）。 */
export async function readPrefixBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value.subarray(0, maxBytes - size));
      size += Math.min(chunk.value.byteLength, maxBytes - size);
    }
    if (size >= maxBytes) await reader.cancel();
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

export async function readLimitedText(body: ReadableStream<Uint8Array> | null, contentLength: string | null, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readLimitedBytes(body, contentLength, maxBytes));
}
