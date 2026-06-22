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
    return this.admin.createOrg(dto.name);
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
}
