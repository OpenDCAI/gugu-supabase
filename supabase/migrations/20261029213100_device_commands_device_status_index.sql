-- "Does this device have open commands?" (device_id = $1 AND status IN ('pending','running')) had no
-- usable index: the only per-device index is partial on status = 'pending', which neither a generic
-- plan nor a status list can use, so every probe scanned the whole table. Cloud-computer controllers
-- ask it about every sleeping device every second; on staging it ran 1.1M times in five days at
-- ~3.5k buffer reads each (2.8 h of database time).
--
-- A plain (device_id, status) index answers it for any status list, custom or generic plan.
CREATE INDEX idx_gugu_device_commands_device_status
    ON identity.gugu_device_commands (device_id, status);
