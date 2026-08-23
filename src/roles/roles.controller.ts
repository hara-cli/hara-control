import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { RolesService } from "./roles.service";
import {
  AdminAuthGuard,
  assertAdminOrgAccess,
  type AuthedUser,
} from "../common/admin-auth.guard";
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

interface RequestWithUser {
  user?: AuthedUser;
}

// Operator-facing role/digital-employee governance. Auth guard accepts JWT or shared admin key.
@Controller("admin")
@UseGuards(AdminAuthGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post("roles")
  createRole(@Req() request: RequestWithUser, @Body() d: CreateRoleDto) {
    assertAdminOrgAccess(request.user!, d.orgId);
    return this.roles.createRole(d.orgId, d, request.user!);
  }
  @Get("roles")
  listRoles(@Req() request: RequestWithUser, @Query("orgId") orgId: string) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.roles.listRoles(orgId);
  }
  @Patch("roles/:id")
  async updateRole(@Req() request: RequestWithUser, @Param("id") id: string, @Body() d: UpdateRoleDto) {
    assertAdminOrgAccess(request.user!, await this.roles.roleOrgId(id));
    return this.roles.updateRole(id, d, request.user!);
  }
  @Delete("roles/:id")
  async archiveRole(@Req() request: RequestWithUser, @Param("id") id: string) {
    assertAdminOrgAccess(request.user!, await this.roles.roleOrgId(id));
    return this.roles.archiveRole(id, request.user!);
  }

  @Post("persons")
  createPerson(@Req() request: RequestWithUser, @Body() d: CreatePersonDto) {
    assertAdminOrgAccess(request.user!, d.orgId);
    return this.roles.createPerson(d.orgId, d.email, d.name, request.user!);
  }

  @Post("teams")
  createTeam(@Req() request: RequestWithUser, @Body() d: CreateTeamDto) {
    assertAdminOrgAccess(request.user!, d.orgId);
    return this.roles.createTeam(d.orgId, d.name, request.user!);
  }
  @Post("teams/:id/members")
  async addMember(@Req() request: RequestWithUser, @Param("id") id: string, @Body() d: AddMemberDto) {
    assertAdminOrgAccess(request.user!, await this.roles.teamOrgId(id));
    return this.roles.addTeamMember(id, d.personId, request.user!);
  }
  @Patch("teams/:id/policy")
  async teamPolicy(@Req() request: RequestWithUser, @Param("id") id: string, @Body() d: PolicyDto) {
    assertAdminOrgAccess(request.user!, await this.roles.teamOrgId(id));
    return this.roles.setTeamPolicy(id, d.policy, request.user!);
  }

  // 角色分配 — the digital-employee verb
  @Post("assignments")
  assign(@Req() request: RequestWithUser, @Body() d: CreateAssignmentDto) {
    assertAdminOrgAccess(request.user!, d.orgId);
    return this.roles.createAssignment(d.orgId, d.roleId, d, request.user!);
  }
  @Delete("assignments/:id")
  async unassign(@Req() request: RequestWithUser, @Param("id") id: string) {
    assertAdminOrgAccess(request.user!, await this.roles.assignmentOrgId(id));
    return this.roles.deleteAssignment(id, request.user!);
  }
  @Patch("assignments/:id")
  async updateAssign(@Req() request: RequestWithUser, @Param("id") id: string, @Body() d: UpdateAssignmentDto) {
    assertAdminOrgAccess(request.user!, await this.roles.assignmentOrgId(id));
    return this.roles.updateAssignment(id, d, request.user!);
  }

  @Patch("orgs/:id/policy")
  orgPolicy(@Req() request: RequestWithUser, @Param("id") id: string, @Body() d: PolicyDto) {
    assertAdminOrgAccess(request.user!, id);
    return this.roles.setOrgPolicy(id, d.policy, request.user!);
  }

  @Get("digital-employees")
  listDigitalEmployees(@Req() request: RequestWithUser, @Query("orgId") orgId: string) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.roles.listDigitalEmployees(orgId);
  }

  // preview exactly what a device will run — the governance trust anchor
  @Get("devices/:id/bundle")
  async deviceBundle(@Req() request: RequestWithUser, @Param("id") id: string) {
    assertAdminOrgAccess(request.user!, await this.roles.deviceOrgId(id));
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
