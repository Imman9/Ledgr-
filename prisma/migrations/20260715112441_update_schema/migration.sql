/*
  Warnings:

  - You are about to drop the column `receiptId` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `voiceEntryId` on the `Transaction` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Transaction_receiptId_key";

-- DropIndex
DROP INDEX "Transaction_voiceEntryId_key";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "receiptId",
DROP COLUMN "voiceEntryId";
