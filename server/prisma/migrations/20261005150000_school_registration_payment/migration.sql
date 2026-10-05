-- AlterEnum
ALTER TYPE "SchoolStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "registrationPaidAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RegistrationPayment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "provider" "MobileMoneyProvider" NOT NULL DEFAULT 'MPESA',
    "msisdn" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "conversationId" TEXT,
    "transactionId" TEXT,
    "resultCode" TEXT,
    "resultDescription" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationPayment_reference_key" ON "RegistrationPayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationPayment_claimToken_key" ON "RegistrationPayment"("claimToken");

-- CreateIndex
CREATE INDEX "RegistrationPayment_schoolId_createdAt_idx" ON "RegistrationPayment"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationPayment_status_idx" ON "RegistrationPayment"("status");

-- AddForeignKey
ALTER TABLE "RegistrationPayment" ADD CONSTRAINT "RegistrationPayment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
