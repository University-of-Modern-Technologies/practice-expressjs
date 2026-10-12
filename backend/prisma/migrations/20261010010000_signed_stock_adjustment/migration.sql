-- An adjustment keeps its sign, so the movement log reconciles with the stock
-- levels; every other movement is still a positive amount. Adjustments written
-- before this migration were stored without a sign and stay as they are.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_positive_check";

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_sign_check"
    CHECK ("quantity" > 0 OR ("type" = 'ADJUSTMENT' AND "quantity" <> 0));
