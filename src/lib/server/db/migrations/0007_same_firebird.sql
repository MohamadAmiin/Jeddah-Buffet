CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_categories_id_restaurant_unique" UNIQUE("id","restaurant_id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_pk" PRIMARY KEY("menu_item_id","modifier_group_id")
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"tax_rate_bp" integer,
	"is_available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_items_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "menu_items_price_minor_non_negative" CHECK ("menu_items"."price_minor" >= 0),
	CONSTRAINT "menu_items_tax_rate_bp_range" CHECK ("menu_items"."tax_rate_bp" is null or ("menu_items"."tax_rate_bp" >= 0 and "menu_items"."tax_rate_bp" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_groups_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "modifier_groups_select_range" CHECK ("modifier_groups"."min_select" >= 0 and "modifier_groups"."max_select" >= "modifier_groups"."min_select")
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_minor" bigint NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "menu_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_item_fk" FOREIGN KEY ("restaurant_id","menu_item_id") REFERENCES "public"."menu_items"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_group_fk" FOREIGN KEY ("restaurant_id","modifier_group_id") REFERENCES "public"."modifier_groups"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_fk" FOREIGN KEY ("restaurant_id","category_id") REFERENCES "public"."menu_categories"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_group_fk" FOREIGN KEY ("restaurant_id","group_id") REFERENCES "public"."modifier_groups"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_categories_restaurant_id_idx" ON "menu_categories" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_categories_name_unique" ON "menu_categories" USING btree ("restaurant_id",lower("name")) WHERE "menu_categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_group_idx" ON "menu_item_modifier_groups" USING btree ("modifier_group_id");--> statement-breakpoint
CREATE INDEX "menu_items_restaurant_category_idx" ON "menu_items" USING btree ("restaurant_id","category_id");--> statement-breakpoint
CREATE INDEX "modifier_groups_restaurant_id_idx" ON "modifier_groups" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "modifiers_restaurant_group_idx" ON "modifiers" USING btree ("restaurant_id","group_id");