CREATE TABLE `fixture_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`bet_count` integer NOT NULL,
	`stake_cents` integer NOT NULL,
	`locked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixture_entries_fixture_participant_unique` ON `fixture_entries` (`fixture_id`,`participant_id`);--> statement-breakpoint
CREATE INDEX `fixture_entries_fixture_locked_idx` ON `fixture_entries` (`fixture_id`,`locked_at`);--> statement-breakpoint
INSERT INTO `fixture_entries` (`id`, `fixture_id`, `participant_id`, `bet_count`, `stake_cents`, `locked_at`)
SELECT
	'legacy:' || `fixture_id` || ':' || `participant_id`,
	`fixture_id`,
	`participant_id`,
	COUNT(*),
	SUM(`stake_cents`),
	MAX(`placed_at`)
FROM `bets`
GROUP BY `fixture_id`, `participant_id`;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `half_home` integer;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `half_away` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `half_home` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `half_away` integer;--> statement-breakpoint
ALTER TABLE `settlements` ADD `half_home` integer;--> statement-breakpoint
ALTER TABLE `settlements` ADD `half_away` integer;--> statement-breakpoint
UPDATE `fixtures` SET `result_sync_due_at` = '2026-07-15T07:00:00+08:00' WHERE `id` = 'wc2026-m101';--> statement-breakpoint
UPDATE `fixtures` SET `result_sync_due_at` = '2026-07-16T07:00:00+08:00' WHERE `id` = 'wc2026-m102';--> statement-breakpoint
UPDATE `fixtures` SET `result_sync_due_at` = '2026-07-19T09:00:00+08:00' WHERE `id` = 'wc2026-m103';--> statement-breakpoint
UPDATE `fixtures` SET `result_sync_due_at` = '2026-07-20T07:00:00+08:00' WHERE `id` = 'wc2026-m104';
