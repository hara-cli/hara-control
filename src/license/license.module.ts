import { Global, Module } from "@nestjs/common";
import { EntitlementService, LicenseService } from "./license.service";

@Global()
@Module({
  providers: [LicenseService, EntitlementService],
  exports: [LicenseService, EntitlementService],
})
export class LicenseModule {}
