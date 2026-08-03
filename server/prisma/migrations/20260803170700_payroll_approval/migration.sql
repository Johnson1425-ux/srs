-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentNote" TEXT,
ADD COLUMN     "preparedById" TEXT;
