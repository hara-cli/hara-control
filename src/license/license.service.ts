import { ForbiddenException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { LicenseClaims, LicenseStatus, licenseStatus, verifyLicense } from "./license";
import { isSaas, isSelf } from "../config/deploy";
import { PrismaService } from "../prisma/prisma.service";

/** Holds the verified license (self-deploy) and answers entitlement questions offline. */
@Injectable()
export class LicenseService implements OnModuleInit {
  private readonly log = new Logger(LicenseService.name);
  private claims: LicenseClaims | null = null;
  private readonly devBypass = process.env.HARA_LICENSE_DEV === "1";

  onModuleInit() {
    const token = process.env.HARA_LICENSE;
    const pub = process.env.HARA_LICENSE_PUBKEY;
    if (token && pub) {
      try {
        this.claims = verifyLicense(pub, token); // signature verified OFFLINE — no hub call
        this.log.log(
          `license ok: plan=${this.claims.plan} seats=${this.claims.seatLimit || "∞"} features=[${this.claims.features.join(",")}] status=${this.status()}`,
        );
      } catch (e) {
        this.log.error(`license verification failed: ${(e as Error).message}`);
        if (isSelf() && !this.devBypass) throw e; // self-deploy: a bad license is fatal at boot
      }
    } else if (isSelf() && !this.devBypass) {
      this.log.warn("no HARA_LICENSE configured — set HARA_LICENSE_DEV=1 for unlicensed dev/CI.");
    }
  }

  status(nowSec = Math.floor(Date.now() / 1000)): LicenseStatus | "dev" | "saas" | "none" {
    if (this.devBypass) return "dev";
    if (isSaas()) return "saas";
    if (!this.claims) return "none";
    return licenseStatus(this.claims, nowSec);
  }

  getClaims(): LicenseClaims | null {
    return this.claims;
  }

  hasFeature(feature: string): boolean {
    if (this.devBypass || isSaas()) return true; // saas: hub manages entitlement (MVP permissive)
    if (!this.claims) return false;
    const st = licenseStatus(this.claims, Math.floor(Date.now() / 1000));
    if (st === "expired" || st === "not_yet_valid") return false; // grace still serves
    return this.claims.features.includes(feature);
  }

  seatLimit(): number {
    // 0 = unlimited
    if (this.devBypass || isSaas() || !this.claims) return 0;
    return this.claims.seatLimit;
  }
}

/** Gates feature use + seat counts. In saas mode the hub owns this (MVP: permissive). */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly license: LicenseService,
    private readonly prisma: PrismaService,
  ) {}

  assert(feature: string): void {
    if (!this.license.hasFeature(feature)) {
      throw new ForbiddenException(`license does not include feature "${feature}" (or it is expired)`);
    }
  }

  async seatCheck(orgId: string): Promise<void> {
    const limit = this.license.seatLimit();
    if (!limit) return; // unlimited / dev / saas
    const seats = await this.prisma.device.count({ where: { orgId } });
    if (seats >= limit) {
      throw new ForbiddenException(`seat limit reached (${seats}/${limit}) — revoke a device or upgrade`);
    }
  }
}
