import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminKeyGuard } from "../common/admin-key.guard";
import { OrgModule } from "../org/org.module";

@Module({ imports: [OrgModule], controllers: [AdminController], providers: [AdminService, AdminKeyGuard] })
export class AdminModule {}
