import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { RolesService } from "./roles.service";
import { AdminKeyGuard } from "../common/admin-key.guard";
import {
  AddMemberDto,
  CreateAssignmentDto,
  CreatePersonDto,
  CreateRoleDto,
  CreateTeamDto,
  PolicyDto,
  UpdateAssignmentDto,
  UpdateRoleDto,
} from "./dto";

const bearer = (h?: string): string | undefined => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

// Operator-facing role/digital-employee governance. admin-key gated (Phase 2 → OIDC/RBAC).
@Controller("admin")
@UseGuards(AdminKeyGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post("roles")
  createRole(@Body() d: CreateRoleDto) {
    return this.roles.createRole(d.orgId, d);
  }
  @Get("roles")
  listRoles(@Query("orgId") orgId: string) {
    return this.roles.listRoles(orgId);
  }
  @Patch("roles/:id")
  updateRole(@Param("id") id: string, @Body() d: UpdateRoleDto) {
    return this.roles.updateRole(id, d);
  }
  @Delete("roles/:id")
  archiveRole(@Param("id") id: string) {
    return this.roles.archiveRole(id);
  }

  @Post("persons")
  createPerson(@Body() d: CreatePersonDto) {
    return this.roles.createPerson(d.orgId, d.email, d.name);
  }

  @Post("teams")
  createTeam(@Body() d: CreateTeamDto) {
    return this.roles.createTeam(d.orgId, d.name);
  }
  @Post("teams/:id/members")
  addMember(@Param("id") id: string, @Body() d: AddMemberDto) {
    return this.roles.addTeamMember(id, d.personId);
  }
  @Patch("teams/:id/policy")
  teamPolicy(@Param("id") id: string, @Body() d: PolicyDto) {
    return this.roles.setTeamPolicy(id, d.policy);
  }

  // 角色分配 — the digital-employee verb
  @Post("assignments")
  assign(@Body() d: CreateAssignmentDto) {
    return this.roles.createAssignment(d.orgId, d.roleId, d);
  }
  @Delete("assignments/:id")
  unassign(@Param("id") id: string) {
    return this.roles.deleteAssignment(id);
  }
  @Patch("assignments/:id")
  updateAssign(@Param("id") id: string, @Body() d: UpdateAssignmentDto) {
    return this.roles.updateAssignment(id, d);
  }

  @Patch("orgs/:id/policy")
  orgPolicy(@Param("id") id: string, @Body() d: PolicyDto) {
    return this.roles.setOrgPolicy(id, d.policy);
  }

  @Get("digital-employees")
  listDigitalEmployees(@Query("orgId") orgId: string) {
    return this.roles.listDigitalEmployees(orgId);
  }

  // preview exactly what a device will run — the governance trust anchor
  @Get("devices/:id/bundle")
  deviceBundle(@Param("id") id: string) {
    return this.roles.resolveBundleForDevice(id);
  }
}

// Device-facing: a hara device pulls its governance-trimmed role set with its device token.
@Controller("v1")
export class RolesDeviceController {
  constructor(private readonly roles: RolesService) {}

  @Get("roles")
  getRoles(@Headers("authorization") auth?: string) {
    return this.roles.bundleForBearer(bearer(auth));
  }
}
