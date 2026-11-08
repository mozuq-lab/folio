CREATE TABLE `folio_library_chunks` (
	`user_id` text NOT NULL,
	`operation_token` text NOT NULL,
	`part` integer NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`user_id`, `operation_token`, `part`)
);
