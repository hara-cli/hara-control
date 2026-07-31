import { Module } from "@nestjs/common";
import { EnrollController } from "./enroll.controller";
import { EnrollService } from "./enroll.service";
import { DeskProvisioner } from "./desk-provisioner";

@Module({
  controllers: [EnrollController],
  providers: [EnrollService, DeskProvisioner],
})
export class EnrollModule {}
