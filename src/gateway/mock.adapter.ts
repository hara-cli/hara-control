import { Injectable } from "@nestjs/common";
import { GatewayAdapter, IssuedKey, SpendRecord } from "./gateway-adapter";
import { randomId } from "../common/crypto";

/** Offline/dev adapter — lets enroll/heartbeat/fleet be built + tested without a running LiteLLM. */
@Injectable()
export class MockGatewayAdapter implements GatewayAdapter {
  private readonly spend = new Map<string, number>();

  async issueKey({ alias }: { model: string; alias: string }): Promise<IssuedKey> {
    this.spend.set(alias, 0);
    return { key: randomId("sk-hara-mock-"), keyId: alias };
  }

  async revokeKey(keyId: string): Promise<void> {
    this.spend.delete(keyId);
  }

  async listSpend(keyIds: string[]): Promise<SpendRecord[]> {
    return keyIds.map((keyId) => ({ keyId, spend: this.spend.get(keyId) ?? 0 }));
  }
}
