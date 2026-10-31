ALTER TABLE `file_versions` ADD `mtime_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `file_versions` SET `mtime_ms` = CAST(strftime('%s', `created_at`) AS INTEGER) * 1000 WHERE `mtime_ms` = 0;
