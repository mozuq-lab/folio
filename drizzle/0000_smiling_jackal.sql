CREATE TABLE `folio_libraries` (
	`user_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
