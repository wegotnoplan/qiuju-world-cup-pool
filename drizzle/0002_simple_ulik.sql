CREATE TABLE `api_football_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`response_body` text NOT NULL,
	`upstream_status` integer NOT NULL,
	`quota_limit` integer,
	`quota_remaining` integer,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_football_cache_expires_idx` ON `api_football_cache` (`expires_at`);
--> statement-breakpoint
UPDATE `fixtures`
SET `provider_match_id` = '1585131', `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'wc2026-m101'
  AND (`provider_match_id` IS NULL OR `provider_match_id` = '');
