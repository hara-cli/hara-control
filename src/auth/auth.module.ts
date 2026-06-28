import { Module } from "@nestjs/common";
import { AdminUsersController, AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { AdminKeyGuard } from "../common/admin-key.guard";

// AuthModule owns: built-in account login (JWT), bootstrap, whoami, + SUPERADMIN-only user mgmt.
// AdminAuthGuard is also exported so any other module can flip from AdminKeyGuard → AdminAuthGuard.
@Module({
  controllers: [AuthController, AdminUsersController],
  providers: [AuthService, AdminAuthGuard, AdminKeyGuard],
  exports: [AuthService, AdminAuthGuard],
})
export class AuthModule {}
