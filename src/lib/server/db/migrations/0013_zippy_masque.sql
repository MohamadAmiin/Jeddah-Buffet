CREATE TABLE "menu_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_images_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "menu_images_content_type_valid" CHECK ("menu_images"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "menu_images_byte_size_range" CHECK ("menu_images"."byte_size" between 1 and 409600),
	CONSTRAINT "menu_images_byte_size_matches" CHECK (octet_length("menu_images"."bytes") = "menu_images"."byte_size")
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_order_type_valid";--> statement-breakpoint
ALTER TABLE "menu_items" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_images" ADD CONSTRAINT "menu_images_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_images_restaurant_id_idx" ON "menu_images" USING btree ("restaurant_id");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_image_fk" FOREIGN KEY ("restaurant_id","image_id") REFERENCES "public"."menu_images"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_items_image_idx" ON "menu_items" USING btree ("image_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_type_valid" CHECK ("orders"."order_type" in ('dine_in', 'takeaway', 'delivery'));