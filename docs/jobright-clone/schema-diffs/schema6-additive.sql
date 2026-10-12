-- AlterTable
ALTER TABLE "RAAutofillRun" ADD COLUMN     "pageUrl" TEXT;

-- CreateTable
CREATE TABLE "RACancelSurvey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACancelSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RACancelSurvey_brand_createdAt_idx" ON "RACancelSurvey"("brand", "createdAt");

-- CreateIndex
CREATE INDEX "RACancelSurvey_userId_idx" ON "RACancelSurvey"("userId");

-- CreateIndex
CREATE INDEX "RAAutofillRun_userId_deviceId_host_createdAt_idx" ON "RAAutofillRun"("userId", "deviceId", "host", "createdAt");

-- AddForeignKey
ALTER TABLE "RACancelSurvey" ADD CONSTRAINT "RACancelSurvey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
