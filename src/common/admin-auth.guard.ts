import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { verifyJwt } from "./crypto";

/**
 * Gate /admin/* + /auth/me on EITHER a JWT (Authorization: Bearer …) OR the shared admin key
 * (x-admin-key: HARA_CONTROL_ADMIN_KEY). The shared key path is intentionally kept (Phase 1 of
 * docs/AUTH_SPEC.md) — back-compat for existing operators + CLIs until SSO lands.
 *
 * RBAC: SUPERADMIN ≥ ADMIN ≥ MEMBER. A route's required role is set via `@Roles('ROLE')`. Default
 * when unannotated = ADMIN (most /admin/* endpoints). The shared-key bearer is treated as SUPERADMIN.
 */

export const ROLES_KEY = "hara.required_role";
export const Roles = (role: AdminRole | keyof typeof AdminRole): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, role as AdminRole);

const RANK: Record<AdminRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  SUPERADMIN: 3,
};

/** Resolve the JWT secret. Falls back to the shared admin key so single-key deploys keep working. */
export function jwtSecret(): string {
  const s = process.env.HARA_JWT_SECRET || process.env.HARA_CONTROL_ADMIN_KEY;
  if (!s) throw new UnauthorizedException("HARA_JWT_SECRET or HARA_CONTROL_ADMIN_KEY must be configured");
  return s;
}

export interface AuthedUser {
  id: string;
  email: string;
  role: AdminRole;
  orgId?: string | null;
  /** true when authenticated via the shared admin key rather than a JWT. */
  viaSharedKey?: boolean;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: AuthedUser;
    }>();

    const required = this.reflector.getAllAndOverride<AdminRole | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? AdminRole.ADMIN;

    // Path 1: shared admin key → SUPERADMIN (back-compat, defense-in-depth on top of network lock).
    const sharedKey = process.env.HARA_CONTROL_ADMIN_KEY;
    if (sharedKey && req.headers["x-admin-key"] === sharedKey) {
      req.user = {
        id: "shared-key",
        email: "shared-key@local",
        role: AdminRole.SUPERADMIN,
        viaSharedKey: true,
      };
      return true;
    }

    // Path 2: JWT bearer → decode → load user → enforce disabledAt + role.
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) throw new UnauthorizedException("missing credentials");
    const token = auth.slice(7);
    const payload = verifyJwt(token, jwtSecret());
    if (!payload) throw new UnauthorizedException("invalid or expired token");

    const user = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException("user not found");
    if (user.disabledAt) throw new UnauthorizedException("user disabled");
    if (RANK[user.role] < RANK[required]) throw new ForbiddenException(`requires ${required}`);

    req.user = { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
    return true;
  }
}
