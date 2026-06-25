-- Token discipline: give device tokens a short TTL. expiresAt is nullable so any pre-existing token
-- keeps working (legacy tokens are treated as non-expiring by assertTokenUsable until re-issued);
-- newly-issued tokens get expiresAt = now + HARA_DEVICE_TOKEN_TTL_MINUTES (default 7d). Re-runnable.

ALTER TABLE "DeviceToken" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
