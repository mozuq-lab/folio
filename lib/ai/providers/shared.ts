import { AIError } from '../../ai.ts';
import { INVALID_OUTPUT_MESSAGE } from '../messages.ts';
import { BodyTooLargeError, readLimitedBytes } from '../../http.ts';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;
export const tooLarge = () => new AIError(502, 'response_too_large', 'AIの応答が大きすぎます。対象記事を減らしてください。');
export const invalidOutput = () => new AIError(502, 'invalid_output', INVALID_OUTPUT_MESSAGE);

export async function readEnvelope(response: Response): Promise<unknown> {
  if (!response.body) { if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw tooLarge(); throw invalidOutput(); }
  let text: string;
  try { text = new TextDecoder().decode(await readLimitedBytes(response.body, response.headers.get('content-length'), MAX_RESPONSE_BYTES)); }
  catch (error) { if (error instanceof BodyTooLargeError) throw tooLarge(); throw error; }
  try { return JSON.parse(text); } catch { throw invalidOutput(); }
}
