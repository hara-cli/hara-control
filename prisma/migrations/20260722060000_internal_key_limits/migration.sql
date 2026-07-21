ALTER TABLE "EnrollCode"
  ADD COLUMN "tokenTtlMinutes" INTEGER,
  ADD COLUMN "budgetLimits" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "rpmLimit" INTEGER,
  ADD COLUMN "tpmLimit" INTEGER;

ALTER TABLE "DeviceToken"
  ADD COLUMN "budgetLimits" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "rpmLimit" INTEGER,
  ADD COLUMN "tpmLimit" INTEGER;

ALTER TABLE "EnrollCode"
  ADD CONSTRAINT "EnrollCode_tokenTtlMinutes_bounds"
    CHECK ("tokenTtlMinutes" IS NULL OR "tokenTtlMinutes" BETWEEN 5 AND 525600),
  ADD CONSTRAINT "EnrollCode_rpmLimit_positive"
    CHECK ("rpmLimit" IS NULL OR "rpmLimit" > 0),
  ADD CONSTRAINT "EnrollCode_tpmLimit_positive"
    CHECK ("tpmLimit" IS NULL OR "tpmLimit" > 0),
  ADD CONSTRAINT "EnrollCode_budgetLimits_array"
    CHECK (jsonb_typeof("budgetLimits") = 'array');

ALTER TABLE "DeviceToken"
  ADD CONSTRAINT "DeviceToken_rpmLimit_positive"
    CHECK ("rpmLimit" IS NULL OR "rpmLimit" > 0),
  ADD CONSTRAINT "DeviceToken_tpmLimit_positive"
    CHECK ("tpmLimit" IS NULL OR "tpmLimit" > 0),
  ADD CONSTRAINT "DeviceToken_budgetLimits_array"
    CHECK (jsonb_typeof("budgetLimits") = 'array');
