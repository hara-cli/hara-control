import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";

export class CreateRoleDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsNotEmpty() key!: string;
  @IsString() @IsOptional() description?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() owns?: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() rejects?: string[];
  @IsString() @IsOptional() model?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() allowTools?: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() denyTools?: string[];
  @IsString() @IsOptional() system?: string;
}

export class UpdateRoleDto {
  @IsString() @IsOptional() description?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() owns?: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() rejects?: string[];
  @IsString() @IsOptional() model?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() allowTools?: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() denyTools?: string[];
  @IsString() @IsOptional() system?: string;
}

export class CreatePersonDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsNotEmpty() email!: string;
  @IsString() @IsOptional() name?: string;
}

export class CreateTeamDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsNotEmpty() name!: string;
}

export class AddMemberDto {
  @IsString() @IsNotEmpty() personId!: string;
}

export class PolicyDto {
  @IsObject() policy!: Record<string, unknown>;
}

export class CreateAssignmentDto {
  @IsString() @IsNotEmpty() orgId!: string;
  @IsString() @IsNotEmpty() roleId!: string;
  @IsString() @IsOptional() personId?: string;
  @IsString() @IsOptional() teamId?: string;
  @IsString() @IsOptional() name?: string;
}

export class UpdateAssignmentDto {
  @IsString() @IsOptional() status?: string;
  @IsObject() @IsOptional() policy?: Record<string, unknown>;
}
