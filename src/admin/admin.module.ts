import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { OrgModule } from "../org/org.module";
import { EnrollModule } from "../enroll/enroll.module";

@Module({ imports: [OrgModule, EnrollModule], controllers: [AdminController], providers: [AdminService, AdminAuthGuard] })
export class AdminModule {}
