import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminRole, DesktopCrashReportStatus } from "@prisma/client";
import { AdminAuthGuard, Roles, type AuthedUser } from "../common/admin-auth.guard";
import { CrashReportsService } from "./crash-reports.service";
import { SubmitDesktopCrashReportDto, UpdateDesktopCrashReportDto } from "./dto";

@Controller("v1/desktop/crash-reports")
export class PublicCrashReportsController {
  constructor(private readonly reports: CrashReportsService) {}

  @Post()
  submit(@Body() dto: SubmitDesktopCrashReportDto) {
    return this.reports.submit(dto);
  }
}

@Controller("admin/crash-reports")
@UseGuards(AdminAuthGuard)
@Roles(AdminRole.SUPERADMIN)
export class AdminCrashReportsController {
  constructor(private readonly reports: CrashReportsService) {}

  @Get()
  list(
    @Query("status") status?: DesktopCrashReportStatus,
    @Query("limit") limit?: string,
  ) {
    return this.reports.list(status, Number(limit || 100));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.reports.get(id);
  }

  @Post(":id/retry-alert")
  retryAlert(@Param("id") id: string) {
    return this.reports.retryAlert(id);
  }

  @Patch(":id")
  update(
    @Req() req: { user?: AuthedUser },
    @Param("id") id: string,
    @Body() dto: UpdateDesktopCrashReportDto,
  ) {
    return this.reports.update(id, dto, req.user!);
  }
}
