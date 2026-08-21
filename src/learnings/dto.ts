import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export const LEARNING_KIND_VALUES = [
  "business_rule",
  "user_preference",
  "workflow",
  "correction",
  "failure_pattern",
  "action_ownership",
] as const;
export type LearningKindWire = typeof LEARNING_KIND_VALUES[number];

const LEARNING_SOURCE_VALUES = [
  "explicit_user",
  "verified_task",
  "user_correction",
  "tool_failure",
  "workflow_result",
  "runtime_guard",
] as const;

export class LearningObservationDto {
  @IsString() @Matches(/^[a-f0-9]{32}$/) task_hash!: string;
  @IsString() @Matches(/^[a-f0-9]{32}$/) fingerprint!: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) summary!: string;
  @IsIn(LEARNING_SOURCE_VALUES) source!: typeof LEARNING_SOURCE_VALUES[number];
  @IsString() @IsNotEmpty() @MaxLength(64) source_version!: string;
  @IsISO8601({ strict: true }) observed_at!: string;
}

export class SubmitLearningCandidateDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/) client_id!: string;
  @IsString() @Matches(/^[a-z][a-z0-9_.-]{2,119}$/) pattern_key!: string;
  @IsIn(LEARNING_KIND_VALUES) kind!: LearningKindWire;
  @IsString() @IsNotEmpty() @MaxLength(1200) summary!: string;
  @IsString() @IsOptional() @MaxLength(1000) rationale?: string;
  @IsString() @IsNotEmpty() @MaxLength(64) source_version!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => LearningObservationDto)
  evidence!: LearningObservationDto[];
}

export class ReviewLearningCandidateDto {
  @IsIn(["approve", "reject", "revoke"])
  decision!: "approve" | "reject" | "revoke";

  @IsInt() @Min(1) expected_revision!: number;
  @IsString() @IsOptional() @MaxLength(500) note?: string;
}
