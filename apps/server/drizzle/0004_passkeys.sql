CREATE TABLE `user_webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`transports_json` text DEFAULT '[]' NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_webauthn_credentials_user` ON `user_webauthn_credentials` (`user_id`);