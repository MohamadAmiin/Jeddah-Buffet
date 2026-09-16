CREATE TABLE "pos_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"device_code" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"registered_by_user_id" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "pos_devices_device_code_format" CHECK ("pos_devices"."device_code" ~ '^[A-Z0-9]{1,8}$')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "client_op_id" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "pos_idle_lock_seconds" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_pin_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_devices_token_hash_unique" ON "pos_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_devices_restaurant_device_code_unique" ON "pos_devices" USING btree ("restaurant_id","device_code");--> statement-breakpoint
CREATE INDEX "pos_devices_restaurant_id_idx" ON "pos_devices" USING btree ("restaurant_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_device_client_op_unique" ON "audit_log" USING btree ("device_id","client_op_id") WHERE "audit_log"."client_op_id" is not null;