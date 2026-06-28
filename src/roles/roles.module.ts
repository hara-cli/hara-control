import { Module } from "@nestjs/common";
import { RolesController, RolesDeviceController } from "./roles.controller";
import { RolesService } from "./roles.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";

@Module({
  controllers: [RolesController, RolesDeviceController],
  providers: [RolesService, AdminAuthGuard],
  exports: [RolesService],
})
export class RolesModule {}
