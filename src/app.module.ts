import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { GatewayModule } from "./gateway/gateway.module";
import { AuditModule } from "./audit/audit.module";
import { EnrollModule } from "./enroll/enroll.module";
import { AdminModule } from "./admin/admin.module";
import { RolesModule } from "./roles/roles.module";

@Module({
  imports: [PrismaModule, GatewayModule, AuditModule, EnrollModule, AdminModule, RolesModule],
})
export class AppModule {}
