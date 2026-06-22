import { Module } from "@nestjs/common";
import { RolesController, RolesDeviceController } from "./roles.controller";
import { RolesService } from "./roles.service";

@Module({
  controllers: [RolesController, RolesDeviceController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
