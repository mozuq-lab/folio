declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    AI?: Ai;
    BUCKET?: R2Bucket;
  }
}
