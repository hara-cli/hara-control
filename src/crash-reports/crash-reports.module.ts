import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import {
  AdminCrashReportsController,
  PublicCrashReportsController,
} from "./crash-reports.controller";
import { CrashReportsService } from "./crash-reports.service";
import { CrashReportAlertsService } from "./crash-alerts.service";

@Module({
  imports: [PrismaModule],
  controllers: [PublicCrashReportsController, AdminCrashReportsController],
  providers: [CrashReportsService, CrashReportAlertsService, AdminAuthGuard],
})
export class CrashReportsModule {}
