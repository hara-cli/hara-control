import { Module } from "@nestjs/common";
import { EnrollController } from "./enroll.controller";
import { EnrollService } from "./enroll.service";
import { DeskProvisioner } from "./desk-provisioner";
import { TenantServiceBindingsModule } from "../service-bindings/service-bindings.module";

@Module({
  imports: [TenantServiceBindingsModule],
  controllers: [EnrollController],
  providers: [EnrollService, DeskProvisioner],
})
export class EnrollModule {}
