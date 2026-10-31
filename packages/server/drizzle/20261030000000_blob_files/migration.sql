CREATE TABLE `blobs` (
	`vault_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`file` text NOT NULL,
	`offset` integer NOT NULL,
	`length` integer NOT NULL,
	`plaintext_size` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE cascade,
	PRIMARY KEY(`vault_id`, `content_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_blobs_file` ON `blobs` (`file`);
