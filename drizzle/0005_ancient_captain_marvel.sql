ALTER TABLE `fixtures` ADD `after_extra_home` integer;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `after_extra_away` integer;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `penalty_home` integer;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `penalty_away` integer;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `resolution_source` text;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `resolved_at` text;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `after_extra_home` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `after_extra_away` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `penalty_home` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `penalty_away` integer;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `winner_side` text;--> statement-breakpoint
ALTER TABLE `result_audits` ADD `resolution_source` text;