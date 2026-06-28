import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { OrgModule } from "../org/org.module";

@Module({ imports: [OrgModule], controllers: [AdminController], providers: [AdminService, AdminAuthGuard] })
export class AdminModule {}
