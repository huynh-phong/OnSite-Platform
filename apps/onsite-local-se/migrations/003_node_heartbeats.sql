-- Store server heartbeats, as the source system reported them. heartbeat_checked_at is when Local SE last read
-- them. A node is offline when, at that read, it had been silent for longer than NODE_HEARTBEAT_TIMEOUT_SECONDS:
-- silence is measured as the source saw it, so Local SE not reading (a source outage) never makes a node look
-- offline. Offline nodes get no new allocations, and tasks still waiting for their approval move elsewhere.
ALTER TABLE stores
  ADD COLUMN last_heartbeat_at    TIMESTAMPTZ,
  ADD COLUMN heartbeat_checked_at TIMESTAMPTZ;
