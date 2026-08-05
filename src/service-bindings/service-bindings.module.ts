import { Module } from "@nestjs/common";
import { TenantServiceBindingsController } from "./service-bindings.controller";
import { TenantServiceBindingsService } from "./service-bindings.service";

@Module({
  controllers: [TenantServiceBindingsController],
  providers: [TenantServiceBindingsService],
  exports: [TenantServiceBindingsService],
})
export class TenantServiceBindingsModule {}
