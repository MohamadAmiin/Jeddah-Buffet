ALTER TABLE "restaurant_settings" ADD COLUMN "tax_mode" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "tax_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "currency_code" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tax_mode_valid" CHECK ("restaurant_settings"."tax_mode" is null or "restaurant_settings"."tax_mode" in ('exclusive', 'inclusive'));--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tax_rate_bp_range" CHECK ("restaurant_settings"."tax_rate_bp" is null or ("restaurant_settings"."tax_rate_bp" >= 0 and "restaurant_settings"."tax_rate_bp" <= 10000));--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_currency_code_format" CHECK ("restaurant_settings"."currency_code" is null or "restaurant_settings"."currency_code" ~ '^[A-Z]{3}$');