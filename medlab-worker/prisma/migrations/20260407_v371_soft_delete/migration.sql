ALTER TABLE "Doctor"
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ALTER COLUMN "wpUserId" DROP NOT NULL;

ALTER TABLE "Patient"
    ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Doctor_deletedAt_idx" ON "Doctor"("deletedAt");
CREATE INDEX "Patient_deletedAt_idx" ON "Patient"("deletedAt");
