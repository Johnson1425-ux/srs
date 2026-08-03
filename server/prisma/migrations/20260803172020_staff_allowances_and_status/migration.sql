-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "allowanceBreakdown" JSONB;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;

-- CreateTable
CREATE TABLE "StaffAllowance" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffAllowance_staffId_isActive_idx" ON "StaffAllowance"("staffId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAllowance_staffId_name_key" ON "StaffAllowance"("staffId", "name");

-- AddForeignKey
ALTER TABLE "StaffAllowance" ADD CONSTRAINT "StaffAllowance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
