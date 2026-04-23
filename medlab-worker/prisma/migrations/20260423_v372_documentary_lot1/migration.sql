CREATE TYPE "DocumentType" AS ENUM ('RCP', 'NOTICE', 'UNKNOWN');
CREATE TYPE "DocumentIngestionRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');
CREATE TYPE "DocumentFetchStatus" AS ENUM ('PENDING', 'SUCCESS', 'NOT_FOUND', 'NOT_MODIFIED', 'HTTP_ERROR', 'PARSE_ERROR', 'FAILED');
CREATE TYPE "OfficialDocumentStatus" AS ENUM ('AVAILABLE', 'MISSING', 'STALE', 'BLOCKED');
CREATE TYPE "DocumentPublicationStatus" AS ENUM ('INTERNAL_ONLY', 'PREVIEW_READY', 'PUBLISHABLE', 'BLOCKED', 'NEEDS_REVIEW');

CREATE TABLE "DocumentIngestionRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" "DocumentIngestionRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "statsJson" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentIngestionRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentFetchAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "cis" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" "DocumentFetchStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "fetchedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "contentHash" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentFetchAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfficialDocumentVersion" (
    "id" TEXT NOT NULL,
    "cis" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "fetchAttemptId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "rawHash" TEXT,
    "cleanHash" TEXT,
    "rawContent" TEXT,
    "cleanContent" TEXT,
    "officialUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" JSONB,
    CONSTRAINT "OfficialDocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfficialDocumentCurrent" (
    "id" TEXT NOT NULL,
    "cis" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "currentVersionId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "contentHash" TEXT,
    "officialUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OfficialDocumentStatus" NOT NULL DEFAULT 'MISSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OfficialDocumentCurrent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfficialDocumentSection" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "title" TEXT,
    "position" INTEGER NOT NULL,
    "content" TEXT,
    "contentHash" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfficialDocumentSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublicationAssessment" (
    "id" TEXT NOT NULL,
    "cis" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "status" "DocumentPublicationStatus" NOT NULL DEFAULT 'INTERNAL_ONLY',
    "reasonCode" TEXT,
    "reasonMessage" TEXT,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentPublicationAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OfficialDocumentCurrent_cis_documentType_key" ON "OfficialDocumentCurrent"("cis", "documentType");
CREATE UNIQUE INDEX "OfficialDocumentCurrent_currentVersionId_key" ON "OfficialDocumentCurrent"("currentVersionId");
CREATE UNIQUE INDEX "OfficialDocumentVersion_cis_documentType_contentHash_key" ON "OfficialDocumentVersion"("cis", "documentType", "contentHash");
CREATE UNIQUE INDEX "OfficialDocumentSection_versionId_sectionKey_position_key" ON "OfficialDocumentSection"("versionId", "sectionKey", "position");
CREATE UNIQUE INDEX "DocumentPublicationAssessment_cis_documentType_key" ON "DocumentPublicationAssessment"("cis", "documentType");

CREATE INDEX "DocumentIngestionRun_status_startedAt_idx" ON "DocumentIngestionRun"("status", "startedAt");
CREATE INDEX "DocumentIngestionRun_source_scope_createdAt_idx" ON "DocumentIngestionRun"("source", "scope", "createdAt");
CREATE INDEX "DocumentFetchAttempt_runId_idx" ON "DocumentFetchAttempt"("runId");
CREATE INDEX "DocumentFetchAttempt_cis_idx" ON "DocumentFetchAttempt"("cis");
CREATE INDEX "DocumentFetchAttempt_cis_documentType_fetchedAt_idx" ON "DocumentFetchAttempt"("cis", "documentType", "fetchedAt");
CREATE INDEX "DocumentFetchAttempt_status_createdAt_idx" ON "DocumentFetchAttempt"("status", "createdAt");
CREATE INDEX "DocumentFetchAttempt_contentHash_idx" ON "DocumentFetchAttempt"("contentHash");
CREATE INDEX "OfficialDocumentCurrent_cis_idx" ON "OfficialDocumentCurrent"("cis");
CREATE INDEX "OfficialDocumentCurrent_documentType_status_idx" ON "OfficialDocumentCurrent"("documentType", "status");
CREATE INDEX "OfficialDocumentCurrent_contentHash_idx" ON "OfficialDocumentCurrent"("contentHash");
CREATE INDEX "OfficialDocumentVersion_cis_idx" ON "OfficialDocumentVersion"("cis");
CREATE INDEX "OfficialDocumentVersion_cis_documentType_fetchedAt_idx" ON "OfficialDocumentVersion"("cis", "documentType", "fetchedAt");
CREATE INDEX "OfficialDocumentVersion_fetchAttemptId_idx" ON "OfficialDocumentVersion"("fetchAttemptId");
CREATE INDEX "OfficialDocumentVersion_contentHash_idx" ON "OfficialDocumentVersion"("contentHash");
CREATE INDEX "OfficialDocumentVersion_officialUpdatedAt_idx" ON "OfficialDocumentVersion"("officialUpdatedAt");
CREATE INDEX "OfficialDocumentSection_versionId_position_idx" ON "OfficialDocumentSection"("versionId", "position");
CREATE INDEX "OfficialDocumentSection_sectionKey_idx" ON "OfficialDocumentSection"("sectionKey");
CREATE INDEX "OfficialDocumentSection_contentHash_idx" ON "OfficialDocumentSection"("contentHash");
CREATE INDEX "DocumentPublicationAssessment_status_assessedAt_idx" ON "DocumentPublicationAssessment"("status", "assessedAt");
CREATE INDEX "DocumentPublicationAssessment_cis_idx" ON "DocumentPublicationAssessment"("cis");

ALTER TABLE "DocumentFetchAttempt"
    ADD CONSTRAINT "DocumentFetchAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DocumentIngestionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "DocumentFetchAttempt_cis_fkey" FOREIGN KEY ("cis") REFERENCES "BdpmMedication"("cis") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OfficialDocumentVersion"
    ADD CONSTRAINT "OfficialDocumentVersion_cis_fkey" FOREIGN KEY ("cis") REFERENCES "BdpmMedication"("cis") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "OfficialDocumentVersion_fetchAttemptId_fkey" FOREIGN KEY ("fetchAttemptId") REFERENCES "DocumentFetchAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OfficialDocumentCurrent"
    ADD CONSTRAINT "OfficialDocumentCurrent_cis_fkey" FOREIGN KEY ("cis") REFERENCES "BdpmMedication"("cis") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "OfficialDocumentCurrent_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "OfficialDocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OfficialDocumentSection"
    ADD CONSTRAINT "OfficialDocumentSection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "OfficialDocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentPublicationAssessment"
    ADD CONSTRAINT "DocumentPublicationAssessment_cis_fkey" FOREIGN KEY ("cis") REFERENCES "BdpmMedication"("cis") ON DELETE CASCADE ON UPDATE CASCADE;
