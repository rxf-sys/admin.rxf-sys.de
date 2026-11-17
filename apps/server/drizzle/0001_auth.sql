CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_start` integer NOT NULL,
	`locked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`user_id` integer NOT NULL,
	`csrf_token` text NOT NULL,
	`mfa_done` integer DEFAULT false NOT NULL,
	`elevated_until` integer,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `setup_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`code_hash` text,
	`expires_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `user_backup_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_backup_codes_user` ON `user_backup_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_passwords` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_totp` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`ciphertext` blob,
	`iv` blob,
	`tag` blob,
	`key_id` text,
	`confirmed_at` integer,
	`last_step` integer,
	`pending_ciphertext` blob,
	`pending_iv` blob,
	`pending_tag` blob,
	`pending_key_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);