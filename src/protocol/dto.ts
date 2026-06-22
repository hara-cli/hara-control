// Wire DTOs. Field names are snake_case to match the hara CLI's enroll/heartbeat contract
// (src/org-fleet/enroll.ts). The shared @nanhara/hara-protocol package (extracted on the open CLI
// side later) will own these types; the closed server will depend on it.
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from "class-validator";

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
  @IsString() @IsNotEmpty() name!: string;
}

export class CreateEnrollCodeDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsOptional() model?: string;
  @IsString() @IsOptional() baseUrl?: string;
  @IsInt() @Min(1) @IsOptional() ttlMinutes?: number;
}
