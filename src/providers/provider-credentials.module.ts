import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ProviderCredentialsController } from "./provider-credentials.controller";
import { ProviderCredentialsService } from "./provider-credentials.service";

@Module({
  imports: [AuthModule],
  controllers: [ProviderCredentialsController],
  providers: [ProviderCredentialsService],
})
export class ProviderCredentialsModule {}
