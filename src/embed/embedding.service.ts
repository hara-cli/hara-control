import { Injectable, Logger } from "@nestjs/common";
import { safeFetch } from "../security/ssrf";

// Configurable embedder (per the owner's decision: local OR remote, not pinned). Points at any
// OpenAI-compatible /embeddings endpoint via env:
//   HARA_EMBED_BASE_URL  e.g. http://localhost:4000/v1 (LiteLLM gateway, remote Qwen)
//                        or   http://localhost:11434/v1 (local ollama)
//   HARA_EMBED_MODEL     e.g. text-embedding-v3 (1024) | nomic-embed-text (768)
//   HARA_EMBED_API_KEY   optional bearer
// If unconfigured, embeddings are DISABLED and search falls back to the lexical floor — the
// zero-dependency, always-works path the doctrine preserves.
@Injectable()
export class EmbeddingService {
  private readonly log = new Logger(EmbeddingService.name);
  private readonly base = (process.env.HARA_EMBED_BASE_URL || "").replace(/\/$/, "");
  private readonly model = process.env.HARA_EMBED_MODEL || "";
  private readonly key = process.env.HARA_EMBED_API_KEY || "";

  enabled(): boolean {
    return Boolean(this.base && this.model);
  }
  modelId(): string {
    return this.model;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.enabled() || texts.length === 0) return null;
    // SSRF guard: HARA_EMBED_BASE_URL is operator-config but may point anywhere — validate it (and
    // any redirect) before the request leaves the box. See src/security/ssrf.ts.
    const res = await safeFetch(`${this.base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data.map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[] | null> {
    const v = await this.embed([text]);
    return v ? v[0] : null;
  }

  /** pgvector literal form: '[1,2,3]'. */
  static toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
