import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";

export interface ReadinessResult {
  status: "ok" | "not_ready";
  checks: {
    database: boolean;
    gateway: boolean;
    configuration: boolean;
  };
}

/**
 * Public probes intentionally return booleans only. Configuration values, database errors and
 * upstream response bodies stay server-side so /health cannot become a credential/config oracle.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
  ) {}

  live(): { status: "ok" } {
    return { status: "ok" };
  }

  private configurationReady(): boolean {
    if (!process.env.DATABASE_URL) return false;
    if (process.env.GATEWAY_ADAPTER !== "litellm") return true;
    return Boolean(
      process.env.LITELLM_URL &&
        process.env.LITELLM_MASTER_KEY &&
        process.env.LITELLM_DATABASE_URL,
    );
  }

  async ready(): Promise<ReadinessResult> {
    const [database, gateway] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      ),
      this.gateway.readiness().then(
        (result) => result.ok,
        () => false,
      ),
    ]);
    const configuration = this.configurationReady();
    return {
      status: database && gateway && configuration ? "ok" : "not_ready",
      checks: { database, gateway, configuration },
    };
  }
}
