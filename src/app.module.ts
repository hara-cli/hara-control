import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { OrgModule } from "./org/org.module";
import { GatewayModule } from "./gateway/gateway.module";
import { AuditModule } from "./audit/audit.module";
import { EnrollModule } from "./enroll/enroll.module";
import { AdminModule } from "./admin/admin.module";
import { RolesModule } from "./roles/roles.module";
import { LicenseModule } from "./license/license.module";
import { AssetsModule } from "./assets/assets.module";
import { EmbeddingModule } from "./embed/embedding.module";
import { WorkModule } from "./work/work.module";
import { SecretsModule } from "./security/secrets.module";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { ProviderCredentialsModule } from "./providers/provider-credentials.module";

@Module({
  imports: [
    PrismaModule,
    OrgModule,
    GatewayModule,
    AuditModule,
    LicenseModule,
    EmbeddingModule,
    EnrollModule,
    AdminModule,
    RolesModule,
    AssetsModule,
    WorkModule,
    SecretsModule,
    AuthModule,
    HealthModule,
    ProviderCredentialsModule,
  ],
})
export class AppModule {}
