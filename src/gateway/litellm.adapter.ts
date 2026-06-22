import { Injectable, Logger } from "@nestjs/common";
import { GatewayAdapter, IssuedKey, SpendRecord } from "./gateway-adapter";

// Talks to the embedded LiteLLM proxy's admin API. The device token IS a LiteLLM virtual key scoped
// to a model; the real provider key stays inside LiteLLM. We never store the raw key — revocation is
// keyed off the alias we set (= the device id).
@Injectable()
export class LiteLLMAdapter implements GatewayAdapter {
  private readonly log = new Logger(LiteLLMAdapter.name);
  private readonly base = (process.env.LITELLM_URL || "http://localhost:4000").replace(/\/$/, "");
  private readonly masterKey = process.env.LITELLM_MASTER_KEY || "";

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.masterKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LiteLLM ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async issueKey({ model, alias, metadata }: { model: string; alias: string; metadata?: Record<string, unknown> }): Promise<IssuedKey> {
    const j = await this.call("/key/generate", { models: model ? [model] : [], key_alias: alias, metadata: metadata ?? {} });
    return { key: String(j.key), keyId: alias };
  }

  async revokeKey(keyId: string): Promise<void> {
    await this.call("/key/delete", { key_aliases: [keyId] });
  }

  async listSpend(keyIds: string[]): Promise<SpendRecord[]> {
    if (!keyIds.length) return [];
    try {
      // shape varies across LiteLLM versions; tolerate + fall back to zero. The authoritative usage
      // join (spend tables in the shared Postgres) lands once LiteLLM runs against our PG.
      const j = await this.call("/key/info", { key_aliases: keyIds });
      const rows = Array.isArray((j as { keys?: unknown }).keys) ? ((j as { keys: Record<string, unknown>[] }).keys) : [];
      return rows.map((r) => ({ keyId: String(r.key_alias ?? ""), spend: Number(r.spend ?? 0) }));
    } catch (e) {
      this.log.warn(`spend lookup failed: ${(e as Error).message}`);
      return keyIds.map((keyId) => ({ keyId, spend: 0 }));
    }
  }
}
