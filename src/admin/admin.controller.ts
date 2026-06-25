import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminKeyGuard } from "../common/admin-key.guard";
import { CreateEnrollCodeDto, CreateOrgDto } from "../protocol/dto";

// Operator-facing endpoints — gated by the admin key. Phase 2 swaps the guard for OIDC/RBAC.
@Controller("admin")
@UseGuards(AdminKeyGuard)
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
    return this.admin.createEnrollCode(dto.orgId, dto.model, dto.baseUrl, dto.ttlMinutes, dto.personId);
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
