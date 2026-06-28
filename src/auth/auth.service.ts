import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { AdminRole, AdminUser } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { genTotpSecret, hashPassword, signJwt, totpUri, verifyPassword, verifyTotp } from "../common/crypto";
import { jwtSecret } from "../common/admin-auth.guard";

const JWT_TTL_SEC = 8 * 60 * 60; // 8h — re-login after; no refresh token (Phase 1)
const MIN_PASSWORD_LEN = 12;

// In-memory rate limit. Keyed by `${ip}|${email}` to defeat per-key spray + per-account spray.
// Single-node only; multi-node deploys swap this for a shared store (Phase 3 + SSO).
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const failures = new Map<string, { count: number; firstAt: number }>();

function checkRateLimit(ip: string, email: string): void {
  const key = `${ip}|${email.toLowerCase()}`;
  const now = Date.now();
  const rec = failures.get(key);
  if (rec && now - rec.firstAt < FAIL_WINDOW_MS && rec.count >= FAIL_LIMIT) {
    throw new ForbiddenException("too many failed attempts, try again in a minute");
  }
}

function recordFailure(ip: string, email: string): void {
  const key = `${ip}|${email.toLowerCase()}`;
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now - rec.firstAt >= FAIL_WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
  } else {
    rec.count++;
  }
}

function clearFailures(ip: string, email: string): void {
  failures.delete(`${ip}|${email.toLowerCase()}`);
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** First-run only: create the one SUPERADMIN. Gated by the shared admin key + count==0 invariant. */
  async bootstrapSuperadmin(email: string, password: string): Promise<{ id: string; email: string; role: AdminRole }> {
    if (password.length < MIN_PASSWORD_LEN) throw new BadRequestException(`password must be ≥${MIN_PASSWORD_LEN} chars`);
    const count = await this.prisma.adminUser.count();
    if (count > 0) throw new ConflictException("superadmin already exists — use /admin/users instead");
    const user = await this.prisma.adminUser.create({
      data: { email: email.toLowerCase(), passwordHash: hashPassword(password), role: AdminRole.SUPERADMIN },
    });
    return { id: user.id, email: user.email, role: user.role };
  }

  /**
   * Verify credentials → JWT (8h). Rate-limited per IP+email. Two-step when TOTP is enabled:
   *   1) password OK, no `code` → `{ requires_2fa: true }` (200, no token). Doesn't count as a
   *      failure — it's the expected first leg of the dance.
   *   2) password OK + `code` valid → JWT.
   *   x) wrong password OR (password OK + present-but-wrong `code`) → 401 + counted failure.
   */
  async login(
    ip: string,
    email: string,
    password: string,
    code?: string,
  ): Promise<
    | { access_token: string; role: AdminRole; email: string; expires_in: number }
    | { requires_2fa: true }
  > {
    checkRateLimit(ip, email);
    const user = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.disabledAt || !verifyPassword(password, user.passwordHash)) {
      recordFailure(ip, email);
      throw new UnauthorizedException("invalid credentials");
    }
    if (user.totpSecret) {
      if (!code) {
        // Expected 2-step intermediate — DO NOT count as a failure or clear the counter.
        return { requires_2fa: true };
      }
      if (!verifyTotp(user.totpSecret, code)) {
        // Wrong code IS a credential attempt; count toward rate limit + bubble 401.
        recordFailure(ip, email);
        throw new UnauthorizedException("invalid 2fa code");
      }
    }
    clearFailures(ip, email);
    const token = signJwt({ sub: user.id, email: user.email, role: user.role }, jwtSecret(), JWT_TTL_SEC);
    return { access_token: token, role: user.role, email: user.email, expires_in: JWT_TTL_SEC };
  }

  /** Whoami. The caller is already authenticated by AdminAuthGuard — we just shape the payload. */
  async me(user: { id: string; email: string; role: AdminRole; orgId?: string | null }): Promise<{
    id: string;
    email: string;
    role: AdminRole;
    orgId: string | null;
    twofa_enabled: boolean;
  }> {
    // The shared-key pseudo-user has no DB row; report 2FA off for it.
    let twofa = false;
    if (user.id && user.id !== "shared-key") {
      const row = await this.prisma.adminUser.findUnique({
        where: { id: user.id },
        select: { totpSecret: true },
      });
      twofa = !!row?.totpSecret;
    }
    return { id: user.id, email: user.email, role: user.role, orgId: user.orgId ?? null, twofa_enabled: twofa };
  }

  // ── 2FA (TOTP, RFC 6238) ────────────────────────────────────────────────────────────────────
  // The console is going public — passwords alone are not enough. TOTP via node:crypto, no deps.
  // Setup is intentionally stateless: we generate + return the secret but DON'T persist until the
  // user proves possession in /enable. That avoids half-enrolled rows if the user bails mid-setup.

  /** Begin enrollment: return a fresh secret + otpauth URI for the caller to scan/paste. Not persisted. */
  startTotpSetup(user: { id: string; email: string }): { secret: string; otpauth_uri: string } {
    if (!user.id || user.id === "shared-key") {
      // The shared-key bearer is a pseudo-user with no DB row to persist a secret onto.
      throw new BadRequestException("the shared admin key cannot enroll TOTP — sign in as a real account first");
    }
    const secret = genTotpSecret();
    return { secret, otpauth_uri: totpUri(secret, user.email) };
  }

  /** Finish enrollment: verify the code against the *client-echoed* secret, then persist it. */
  async enableTotp(userId: string, secret: string, code: string): Promise<{ ok: true }> {
    if (!userId || userId === "shared-key") {
      throw new BadRequestException("the shared admin key cannot enroll TOTP — sign in as a real account first");
    }
    if (!verifyTotp(secret, code)) throw new BadRequestException("invalid code — check the time on the authenticator");
    await this.prisma.adminUser.update({ where: { id: userId }, data: { totpSecret: secret } });
    return { ok: true };
  }

  /** Turn TOTP off after proving possession of a current code. */
  async disableTotp(userId: string, code: string): Promise<{ ok: true }> {
    if (!userId || userId === "shared-key") {
      throw new BadRequestException("the shared admin key has no TOTP to disable");
    }
    const row = await this.prisma.adminUser.findUnique({ where: { id: userId }, select: { totpSecret: true } });
    if (!row?.totpSecret) throw new BadRequestException("2fa is not enabled");
    if (!verifyTotp(row.totpSecret, code)) throw new BadRequestException("invalid code");
    await this.prisma.adminUser.update({ where: { id: userId }, data: { totpSecret: null } });
    return { ok: true };
  }

  // ── User management (SUPERADMIN only) ────────────────────────────────────────────────────────

  async listUsers(): Promise<Array<Pick<AdminUser, "id" | "email" | "role" | "orgId" | "disabledAt" | "createdAt">>> {
    return this.prisma.adminUser.findMany({
      select: { id: true, email: true, role: true, orgId: true, disabledAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async createUser(email: string, password: string, role: AdminRole, orgId?: string) {
    if (password.length < MIN_PASSWORD_LEN) throw new BadRequestException(`password must be ≥${MIN_PASSWORD_LEN} chars`);
    const existing = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw new ConflictException("email already in use");
    const user = await this.prisma.adminUser.create({
      data: { email: email.toLowerCase(), passwordHash: hashPassword(password), role, orgId: orgId ?? null },
      select: { id: true, email: true, role: true, orgId: true, disabledAt: true, createdAt: true },
    });
    return user;
  }

  async updateUser(id: string, patch: { role?: AdminRole; disabled?: boolean; password?: string }) {
    const data: { role?: AdminRole; disabledAt?: Date | null; passwordHash?: string } = {};
    if (patch.role) data.role = patch.role;
    if (patch.disabled !== undefined) data.disabledAt = patch.disabled ? new Date() : null;
    if (patch.password) {
      if (patch.password.length < MIN_PASSWORD_LEN) throw new BadRequestException(`password must be ≥${MIN_PASSWORD_LEN} chars`);
      data.passwordHash = hashPassword(patch.password);
    }
    return this.prisma.adminUser.update({
      where: { id },
      data,
      select: { id: true, email: true, role: true, orgId: true, disabledAt: true, createdAt: true },
    });
  }
}
