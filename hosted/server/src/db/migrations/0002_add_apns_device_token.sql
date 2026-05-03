-- Add APNs device token column for push notifications
ALTER TABLE devices ADD COLUMN apns_device_token TEXT;
