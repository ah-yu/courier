CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`scopes` text DEFAULT 'admin' NOT NULL,
	`expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`vault_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`file` text NOT NULL,
	`offset` integer NOT NULL,
	`length` integer NOT NULL,
	`plaintext_size` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT `blobs_pk` PRIMARY KEY(`vault_id`, `content_hash`),
	CONSTRAINT `fk_blobs_vault_id_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_versions` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`file_id` text NOT NULL,
	`encrypted_path` text NOT NULL,
	`version_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`action` text NOT NULL,
	`device_name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT `fk_file_versions_vault_id_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`storage_bytes_limit` integer,
	`retention_days` integer,
	`max_file_bytes` integer DEFAULT 52428800 NOT NULL,
	`max_vaults` integer DEFAULT 1 NOT NULL,
	`expires_at` text,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`encryption_salt` text,
	`key_check` text,
	`owner_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT `fk_vaults_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_blobs_file` ON `blobs` (`file`);--> statement-breakpoint
CREATE INDEX `idx_file_versions_vault_file_created` ON `file_versions` (`vault_id`,`file_id`,`created_at`);