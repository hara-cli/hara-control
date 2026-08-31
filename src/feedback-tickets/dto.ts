import {
  FeedbackTicketKind,
  FeedbackTicketPriority,
  FeedbackTicketSource,
  FeedbackTicketStatus,
} from "@prisma/client";
import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class IntakeFeedbackTicketDto {
  @IsEnum(FeedbackTicketSource)
  source!: FeedbackTicketSource;

  @IsString()
  @Length(1, 200)
  sourceRef!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceChatRef?: string;

  @IsEnum(FeedbackTicketKind)
  kind!: FeedbackTicketKind;

  @IsOptional()
  @IsEnum(FeedbackTicketPriority)
  priority?: FeedbackTicketPriority;

  @IsString()
  @Length(1, 240)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reporterRef?: string;

  @IsString()
  @Length(3, 160)
  @Matches(/^[0-9A-Za-z._:@-]+$/)
  consumerId!: string;
}

export class UpdateFeedbackTicketDto {
  @IsEnum(FeedbackTicketStatus)
  status!: FeedbackTicketStatus;

  @IsOptional()
  @IsEnum(FeedbackTicketPriority)
  priority?: FeedbackTicketPriority;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  assignee?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  fixVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  verificationSteps?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  note?: string;
}

export class ClaimedFeedbackTicketUpdateDto extends UpdateFeedbackTicketDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  claimToken!: string;
}
