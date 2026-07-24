import { Injectable } from "@nestjs/common";
import { GatewayAdapter, GatewayReadiness, GatewayUsageReport, IssuedKey, SpendRecord } from "./gateway-adapter";
import { randomId } from "../common/crypto";

/** Offline/dev adapter — lets enroll/heartbeat/fleet be built + tested without a running LiteLLM. */
@Injectable()
export class MockGatewayAdapter implements GatewayAdapter {
  private readonly spend = new Map<string, number>();
  private readonly models = new Map<string, string[]>();

  async issueKey({ alias, expiresAt, model, models }: Parameters<GatewayAdapter["issueKey"]>[0]): Promise<IssuedKey> {
    this.spend.set(alias, 0);
    this.models.set(alias, models?.length ? [...new Set(models)] : model ? [model] : []);
    return { key: randomId("sk-hara-mock-"), keyId: alias, expiresAt };
  }

  async syncKeyModels(keyId: string, models: string[]): Promise<string[]> {
    const normalized = [...new Set(models)];
    this.models.set(keyId, normalized);
    return normalized;
  }

  async revokeKey(keyId: string): Promise<void> {
    this.spend.delete(keyId);
    this.models.delete(keyId);
  }

  async listSpend(keyIds: string[]): Promise<SpendRecord[]> {
    return keyIds.map((keyId) => ({ keyId, spend: this.spend.get(keyId) ?? 0 }));
  }

  async usage(): Promise<GatewayUsageReport> {
    return { available: true, buckets: [], rolling: [] };
  }

  async readiness(): Promise<GatewayReadiness> {
    return { ok: true };
  }
}
