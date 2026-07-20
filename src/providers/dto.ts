import { IsEnum, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class PutDeepSeekCredentialDto {
  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  @Matches(/^[\x21-\x7e]+$/, {
    message: "apiKey must be a single printable ASCII token without spaces",
  })
  apiKey!: string;
}

export enum ProviderCredentialTestTarget {
  STORED = "stored",
  RUNTIME = "runtime",
}

export class TestDeepSeekCredentialDto {
  @IsEnum(ProviderCredentialTestTarget)
  target!: ProviderCredentialTestTarget;
}
