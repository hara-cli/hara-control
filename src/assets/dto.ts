import { AssetKind, AssetScope } from "@prisma/client";
import { IsArray, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class ContributeDto {
  @IsEnum(AssetKind) kind!: AssetKind;
  @IsEnum(AssetScope) scope!: AssetScope;
  @IsString() @IsOptional() teamId?: string;
  @IsString() @IsNotEmpty() slug!: string;
  @IsString() @IsOptional() title?: string;
  @IsString() @IsOptional() summary?: string;
  @IsString() @IsOptional() lang?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() tags?: string[];
  @IsString() @IsNotEmpty() body!: string;
}

export class SearchDto {
  @IsString() @IsNotEmpty() query!: string;
  @IsEnum(AssetKind) @IsOptional() kind?: AssetKind;
  @IsInt() @Min(1) @IsOptional() limit?: number;
}

export class ReviewDto {
  @IsIn(["approve", "reject"]) decision!: "approve" | "reject";
}

export class PromoteDto {
  @IsEnum(AssetScope) toScope!: AssetScope;
  @IsString() @IsOptional() toTeamId?: string;
}

export class DeprecateDto {
  @IsString() @IsOptional() supersededById?: string;
}
