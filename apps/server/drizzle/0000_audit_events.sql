CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor_user_id` integer,
	`actor_ip` text,
	`event` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`instance_id` text,
	`details_json` text DEFAULT '{}' NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_ts` ON `audit_events` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_events_event_ts` ON `audit_events` (`event`,`ts`);