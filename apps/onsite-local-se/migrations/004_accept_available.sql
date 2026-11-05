-- A customer whose order was short may accept what can be supplied now. The line keeps what was originally
-- asked for, so the reduction stays visible and in-full is judged against what the customer agreed to.
ALTER TABLE order_items ADD COLUMN requested_quantity INTEGER CHECK (requested_quantity > 0);
