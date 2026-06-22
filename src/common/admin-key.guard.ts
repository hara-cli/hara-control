import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/** Gate /admin/* on a shared admin key (header `x-admin-key`). Phase 2 swaps this for OIDC/RBAC. */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const expected = process.env.HARA_CONTROL_ADMIN_KEY;
    if (!expected) throw new UnauthorizedException("HARA_CONTROL_ADMIN_KEY not configured");
    if (req.headers["x-admin-key"] !== expected) throw new UnauthorizedException("bad admin key");
    return true;
  }
}
