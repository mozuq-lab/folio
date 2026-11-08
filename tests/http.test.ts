import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyTooLargeError, NO_STORE_HEADERS, isSameOrigin, readLimitedBytes, readLimitedText } from '../lib/http.ts';

const req = (headers: Record<string, string> = {}) => new Request('https://folio.example/api/x', { method: 'POST', headers });
const stream = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });

test('isSameOrigin accepts missing or same origin and rejects cross-site', () => {
  assert.equal(isSameOrigin(req()), true);
  assert.equal(isSameOrigin(req({ origin: 'https://folio.example' })), true);
  assert.equal(isSameOrigin(req({ origin: 'https://evil.example' })), false);
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' })), true);
});

test('NO_STORE_HEADERS', () => {
  assert.deepEqual(NO_STORE_HEADERS, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
});

test('readLimitedBytes accepts exactly the limit', async () => {
  const bytes = await readLimitedBytes(stream(new Uint8Array(3), new Uint8Array(2)), '5', 5);
  assert.equal(bytes.byteLength, 5);
});

test('readLimitedBytes rejects limit+1 without content-length and cancels', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimitedBytes(body, null, 5), BodyTooLargeError);
  assert.equal(cancelled, true);
});

test('readLimitedBytes rejects by content-length and cancels', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimitedBytes(body, '6', 5), BodyTooLargeError);
  assert.equal(cancelled, true);
});

test('readLimitedBytes rejects limit+1 with content-length present but small', async () => {
  await assert.rejects(readLimitedBytes(stream(new Uint8Array(6)), '1', 5), BodyTooLargeError);
});

test('readLimitedBytes returns empty array for null body', async () => {
  assert.equal((await readLimitedBytes(null, null, 5)).byteLength, 0);
});

test('readLimitedText decodes UTF-8 and rejects invalid UTF-8', async () => {
  assert.equal(await readLimitedText(stream(new TextEncoder().encode('日本語')), null, 100), '日本語');
  await assert.rejects(readLimitedText(stream(new Uint8Array([0xff, 0xfe])), null, 100));
});
