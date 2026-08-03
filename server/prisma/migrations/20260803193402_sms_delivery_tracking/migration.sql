-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cost" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Message_status_channel_attempts_idx" ON "Message"("status", "channel", "attempts");
