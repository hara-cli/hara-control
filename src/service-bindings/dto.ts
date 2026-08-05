import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  TenantServiceMode,
  TenantServiceRegion,
} from "@prisma/client";

export class UpsertTenantServiceBindingDto {
  @IsEnum(TenantServiceMode)
  mode!: TenantServiceMode;

  @IsEnum(TenantServiceRegion)
  accountRegion!: TenantServiceRegion;

  @IsString()
  @MaxLength(2048)
  apiOrigin!: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  issuer?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  jwksUri?: string;

  @IsString()
  @MaxLength(160)
  @IsOptional()
  audience?: string;

  /** Optional write-only provisioning credential. It is envelope-encrypted and never returned. */
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  credential?: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  @IsOptional()
  capabilitiesVersion?: number;
}
