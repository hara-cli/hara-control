import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class SubmitDesktopCrashReportDto {
  @IsInt()
  @Min(1)
  @Max(1)
  reportVersion!: number;

  @IsInt()
  @Min(1)
  @Max(1)
  consentVersion!: number;

  @IsString()
  @Matches(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,46}$/)
  appVersion!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,46}$/)
  engineVersion?: string;

  @IsIn(["windows", "macos", "linux"])
  platform!: string;

  @IsIn(["x86_64", "aarch64", "arm64"])
  arch!: string;

  @IsIn(["unclean_exit", "renderer_exception", "renderer_unresponsive"])
  kind!: string;

  @Matches(/^[a-f0-9]{64}$/)
  fingerprint!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsString()
  @Length(1, 500)
  summary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  userDescription?: string;

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  context!: string[];
}

export class UpdateDesktopCrashReportDto {
  @IsIn(["NEW", "REVIEWING", "RESOLVED", "IGNORED"])
  status!: "NEW" | "REVIEWING" | "RESOLVED" | "IGNORED";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
