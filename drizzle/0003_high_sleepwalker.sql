CREATE TABLE `folio_seq` (
	`user_id` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `folio_seq` (`user_id`, `value`) SELECT `user_id`, MAX(`updated_seq`) FROM `folio_articles` GROUP BY `user_id`;
