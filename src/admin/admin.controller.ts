import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { CreateEnrollCodeDto, CreateOrgDto } from "../protocol/dto";

// Operator-facing endpoints — gated by AdminAuthGuard (JWT OR back-compat x-admin-key).
// Default required role = ADMIN (set in the guard). User-mgmt (SUPERADMIN) lives in AuthModule.
@Controller("admin")
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post("orgs")
  createOrg(@Body() dto: CreateOrgDto) {
    return this.admin.createOrg(dto.name, dto.type, dto.parentId);
  }

  /** Ancestor chain (leaf-first: [self … root]) for an org unit — where it sits in the hierarchy. */
  @Get("orgs/:id/ancestors")
  orgAncestors(@Param("id") id: string) {
    return this.admin.orgAncestors(id);
  }

  /** All unit ids in the subtree incl. self (e.g. a company + all its departments). */
  @Get("orgs/:id/subtree")
  orgSubtree(@Param("id") id: string) {
    return this.admin.orgSubtree(id);
  }

  @Post("enroll-codes")
  createEnrollCode(@Body() dto: CreateEnrollCodeDto) {
    return this.admin.createEnrollCode(
      dto.orgId,
      dto.model,
      dto.baseUrl,
      dto.ttlMinutes,
      dto.personId,
      {
        tokenTtlMinutes: dto.tokenTtlMinutes,
        budgetLimits: dto.budgetLimits,
        rpmLimit: dto.rpmLimit,
        tpmLimit: dto.tpmLimit,
      },
    );
  }

  @Get("fleet")
  fleet(@Query("orgId") orgId: string) {
    return this.admin.fleet(orgId);
  }

  @Post("devices/:id/revoke")
  revoke(@Param("id") id: string) {
    return this.admin.revokeDevice(id);
  }

  /** Verify the org's tamper-evident audit hash chain (compliance integrity check). */
  @Get("audit/verify")
  verifyAudit(@Query("orgId") orgId: string) {
    return this.admin.verifyAudit(orgId);
  }
}
