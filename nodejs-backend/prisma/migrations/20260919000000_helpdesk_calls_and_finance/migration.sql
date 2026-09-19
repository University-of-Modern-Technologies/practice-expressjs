-- CreateEnum
CREATE TYPE "TicketChannel" AS ENUM ('EMAIL', 'PHONE', 'CHAT', 'WEB');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CallDisposition" AS ENUM ('ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL');

-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "PaymentMatchStatus" AS ENUM ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED');

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "number" VARCHAR(16) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "channel" "TicketChannel" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "owner_id" UUID NOT NULL,
    "contact_id" UUID,
    "assignee_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_status_logs" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_status" "TicketStatus",
    "to_status" "TicketStatus" NOT NULL,
    "changed_by_id" UUID,
    "note" VARCHAR(500),
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "disposition" "CallDisposition" NOT NULL,
    "from_number" VARCHAR(32) NOT NULL,
    "to_number" VARCHAR(32) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "owner_id" UUID,
    "contact_id" UUID,
    "deal_id" UUID,
    "recording_url" VARCHAR(512),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "account_label" VARCHAR(64) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closing_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "imported_by_id" UUID,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "booked_at" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "direction" "TransactionDirection" NOT NULL,
    "counterparty_name" VARCHAR(200) NOT NULL,
    "counterparty_account" VARCHAR(64),
    "reference" VARCHAR(300) NOT NULL,
    "match_status" "PaymentMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matched_order_id" UUID,
    "matched_by_id" UUID,
    "matched_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");

-- CreateIndex
CREATE INDEX "tickets_owner_id_status_deleted_at_idx" ON "tickets"("owner_id", "status", "deleted_at");

-- CreateIndex
CREATE INDEX "tickets_status_priority_idx" ON "tickets"("status", "priority");

-- CreateIndex
CREATE INDEX "tickets_contact_id_idx" ON "tickets"("contact_id");

-- CreateIndex
CREATE INDEX "tickets_assignee_id_idx" ON "tickets"("assignee_id");

-- CreateIndex
CREATE INDEX "tickets_deleted_at_idx" ON "tickets"("deleted_at");

-- CreateIndex
CREATE INDEX "ticket_status_logs_ticket_id_changed_at_idx" ON "ticket_status_logs"("ticket_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "calls_external_id_key" ON "calls"("external_id");

-- CreateIndex
CREATE INDEX "calls_started_at_idx" ON "calls"("started_at");

-- CreateIndex
CREATE INDEX "calls_owner_id_started_at_idx" ON "calls"("owner_id", "started_at");

-- CreateIndex
CREATE INDEX "calls_contact_id_idx" ON "calls"("contact_id");

-- CreateIndex
CREATE INDEX "calls_deal_id_idx" ON "calls"("deal_id");

-- CreateIndex
CREATE INDEX "calls_direction_disposition_idx" ON "calls"("direction", "disposition");

-- CreateIndex
CREATE INDEX "calls_deleted_at_idx" ON "calls"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statements_external_id_key" ON "bank_statements"("external_id");

-- CreateIndex
CREATE INDEX "bank_statements_period_start_period_end_idx" ON "bank_statements"("period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_external_id_key" ON "bank_transactions"("external_id");

-- CreateIndex
CREATE INDEX "bank_transactions_statement_id_booked_at_idx" ON "bank_transactions"("statement_id", "booked_at");

-- CreateIndex
CREATE INDEX "bank_transactions_match_status_booked_at_idx" ON "bank_transactions"("match_status", "booked_at");

-- CreateIndex
CREATE INDEX "bank_transactions_matched_order_id_idx" ON "bank_transactions"("matched_order_id");

-- CreateIndex
CREATE INDEX "bank_transactions_booked_at_idx" ON "bank_transactions"("booked_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_status_logs" ADD CONSTRAINT "ticket_status_logs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_status_logs" ADD CONSTRAINT "ticket_status_logs_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_order_id_fkey" FOREIGN KEY ("matched_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_by_id_fkey" FOREIGN KEY ("matched_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules the schema language cannot express, added here so the database refuses
-- a bad row regardless of which service wrote it. The names match the sibling
-- backend's constraints exactly: the same rule is the same name in both.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subject_nonempty_check" CHECK (btrim("subject") <> '');
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_number_nonempty_check" CHECK (btrim("number") <> '');
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_version_positive_check" CHECK ("version" > 0);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolved_at_consistency_check" CHECK (("status" IN ('RESOLVED', 'CLOSED') AND "resolved_at" IS NOT NULL) OR ("status" NOT IN ('RESOLVED', 'CLOSED') AND "resolved_at" IS NULL));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolved_at_check" CHECK ("resolved_at" IS NULL OR "resolved_at" >= "opened_at");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_deleted_at_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at");
ALTER TABLE "ticket_status_logs" ADD CONSTRAINT "ticket_status_logs_status_changed_check" CHECK ("from_status" IS NULL OR "from_status" <> "to_status");
ALTER TABLE "calls" ADD CONSTRAINT "calls_external_id_nonempty_check" CHECK (btrim("external_id") <> '');
ALTER TABLE "calls" ADD CONSTRAINT "calls_from_number_nonempty_check" CHECK (btrim("from_number") <> '');
ALTER TABLE "calls" ADD CONSTRAINT "calls_to_number_nonempty_check" CHECK (btrim("to_number") <> '');
ALTER TABLE "calls" ADD CONSTRAINT "calls_duration_nonnegative_check" CHECK ("duration_seconds" >= 0);
ALTER TABLE "calls" ADD CONSTRAINT "calls_version_positive_check" CHECK ("version" > 0);
ALTER TABLE "calls" ADD CONSTRAINT "calls_deleted_at_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at");
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_external_id_nonempty_check" CHECK (btrim("external_id") <> '');
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_period_ordered_check" CHECK ("period_end" >= "period_start");
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_external_id_nonempty_check" CHECK (btrim("external_id") <> '');
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_counterparty_nonempty_check" CHECK (btrim("counterparty_name") <> '');
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_amount_nonnegative_check" CHECK ("amount" >= 0);
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_version_positive_check" CHECK ("version" > 0);
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_match_consistency_check" CHECK (("match_status" = 'MATCHED' AND "matched_order_id" IS NOT NULL) OR ("match_status" <> 'MATCHED' AND "matched_order_id" IS NULL));
