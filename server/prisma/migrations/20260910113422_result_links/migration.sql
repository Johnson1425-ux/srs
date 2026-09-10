-- CreateTable
CREATE TABLE "ResultLink" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResultLink_token_key" ON "ResultLink"("token");

-- CreateIndex
CREATE INDEX "ResultLink_schoolId_idx" ON "ResultLink"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultLink_examId_studentId_key" ON "ResultLink"("examId", "studentId");

-- AddForeignKey
ALTER TABLE "ResultLink" ADD CONSTRAINT "ResultLink_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultLink" ADD CONSTRAINT "ResultLink_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultLink" ADD CONSTRAINT "ResultLink_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
