import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminKeyGuard } from "../common/admin-key.guard";

@Module({ controllers: [AdminController], providers: [AdminService, AdminKeyGuard] })
export class AdminModule {}
