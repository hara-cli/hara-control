import { IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from "class-validator";
import { AdminRole } from "@prisma/client";

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() password!: string;
  // 6-digit TOTP, optional on first POST; required when the account has 2FA enabled.
  // Loose pattern (Matches) so the service can return `{ requires_2fa: true }` for "no code yet".
  @IsString() @IsOptional() @Matches(/^\d{6}$/) code?: string;
}

export class TotpEnableDto {
  // base32 secret returned by /auth/2fa/setup; client must echo it back so we don't have to stash
  // a pending secret server-side (stateless setup, prevents half-enrolled rows).
  @IsString() @IsNotEmpty() secret!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
}

export class TotpDisableDto {
  @IsString() @Matches(/^\d{6}$/) code!: string;
}

export class BootstrapSuperadminDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
}

export class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
  @IsEnum(AdminRole) role!: AdminRole;
  @IsString() @IsOptional() orgId?: string;
}

export class UpdateUserDto {
  @IsEnum(AdminRole) @IsOptional() role?: AdminRole;
  @IsBoolean() @IsOptional() disabled?: boolean;
  @IsString() @IsOptional() @MinLength(12) password?: string;
}
