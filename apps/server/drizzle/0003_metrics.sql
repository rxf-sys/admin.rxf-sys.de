CREATE TABLE `entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`last_seen` integer,
	`attrs_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_instance_kind_external` ON `entities` (`instance_id`,`kind`,`external_id`);--> statement-breakpoint
CREATE INDEX `entities_kind_status` ON `entities` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `metric_1h` (
	`series_id` integer NOT NULL,
	`bucket` integer NOT NULL,
	`avg` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`series_id`, `bucket`),
	FOREIGN KEY (`series_id`) REFERENCES `metric_series`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metric_5m` (
	`series_id` integer NOT NULL,
	`bucket` integer NOT NULL,
	`avg` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`series_id`, `bucket`),
	FOREIGN KEY (`series_id`) REFERENCES `metric_series`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metric_raw` (
	`series_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`series_id`, `ts`),
	FOREIGN KEY (`series_id`) REFERENCES `metric_series`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metric_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` integer NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_series_entity_name` ON `metric_series` (`entity_id`,`name`);