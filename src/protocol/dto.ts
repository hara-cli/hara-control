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

export const DESK_AGENT_CLIENT_KINDS = [
  "nanhara.hara-desktop",
  "nanhara.hara-cli",
  "anthropic.claude-code",
  "openai.codex",
] as const;

export class DeviceInfoDto {
  @IsString() @IsNotEmpty() @MaxLength(120) @Matches(/^[^\u0000-\u001f\u007f]+$/) name!: string;
  @IsString() @IsOptional() @MaxLength(40) @Matches(/^[^\u0000-\u001f\u007f]*$/) os = "";
  @IsString() @IsOptional() @MaxLength(40) @Matches(/^[^\u0000-\u001f\u007f]*$/) hara_version = "";
  // Control provisions the first Desk identity for the client that actually performed enrollment.
  // Older clients omit this and retain the historical Desktop identity for wire compatibility.
  @IsString() @IsIn(DESK_AGENT_CLIENT_KINDS) @IsOptional()
  client_kind = "nanhara.hara-desktop";
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

export class ProvisionDeskAgentDto {
  @IsString() @IsIn(DESK_AGENT_CLIENT_KINDS) client_kind!: string;
  // One stable local installation may intentionally host more than one account/runtime of the same
  // client. The caller supplies a non-secret instance label so retries rotate that exact identity
  // instead of creating duplicates.
  @IsString() @IsOptional() @MaxLength(80) @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  instance_id = "default";
  @IsString() @IsOptional() @MaxLength(120) @Matches(/^[^\u0000-\u001f\u007f]+$/)
  name?: string;
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
