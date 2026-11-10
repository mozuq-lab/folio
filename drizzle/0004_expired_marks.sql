CREATE TABLE `folio_expired` (
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`url` text NOT NULL,
	`expired_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `article_id`)
);
--> statement-breakpoint
CREATE INDEX `folio_expired_user_url_idx` ON `folio_expired` (`user_id`,`url`);--> statement-breakpoint
CREATE INDEX `folio_expired_expired_at_idx` ON `folio_expired` (`expired_at`);