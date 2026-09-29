ALTER TABLE "orders" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_address" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_phone" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "tax_registration_number" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_footer" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_note_length" CHECK ("orders"."note" is null or char_length("orders"."note") between 1 and 140);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_receipt_address_length" CHECK ("restaurant_settings"."receipt_address" is null or char_length("restaurant_settings"."receipt_address") between 1 and 120);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_receipt_phone_length" CHECK ("restaurant_settings"."receipt_phone" is null or char_length("restaurant_settings"."receipt_phone") between 1 and 40);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tax_registration_number_length" CHECK ("restaurant_settings"."tax_registration_number" is null or char_length("restaurant_settings"."tax_registration_number") between 1 and 40);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_receipt_footer_length" CHECK ("restaurant_settings"."receipt_footer" is null or char_length("restaurant_settings"."receipt_footer") between 1 and 120);