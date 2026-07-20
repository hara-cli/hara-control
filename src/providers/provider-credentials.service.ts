import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { AuthedUser } from "../common/admin-auth.guard";
import {
  GATEWAY_ADAPTER,
  GatewayAdapter,
} from "../gateway/gateway-adapter";
import { PrismaService } from "../prisma/prisma.service";
import { safeFetch } from "../security/ssrf";
import { SecretsService } from "../security/secrets.service";
import { ProviderCredentialTestTarget } from "./dto";
import { allowedManagedModels } from "./model-policy";

const DEEPSEEK_SECRET = "provider.deepseek.api_key";
const DEEPSEEK_PROBE_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_DIRECT_PROBE_MODEL = "deepseek-v4-flash";

type DeepSeekStatus = {
  provider: "deepseek";
  models: string[];
  stored: boolean;
  stored_at: Date | null;
  storage_readable: boolean;
  runtime_configured: boolean;
  runtime_reachable: boolean;
  active: boolean;
  source: "none" | "runtime" | "encrypted-store" | "encrypted-store+runtime";
  requires_activation: boolean;
  activation: "none" | "deploy-restart-required";
  activated_at: Date | null;
};

@Injectable()
export class ProviderCredentialsService {
  constructor(
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
  ) {}

  async deepSeekStatus(): Promise<DeepSeekStatus> {
    const [metadata, activation] = await Promise.all([
      this.secrets.describe(null, DEEPSEEK_SECRET),
      this.prisma.providerActivation.findUnique({ where: { provider: "deepseek" } }),
    ]);
    let stored: Buffer | null = null;
    let storageReadable = !metadata.exists;
    try {
      if (metadata.exists) stored = await this.secrets.get(null, DEEPSEEK_SECRET);
      storageReadable = !metadata.exists || stored !== null;
    } catch {
      storageReadable = false;
    }

    const runtimeConfigured = Boolean(activation);
    const runtimeReachable = runtimeConfigured
      ? await this.gateway.readiness().then(
          (result) => result.ok,
          () => false,
        )
      : false;
    const active = Boolean(
      metadata.exists &&
        storageReadable &&
        activation &&
        runtimeReachable &&
        activation.secretName === DEEPSEEK_SECRET &&
        activation.secretVersion === metadata.version,
    );
    const source = metadata.exists
      ? runtimeConfigured
        ? "encrypted-store+runtime"
        : "encrypted-store"
      : runtimeConfigured
        ? "runtime"
        : "none";

    stored?.fill(0);

    return {
      provider: "deepseek",
      models: allowedManagedModels(),
      stored: metadata.exists,
      stored_at: metadata.updatedAt,
      storage_readable: storageReadable,
      runtime_configured: runtimeConfigured,
      runtime_reachable: runtimeReachable,
      active,
      source,
      requires_activation: metadata.exists && !active,
      activation: metadata.exists && !active ? "deploy-restart-required" : "none",
      activated_at: activation?.activatedAt ?? null,
    };
  }

  async putDeepSeek(apiKey: string, actor: AuthedUser): Promise<DeepSeekStatus> {
    const plaintext = Buffer.from(apiKey.trim(), "utf8");
    try {
      await this.secrets.putWithSystemAudit(null, DEEPSEEK_SECRET, plaintext, {
        action: "provider.credential.store",
        actorType: actor.viaSharedKey ? "shared-admin-key" : "admin-user",
        actorId: actor.id,
        payload: { provider: "deepseek", operation: "replace" },
      });
    } finally {
      plaintext.fill(0);
    }
    return this.deepSeekStatus();
  }

  async testDeepSeek(
    target: ProviderCredentialTestTarget,
    actor: AuthedUser,
  ): Promise<{ ok: true; provider: "deepseek"; target: ProviderCredentialTestTarget }> {
    const credential =
      target === ProviderCredentialTestTarget.STORED
        ? await this.secrets.get(null, DEEPSEEK_SECRET)
        : null;
    if (target === ProviderCredentialTestTarget.STORED && !credential) {
      throw new BadRequestException(
        "no encrypted DeepSeek credential is stored",
      );
    }

    let ok = false;
    try {
      ok =
        target === ProviderCredentialTestTarget.STORED
          ? await this.probeDeepSeek(credential!)
          : await this.probeActiveGateway();
    } finally {
      credential?.fill(0);
    }
    await this.audit.logSystem(
      "provider.credential.test",
      actor.viaSharedKey ? "shared-admin-key" : "admin-user",
      actor.id,
      { provider: "deepseek", target, ok },
    );
    if (!ok) throw new BadGatewayException("DeepSeek credential check failed");
    return { ok: true, provider: "deepseek", target };
  }

  private async probeDeepSeek(credential: Buffer): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(DEEPSEEK_PROBE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.toString("utf8")}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_DIRECT_PROBE_MODEL,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          stream: false,
        }),
        redirect: "error",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeActiveGateway(): Promise<boolean> {
    const base = (process.env.LITELLM_URL || "").replace(/\/+$/, "");
    const masterKey = process.env.LITELLM_MASTER_KEY;
    if (!base || !masterKey) {
      throw new BadRequestException("no active DeepSeek runtime is configured");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await safeFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${masterKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
