ALTER TABLE "order_lines" ADD COLUMN "menu_tax_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "charged_minor" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_override_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_override_rate_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_override_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_override_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_removed_minor" bigint;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_zero_tax" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "offered_for_bills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_override_rate_fk" FOREIGN KEY ("restaurant_id","tax_override_rate_id") REFERENCES "public"."tax_rates"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_override_values_valid" CHECK (("order_lines"."menu_tax_rate_bp" is null or "order_lines"."menu_tax_rate_bp" between 0 and 10000) and ("order_lines"."charged_minor" is null or "order_lines"."charged_minor" >= 0));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_override_all_or_none" CHECK (("orders"."tax_override_rate_id" is null and "orders"."tax_override_rate_name" is null and "orders"."tax_override_rate_bp" is null and "orders"."tax_override_reason" is null and "orders"."tax_removed_minor" is null) or ("orders"."tax_override_rate_id" is not null and "orders"."tax_override_rate_name" is not null and "orders"."tax_override_rate_bp" is not null and "orders"."tax_override_reason" is not null and "orders"."tax_removed_minor" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_override_values_valid" CHECK ("orders"."tax_override_rate_id" is null or (char_length("orders"."tax_override_rate_name") between 1 and 40 and "orders"."tax_override_rate_bp" between 0 and 10000 and char_length("orders"."tax_override_reason") between 1 and 80 and "orders"."tax_override_reason" !~ '[[:cntrl:]]' and "orders"."tax_removed_minor" >= 0));--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_offered_zero_rate" CHECK (not "tax_rates"."offered_for_bills" or "tax_rates"."rate_bp" = 0);