CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ownerRole" "ActorRole" NOT NULL,
    "ownerWpUserId" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthToken_token_key" ON "AuthToken"("token");
CREATE INDEX "AuthToken_email_expiresAt_idx" ON "AuthToken"("email", "expiresAt");
CREATE INDEX "AuthToken_used_expiresAt_idx" ON "AuthToken"("used", "expiresAt");
