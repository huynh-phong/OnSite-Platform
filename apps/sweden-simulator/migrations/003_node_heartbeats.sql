-- Each store's own server reports to the ERP/WMS. While its link is down, the store's last heartbeat stops
-- moving, and stock movements at the counter are not reaching the central records.
ALTER TABLE stores ADD COLUMN link_down_since TIMESTAMPTZ;
