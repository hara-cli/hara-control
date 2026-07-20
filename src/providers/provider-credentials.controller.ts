import { Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import {
  AdminAuthGuard,
  AuthedUser,
  Roles,
} from "../common/admin-auth.guard";
import {
  PutDeepSeekCredentialDto,
  TestDeepSeekCredentialDto,
} from "./dto";
import { ProviderCredentialsService } from "./provider-credentials.service";

interface RequestWithUser {
  user?: AuthedUser;
}

@Controller("admin/providers/deepseek")
@UseGuards(AdminAuthGuard)
@Roles(AdminRole.SUPERADMIN)
export class ProviderCredentialsController {
  constructor(private readonly providers: ProviderCredentialsService) {}

  @Get()
  status() {
    return this.providers.deepSeekStatus();
  }

  /**
   * Creates or rotates the encrypted source-of-truth copy. The response never echoes the value.
   * Runtime activation remains an explicit deploy/restart operation: the supervised LiteLLM child
   * loads the new Secret.version in memory and records only that non-secret revision.
   */
  @Put("credential")
  put(@Req() req: RequestWithUser, @Body() dto: PutDeepSeekCredentialDto) {
    return this.providers.putDeepSeek(dto.apiKey, req.user!);
  }

  @Post("credential/test")
  test(@Req() req: RequestWithUser, @Body() dto: TestDeepSeekCredentialDto) {
    return this.providers.testDeepSeek(dto.target, req.user!);
  }
}
