ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_tax_rate_bp_range";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP CONSTRAINT "restaurant_settings_tax_rate_bp_range";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP CONSTRAINT "restaurant_settings_receipt_footer_length";--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN "tax_rate_bp";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP COLUMN "tax_rate_bp";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP COLUMN "accepts_card";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP COLUMN "accepts_mobile";--> statement-breakpoint
ALTER TABLE "restaurant_settings" DROP COLUMN "receipt_footer";