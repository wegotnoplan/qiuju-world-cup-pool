CREATE TABLE `final_pool_closures` (
	`fixture_id` text PRIMARY KEY NOT NULL,
	`rule_version` text NOT NULL,
	`participant_count` integer NOT NULL,
	`remaining_pool_cents` integer NOT NULL,
	`performance_pool_cents` integer NOT NULL,
	`ranking_pool_cents` integer NOT NULL,
	`participation_pool_cents` integer NOT NULL,
	`distributed_cents` integer NOT NULL,
	`undistributed_cents` integer NOT NULL,
	`winners_exist` integer NOT NULL,
	`closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `final_pool_results` (
	`fixture_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`display_order` integer NOT NULL,
	`bet_count` integer NOT NULL,
	`stake_cents` integer NOT NULL,
	`normal_payout_cents` integer NOT NULL,
	`base_net_cents` integer NOT NULL,
	`base_rank` integer NOT NULL,
	`m104_winning_weight` integer NOT NULL,
	`performance_bonus_cents` integer NOT NULL,
	`ranking_bonus_cents` integer NOT NULL,
	`participation_bonus_cents` integer NOT NULL,
	`bonus_cents` integer NOT NULL,
	`total_payout_cents` integer NOT NULL,
	`final_net_cents` integer NOT NULL,
	`final_rank` integer NOT NULL,
	PRIMARY KEY(`fixture_id`, `participant_id`),
	FOREIGN KEY (`fixture_id`) REFERENCES `final_pool_closures`(`fixture_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `final_pool_results_fixture_rank_idx` ON `final_pool_results` (`fixture_id`,`final_rank`,`display_order`);
