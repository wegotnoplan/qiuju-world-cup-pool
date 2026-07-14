CREATE TABLE `bets` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`market_type` text NOT NULL,
	`selection_code` text NOT NULL,
	`label` text NOT NULL,
	`odds` real NOT NULL,
	`stake_cents` integer NOT NULL,
	`placed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`theoretical_payout_cents` integer DEFAULT 0 NOT NULL,
	`payout_cents` integer DEFAULT 0 NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offer_id`) REFERENCES `odds_offers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bets_fixture_participant_offer_unique` ON `bets` (`fixture_id`,`participant_id`,`offer_id`);--> statement-breakpoint
CREATE INDEX `bets_fixture_idx` ON `bets` (`fixture_id`);--> statement-breakpoint
CREATE INDEX `bets_participant_fixture_idx` ON `bets` (`participant_id`,`fixture_id`);--> statement-breakpoint
CREATE TABLE `fixtures` (
	`id` text PRIMARY KEY NOT NULL,
	`match_code` text NOT NULL,
	`sequence` integer NOT NULL,
	`stage` text NOT NULL,
	`home_team_code` text NOT NULL,
	`home_team_name` text NOT NULL,
	`home_team_english_name` text NOT NULL,
	`home_team_placeholder` integer DEFAULT false NOT NULL,
	`away_team_code` text NOT NULL,
	`away_team_name` text NOT NULL,
	`away_team_english_name` text NOT NULL,
	`away_team_placeholder` integer DEFAULT false NOT NULL,
	`kickoff_at` text NOT NULL,
	`lock_at` text NOT NULL,
	`result_sync_due_at` text NOT NULL,
	`provider_match_id` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`regular_home` integer,
	`regular_away` integer,
	`result_source` text,
	`result_basis` text,
	`review_note` text,
	`settled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixtures_match_code_unique` ON `fixtures` (`match_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `fixtures_sequence_unique` ON `fixtures` (`sequence`);--> statement-breakpoint
CREATE INDEX `fixtures_status_sequence_idx` ON `fixtures` (`status`,`sequence`);--> statement-breakpoint
CREATE TABLE `odds_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`market_type` text NOT NULL,
	`selection_code` text NOT NULL,
	`label` text NOT NULL,
	`odds` real NOT NULL,
	`rules_text` text NOT NULL,
	`source` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`uploaded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `odds_offers_fixture_active_idx` ON `odds_offers` (`fixture_id`,`active`);--> statement-breakpoint
CREATE INDEX `odds_offers_fixture_market_idx` ON `odds_offers` (`fixture_id`,`market_type`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_order` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `result_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text NOT NULL,
	`provider_status` text,
	`regular_home` integer,
	`regular_away` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `result_audits_fixture_created_idx` ON `result_audits` (`fixture_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`fixture_id` text PRIMARY KEY NOT NULL,
	`regular_home` integer NOT NULL,
	`regular_away` integer NOT NULL,
	`result_basis` text NOT NULL,
	`result_source` text NOT NULL,
	`pool_before_cents` integer NOT NULL,
	`current_fixture_stake_cents` integer NOT NULL,
	`eligible_pool_cents` integer NOT NULL,
	`theoretical_payout_cents` integer NOT NULL,
	`paid_cents` integer NOT NULL,
	`scale_bps` integer NOT NULL,
	`note` text,
	`settled_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
