import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  AdminAuthGuard,
  assertAdminOrgAccess,
  AuthedUser,
} from "../common/admin-auth.guard";
import { UpsertTenantServiceBindingDto } from "./dto";
import { TenantServiceBindingsService } from "./service-bindings.service";

interface RequestWithUser {
  user?: AuthedUser;
}

@Controller("admin/orgs/:orgId/service-bindings")
@UseGuards(AdminAuthGuard)
export class TenantServiceBindingsController {
  constructor(private readonly bindings: TenantServiceBindingsService) {}

  @Get()
  list(
    @Req() request: RequestWithUser,
    @Param("orgId") orgId: string,
  ) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.bindings.list(orgId);
  }

  @Put(":service")
  upsert(
    @Req() request: RequestWithUser,
    @Param("orgId") orgId: string,
    @Param("service") service: string,
    @Body() body: UpsertTenantServiceBindingDto,
  ) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.bindings.upsert(orgId, service, body, request.user!);
  }

  @Post(":service/verify")
  verify(
    @Req() request: RequestWithUser,
    @Param("orgId") orgId: string,
    @Param("service") service: string,
  ) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.bindings.verify(orgId, service, request.user!);
  }

  @Post(":service/disable")
  disable(
    @Req() request: RequestWithUser,
    @Param("orgId") orgId: string,
    @Param("service") service: string,
  ) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.bindings.disable(orgId, service, request.user!);
  }
}
