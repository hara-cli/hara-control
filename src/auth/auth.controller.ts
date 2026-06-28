import { Body, Controller, Get, Ip, Patch, Post, Param, Req, UseGuards } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { AuthService } from "./auth.service";
import { AdminAuthGuard, AuthedUser, Roles } from "../common/admin-auth.guard";
import { AdminKeyGuard } from "../common/admin-key.guard";
import { BootstrapSuperadminDto, CreateUserDto, LoginDto, TotpDisableDto, TotpEnableDto, UpdateUserDto } from "./dto";

interface RequestWithUser {
  user?: AuthedUser;
  headers: Record<string, string | undefined>;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** First-run: create the single SUPERADMIN. Gated by the shared admin key + AdminUser count == 0. */
  @Post("bootstrap-superadmin")
  @UseGuards(AdminKeyGuard)
  bootstrap(@Body() dto: BootstrapSuperadminDto) {
    return this.auth.bootstrapSuperadmin(dto.email, dto.password);
  }

  /**
   * Email+password (+ optional 6-digit `code` once 2FA is on) → JWT.
   * If the account has TOTP and no `code` was sent, returns `{ requires_2fa: true }` (200) and
   * the console flips into 2-step mode. Rate-limited per IP+email.
   */
  @Post("login")
  login(@Ip() ip: string, @Body() dto: LoginDto) {
    return this.auth.login(ip || "unknown", dto.email, dto.password, dto.code);
  }

  /** Whoami — works under either auth path (JWT or shared admin key). Includes `twofa_enabled`. */
  @Get("me")
  @UseGuards(AdminAuthGuard)
  @Roles(AdminRole.MEMBER)
  me(@Req() req: RequestWithUser) {
    return this.auth.me(req.user!);
  }

  // ── 2FA (TOTP) — any authed user can manage their own second factor ──────────────────────────

  /** Step 1 of enrollment: server mints a fresh secret + otpauth URI. NOT persisted yet. */
  @Post("2fa/setup")
  @UseGuards(AdminAuthGuard)
  @Roles(AdminRole.MEMBER)
  totpSetup(@Req() req: RequestWithUser) {
    return this.auth.startTotpSetup(req.user!);
  }

  /** Step 2 of enrollment: client echoes back the secret + a current code → we persist on success. */
  @Post("2fa/enable")
  @UseGuards(AdminAuthGuard)
  @Roles(AdminRole.MEMBER)
  totpEnable(@Req() req: RequestWithUser, @Body() dto: TotpEnableDto) {
    return this.auth.enableTotp(req.user!.id, dto.secret, dto.code);
  }

  /** Turn TOTP off after proving possession of a current code. */
  @Post("2fa/disable")
  @UseGuards(AdminAuthGuard)
  @Roles(AdminRole.MEMBER)
  totpDisable(@Req() req: RequestWithUser, @Body() dto: TotpDisableDto) {
    return this.auth.disableTotp(req.user!.id, dto.code);
  }
}

/** /admin/users — SUPERADMIN only. Lives here (not in AdminController) so AuthModule owns user mgmt. */
@Controller("admin/users")
@UseGuards(AdminAuthGuard)
@Roles(AdminRole.SUPERADMIN)
export class AdminUsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list() {
    return this.auth.listUsers();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.auth.createUser(dto.email, dto.password, dto.role, dto.orgId);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    return this.auth.updateUser(id, dto);
  }
}
