CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"merchant_number" text,
	"enabled" boolean NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "payment_methods_id_restaurant_kind_unique" UNIQUE("id","restaurant_id","kind"),
	CONSTRAINT "payment_methods_kind_valid" CHECK ("payment_methods"."kind" in ('cash', 'card', 'mobile')),
	CONSTRAINT "payment_methods_name_valid" CHECK (char_length("payment_methods"."name") between 1 and 40 and "payment_methods"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "payment_methods_merchant_number_valid" CHECK ("payment_methods"."merchant_number" is null or (char_length("payment_methods"."merchant_number") between 1 and 40 and "payment_methods"."merchant_number" !~ '[[:cntrl:]]')),
	CONSTRAINT "payment_methods_cash_rules" CHECK ("payment_methods"."kind" <> 'cash' or ("payment_methods"."enabled" and "payment_methods"."archived_at" is null and "payment_methods"."merchant_number" is null))
);
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
	"restaurant_id" uuid NOT NULL,
	"section" text NOT NULL,
	"position" smallint NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_lines_pk" PRIMARY KEY("restaurant_id","section","position"),
	CONSTRAINT "receipt_lines_section_valid" CHECK ("receipt_lines"."section" in ('header', 'footer')),
	CONSTRAINT "receipt_lines_position_range" CHECK ("receipt_lines"."position" between 1 and 5),
	CONSTRAINT "receipt_lines_body_valid" CHECK (char_length("receipt_lines"."body") between 1 and 120 and "receipt_lines"."body" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "receipt_logos" (
	"restaurant_id" uuid PRIMARY KEY NOT NULL,
	"width_dots" integer NOT NULL,
	"height_dots" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"bitmap" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_logos_width_dots_valid" CHECK ("receipt_logos"."width_dots" between 8 and 384 and "receipt_logos"."width_dots" % 8 = 0),
	CONSTRAINT "receipt_logos_height_dots_range" CHECK ("receipt_logos"."height_dots" between 1 and 160),
	CONSTRAINT "receipt_logos_byte_size_matches" CHECK ("receipt_logos"."byte_size" = ("receipt_logos"."width_dots" / 8) * "receipt_logos"."height_dots" and octet_length("receipt_logos"."bitmap") = "receipt_logos"."byte_size"),
	CONSTRAINT "receipt_logos_sha256_format" CHECK ("receipt_logos"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "tax_rates_name_valid" CHECK (char_length("tax_rates"."name") between 1 and 40 and "tax_rates"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "tax_rates_rate_bp_range" CHECK ("tax_rates"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "tax_rate_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_method_name" text;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "default_tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_cashier" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_table" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_business_date" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_order_type" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_unit_price" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_currency_line" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_device_line" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_show_payment_numbers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_tax_breakdown" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "receipt_payment_numbers_heading" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_logos" ADD CONSTRAINT "receipt_logos_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_methods_restaurant_id_idx" ON "payment_methods" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_one_cash" ON "payment_methods" USING btree ("restaurant_id") WHERE "payment_methods"."kind" = 'cash';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_name_unique" ON "payment_methods" USING btree ("restaurant_id",lower("name")) WHERE "payment_methods"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "tax_rates_restaurant_id_idx" ON "tax_rates" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_name_unique" ON "tax_rates" USING btree ("restaurant_id",lower("name")) WHERE "tax_rates"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tax_rate_fk" FOREIGN KEY ("restaurant_id","tax_rate_id") REFERENCES "public"."tax_rates"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tax_rate_fk" FOREIGN KEY ("restaurant_id","tax_rate_id") REFERENCES "public"."tax_rates"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_fk" FOREIGN KEY ("restaurant_id","payment_method_id","method") REFERENCES "public"."payment_methods"("restaurant_id","id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_default_tax_rate_fk" FOREIGN KEY ("restaurant_id","default_tax_rate_id") REFERENCES "public"."tax_rates"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_items_tax_rate_idx" ON "menu_items" USING btree ("tax_rate_id");--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tax_rate_name_length" CHECK ("order_lines"."tax_rate_name" is null or char_length("order_lines"."tax_rate_name") between 1 and 40);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_pair" CHECK (("payments"."payment_method_id" is null) = ("payments"."payment_method_name" is null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_name_length" CHECK ("payments"."payment_method_name" is null or char_length("payments"."payment_method_name") between 1 and 40);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_receipt_payment_numbers_heading_length" CHECK ("restaurant_settings"."receipt_payment_numbers_heading" is null or (char_length("restaurant_settings"."receipt_payment_numbers_heading") between 1 and 40 and "restaurant_settings"."receipt_payment_numbers_heading" !~ '[[:cntrl:]]'));