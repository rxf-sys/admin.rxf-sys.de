CREATE TABLE `plugin_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`config_json` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`instance_id` text NOT NULL,
	`slot` text NOT NULL,
	`field` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`tag` blob NOT NULL,
	`key_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `slot`, `field`),
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
