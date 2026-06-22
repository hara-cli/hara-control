import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { GatewayModule } from "./gateway/gateway.module";
import { AuditModule } from "./audit/audit.module";
import { EnrollModule } from "./enroll/enroll.module";
import { AdminModule } from "./admin/admin.module";
import { RolesModule } from "./roles/roles.module";
import { LicenseModule } from "./license/license.module";
import { AssetsModule } from "./assets/assets.module";
import { EmbeddingModule } from "./embed/embedding.module";

@Module({
  imports: [PrismaModule, GatewayModule, AuditModule, LicenseModule, EmbeddingModule, EnrollModule, AdminModule, RolesModule, AssetsModule],
})
export class AppModule {}
