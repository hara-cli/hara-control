import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { AdminService } from "./admin.service";
import { AdminAuthGuard, assertAdminOrgAccess, AuthedUser } from "../common/admin-auth.guard";
import { BindDevicePersonDto, CreateEnrollCodeDto, CreateOrgDto } from "../protocol/dto";
import {
  defaultManagedModel,
  managedModelOptions,
} from "../providers/model-policy";

// Operator-facing endpoints — gated by AdminAuthGuard (JWT OR back-compat x-admin-key).
// Default required role = ADMIN (set in the guard). User-mgmt (SUPERADMIN) lives in AuthModule.
@Controller("admin")
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post("orgs")
  createOrg(@Req() req: { user?: AuthedUser }, @Body() dto: CreateOrgDto) {
    return this.admin.createOrg(dto.name, req.user!, dto.type, dto.parentId);
  }

  @Get("orgs")
  listOrgs(@Req() req: { user?: AuthedUser }) {
    const user = req.user!;
    const global = user.role === AdminRole.SUPERADMIN || user.viaSharedKey === true;
    if (!global && !user.orgId) throw new ForbiddenException("organization access denied");
    return this.admin.listOrgs(user.orgId ?? null, global);
  }

  /** Non-secret, deployment-authoritative choices for new device keys. Keeping this beside the
   * enrollment endpoint lets both SUPERADMIN and tenant ADMIN users render the same allow-list that
   * createEnrollCode enforces instead of accepting an undocumented free-text alias. */
  @Get("model-options")
  modelOptions() {
    return {
      defaultModel: defaultManagedModel(),
      models: managedModelOptions(),
    };
  }

  /** Ancestor chain (leaf-first: [self … root]) for an org unit — where it sits in the hierarchy. */
  @Get("orgs/:id/ancestors")
  orgAncestors(@Req() req: { user?: AuthedUser }, @Param("id") id: string) {
    return this.admin.orgAncestors(id, req.user!);
  }

  /** All unit ids in the subtree incl. self (e.g. a company + all its departments). */
  @Get("orgs/:id/subtree")
  orgSubtree(@Req() req: { user?: AuthedUser }, @Param("id") id: string) {
    return this.admin.orgSubtree(id, req.user!);
  }

  @Post("enroll-codes")
  createEnrollCode(@Req() req: { user?: AuthedUser }, @Body() dto: CreateEnrollCodeDto) {
    const user = req.user!;
    assertAdminOrgAccess(user, dto.orgId);
    if (dto.tokenNeverExpires && user.role !== AdminRole.SUPERADMIN && !user.viaSharedKey) {
      throw new ForbiddenException("non-expiring keys require SUPERADMIN");
    }
    return this.admin.createEnrollCode(
      dto.orgId,
      dto.model ?? "",
      dto.baseUrl,
      dto.ttlMinutes ?? 60,
      dto.personId,
      user,
      {
        reasoningEffort: dto.reasoningEffort,
        tokenTtlMinutes: dto.tokenTtlMinutes,
        tokenNeverExpires: dto.tokenNeverExpires,
        budgetLimits: dto.budgetLimits,
        rpmLimit: dto.rpmLimit,
        tpmLimit: dto.tpmLimit,
      },
    );
  }

  @Get("fleet")
  fleet(@Req() req: { user?: AuthedUser }, @Query("orgId") orgId: string) {
    assertAdminOrgAccess(req.user!, orgId);
    return this.admin.fleet(orgId);
  }

  @Get("usage")
  usage(
    @Req() req: { user?: AuthedUser },
    @Query("orgId") orgId: string,
    @Query("range") range?: string,
  ) {
    assertAdminOrgAccess(req.user!, orgId);
    return this.admin.usage(orgId, range);
  }

  @Post("devices/:id/revoke")
  revoke(@Req() req: { user?: AuthedUser }, @Param("id") id: string) {
    return this.admin.revokeDevice(id, req.user!);
  }

  @Patch("devices/:id/person")
  bindPerson(
    @Req() req: { user?: AuthedUser },
    @Param("id") id: string,
    @Body() dto: BindDevicePersonDto,
  ) {
    return this.admin.bindDevicePerson(id, dto.personId, req.user!);
  }

  /** Verify the org's tamper-evident audit hash chain (compliance integrity check). */
  @Get("audit/verify")
  verifyAudit(@Req() req: { user?: AuthedUser }, @Query("orgId") orgId: string) {
    assertAdminOrgAccess(req.user!, orgId);
    return this.admin.verifyAudit(orgId);
  }
}
