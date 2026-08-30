-- A managed connection owns both a default model and its optional default reasoning effort.
-- Empty means "use the model/provider default" and preserves all pre-existing enrollments.
ALTER TABLE "EnrollCode"
  ADD COLUMN "reasoningEffort" TEXT NOT NULL DEFAULT '';

ALTER TABLE "DeviceToken"
  ADD COLUMN "reasoningEffort" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Role"
  ADD COLUMN "reasoningEffort" TEXT;

ALTER TABLE "EnrollCode"
  ADD CONSTRAINT "EnrollCode_reasoningEffort_check"
  CHECK ("reasoningEffort" IN ('', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

ALTER TABLE "DeviceToken"
  ADD CONSTRAINT "DeviceToken_reasoningEffort_check"
  CHECK ("reasoningEffort" IN ('', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

ALTER TABLE "Role"
  ADD CONSTRAINT "Role_reasoningEffort_check"
  CHECK ("reasoningEffort" IS NULL OR "reasoningEffort" IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
