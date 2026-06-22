import { WorkOutcome, WorkSessionKind } from "@prisma/client";
import { Type } from "class-transformer";
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Min, ValidateNested } from "class-validator";

export class WorkSessionDto {
  @IsInt() @Min(0) seq!: number;
  @IsString() @IsNotEmpty() startedAt!: string; // ISO
  @IsString() @IsOptional() endedAt?: string;
  @IsEnum(WorkSessionKind) @IsOptional() kind?: WorkSessionKind;
  @IsString() @IsOptional() roleKey?: string;
  @IsString() @IsOptional() repoHash?: string;
  @IsString() @IsOptional() taskTitle?: string;
  @IsObject() @IsOptional() toolCalls?: Record<string, number>;
  @IsInt() @Min(0) @IsOptional() tasksCount?: number;
  @IsInt() @Min(0) @IsOptional() filesTouched?: number;
  @IsArray() @IsString({ each: true }) @IsOptional() filePathsHashed?: string[];
  @IsInt() @Min(0) @IsOptional() approvalsRequested?: number;
  @IsInt() @Min(0) @IsOptional() approvalsGranted?: number;
  @IsEnum(WorkOutcome) @IsOptional() outcome?: WorkOutcome;
  @IsArray() @IsString({ each: true }) @IsOptional() commitShas?: string[];
  @IsString() @IsOptional() model?: string;
  @IsInt() @Min(0) @IsOptional() tokensIn?: number;
  @IsInt() @Min(0) @IsOptional() tokensOut?: number;
  @IsInt() @Min(0) @IsOptional() latencyMs?: number;
}

export class IngestDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => WorkSessionDto) sessions!: WorkSessionDto[];
}
