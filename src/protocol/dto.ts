// Wire DTOs. Field names are snake_case to match the hara CLI's enroll/heartbeat contract
// (src/org-fleet/enroll.ts). The shared @nanhara/hara-protocol package (extracted on the open CLI
// side later) will own these types; the closed server will depend on it.
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { OrgUnitType } from "@prisma/client";
import {
  MAX_BUDGET_USD,
  MAX_RPM_LIMIT,
  MAX_TOKEN_TTL_MINUTES,
  MAX_TPM_LIMIT,
  MIN_TOKEN_TTL_MINUTES,
} from "../gateway/key-policy";

export class DeviceInfoDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsOptional() os = "";
  @IsString() @IsOptional() hara_version = "";
}

export class EnrollDto {
  @IsString() @IsNotEmpty() code!: string;
  @ValidateNested() @Type(() => DeviceInfoDto) device!: DeviceInfoDto;
}

export class HeartbeatDto {
  @IsString() @IsOptional() device_id?: string;
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() os?: string;
  @IsString() @IsOptional() hara_version?: string;
}

export class CreateOrgDto {
  @IsString() @IsNotEmpty() @MaxLength(80) @Matches(/^[^\u0000-\u001f\u007f]+$/) name!: string;
  // Hierarchy (additive): defaults to a standalone COMPANY root if both are omitted, so the old
  // `POST /admin/orgs {name}` contract is unchanged. Set type=DEPARTMENT + parentId=<companyId> to nest.
  @IsEnum(OrgUnitType) @IsOptional() type?: OrgUnitType;
  @IsString() @IsOptional() parentId?: string;
}

export enum AccessBudgetWindowDto {
  FIVE_HOURS = "5h",
  WEEK = "week",
  MONTH = "month",
}

export class AccessBudgetLimitDto {
  @IsEnum(AccessBudgetWindowDto) window!: AccessBudgetWindowDto;
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.01) @Max(MAX_BUDGET_USD) maxUsd!: number;
}

export class CreateEnrollCodeDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsOptional() model?: string;
  @IsString() @IsIn(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  @IsOptional() reasoningEffort?: string;
  @IsString() @IsOptional() baseUrl?: string;
  @IsInt() @Min(1) @IsOptional() ttlMinutes?: number;
  @IsInt() @Min(MIN_TOKEN_TTL_MINUTES) @Max(MAX_TOKEN_TTL_MINUTES) @IsOptional() tokenTtlMinutes?: number;
  @IsBoolean() @IsOptional() tokenNeverExpires?: boolean;
  @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => AccessBudgetLimitDto) @IsOptional()
  budgetLimits?: AccessBudgetLimitDto[];
  @IsInt() @Min(1) @Max(MAX_RPM_LIMIT) @IsOptional() rpmLimit?: number;
  @IsInt() @Min(1) @Max(MAX_TPM_LIMIT) @IsOptional() tpmLimit?: number;
  // Company credentials are always issued to an accountable Person. Service identities should be
  // represented by an explicit Person record instead of falling back to an ambiguous device name.
  @IsString() @IsNotEmpty() personId!: string;
}

export class BindDevicePersonDto {
  @IsString() @IsNotEmpty() personId!: string;
}
