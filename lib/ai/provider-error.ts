import { AIError } from '../ai.ts';
import { PROVIDERS } from './types.ts';
import type { ProviderId } from './types.ts';

export type ProviderFailureKind = 'invalid_model' | 'input_too_long' | 'unsupported_effort' | 'rate_limited' | 'provider_error';

// Messages are fixed copy: provider response bodies are never included.
export function providerFailure(kind: ProviderFailureKind, provider: ProviderId, model: string): AIError {
  const detail = `（提供元：${PROVIDERS[provider].label}、モデル：${model}）`;
  switch (kind) {
    case 'invalid_model': return new AIError(400, kind, `選んだモデルを確認してください${detail}`);
    case 'input_too_long': return new AIError(413, kind, `対象の記事を減らすか、扱える長さの大きいモデルを選んでください${detail}`);
    case 'unsupported_effort': return new AIError(400, kind, `このモデルは推論の深さの指定に対応していません。『モデルに任せる』を選んでください${detail}`);
    case 'rate_limited': return new AIError(429, kind, 'AIの利用が集中しているか、APIの利用枠に達しました。時間をおいてお試しください。');
    case 'provider_error': return new AIError(502, kind, 'AIサービスに接続できませんでした。接続設定と利用状況を確認してください。');
  }
}
