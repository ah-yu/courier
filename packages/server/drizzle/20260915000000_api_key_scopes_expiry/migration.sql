ALTER TABLE `api_keys` ADD `scopes` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `expires_at` text;
