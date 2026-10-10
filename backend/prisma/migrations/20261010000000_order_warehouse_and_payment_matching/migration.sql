-- AlterTable
ALTER TABLE "orders" ADD COLUMN "warehouse_id" UUID;

-- AlterTable
ALTER TABLE "bank_transactions" ADD COLUMN "auto_match_disabled" BOOLEAN NOT NULL DEFAULT false;

-- Orders confirmed before this migration reserved stock in the warehouse the
-- `warehouse.defaultCode` setting named at the time, `CENTRAL` when unset.
UPDATE "orders" SET "warehouse_id" = "warehouses"."id"
FROM "warehouses"
WHERE "warehouses"."code" = COALESCE(
        (SELECT "value" #>> '{}' FROM "organization_settings" WHERE "key" = 'warehouse.defaultCode'),
        'CENTRAL'
    )
  AND "orders"."status" IN ('CONFIRMED', 'PAID');

-- An order may already be matched by several payments; the earliest match
-- stays and the others go back to the queue for a person to look at.
UPDATE "bank_transactions" SET
    "match_status" = 'UNMATCHED',
    "matched_order_id" = NULL,
    "matched_by_id" = NULL,
    "matched_at" = NULL,
    "version" = "version" + 1
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id", row_number() OVER (
            PARTITION BY "matched_order_id" ORDER BY "matched_at", "id"
        ) AS "position"
        FROM "bank_transactions"
        WHERE "matched_order_id" IS NOT NULL
    ) AS "ranked"
    WHERE "position" > 1
);

-- DropIndex
DROP INDEX "bank_transactions_matched_order_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_matched_order_id_key" ON "bank_transactions"("matched_order_id");

-- CreateIndex
CREATE INDEX "orders_warehouse_id_idx" ON "orders"("warehouse_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
