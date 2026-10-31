CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_versions` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`file_id` text NOT NULL,
	`encrypted_path` text NOT NULL,
	`version_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT `fk_file_versions_vault_id_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`verification_hash` text NOT NULL,
	`verification_salt` text NOT NULL,
	`encryption_salt` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_file_versions_vault_file_created` ON `file_versions` (`vault_id`,`file_id`,`created_at`);