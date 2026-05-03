-- Flow execution config per workflow (parallel/sequential mode + flow ordering)
ALTER TABLE workflows ADD COLUMN flow_config TEXT DEFAULT NULL;
