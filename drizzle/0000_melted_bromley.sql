CREATE TABLE `siftera_epochs` (
	`uid` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `siftera_records` (
	`uid` text NOT NULL,
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`sort_key` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`uid`, `collection`, `id`)
);
--> statement-breakpoint
CREATE INDEX `siftera_records_list` ON `siftera_records` (`uid`,`collection`,`sort_key`,`id`);--> statement-breakpoint
CREATE TABLE `siftera_sources` (
	`uid` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`uid`, `id`)
);
