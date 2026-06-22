import { Module } from "@nestjs/common";
import { WorkAdminController, WorkDeviceController } from "./work.controller";
import { WorkService } from "./work.service";

@Module({
  controllers: [WorkDeviceController, WorkAdminController],
  providers: [WorkService],
  exports: [WorkService],
})
export class WorkModule {}
