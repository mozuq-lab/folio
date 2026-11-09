CREATE TABLE `folio_articles` (
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`url` text NOT NULL,
	`published_at` text NOT NULL,
	`fetched_at` text NOT NULL,
	`read_at` text,
	`updated_seq` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`user_id`, `article_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folio_articles_user_url_unique` ON `folio_articles` (`user_id`,`url`);--> statement-breakpoint
CREATE INDEX `folio_articles_user_seq_idx` ON `folio_articles` (`user_id`,`updated_seq`,`article_id`);--> statement-breakpoint
CREATE INDEX `folio_articles_fetched_at_idx` ON `folio_articles` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `folio_feed_state` (
	`user_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`last_fetched_at` text,
	`etag` text,
	`last_modified` text,
	`last_error` text,
	PRIMARY KEY(`user_id`, `feed_id`)
);
--> statement-breakpoint
CREATE TABLE `folio_feeds` (
	`user_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `feed_id`)
);
--> statement-breakpoint
CREATE TABLE `folio_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`last_seen_at` text NOT NULL
);
