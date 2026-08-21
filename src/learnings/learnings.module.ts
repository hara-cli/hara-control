import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import {
  LearningsAdminController,
  LearningsDeviceController,
} from "./learnings.controller";
import { LearningsService } from "./learnings.service";

@Module({
  controllers: [LearningsAdminController, LearningsDeviceController],
  providers: [LearningsService, AdminAuthGuard],
  exports: [LearningsService],
})
export class LearningsModule {}
