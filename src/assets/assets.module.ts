import { Module } from "@nestjs/common";
import { AssetsAdminController, AssetsDeviceController } from "./assets.controller";
import { AssetsService } from "./assets.service";

@Module({
  controllers: [AssetsDeviceController, AssetsAdminController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
