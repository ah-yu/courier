ALTER TABLE `vaults` DROP COLUMN `verification_hash`;--> statement-breakpoint
ALTER TABLE `vaults` DROP COLUMN `verification_salt`;--> statement-breakpoint
ALTER TABLE `vaults` ADD `key_check` text;