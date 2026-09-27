CREATE TABLE "role_permissions" (
	"restaurant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("role_id","permission_key"),
	CONSTRAINT "role_permissions_key_pos_only" CHECK ("role_permissions"."permission_key" like 'pos.%')
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "roles_name_length" CHECK (length(btrim("roles"."name")) between 1 and 60),
	CONSTRAINT "roles_name_not_owner" CHECK (lower(btrim("roles"."name")) <> 'owner')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("restaurant_id","role_id") REFERENCES "public"."roles"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_permissions_restaurant_idx" ON "role_permissions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "roles_restaurant_id_idx" ON "roles" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_unique" ON "roles" USING btree ("restaurant_id",lower("name")) WHERE "roles"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_fk" FOREIGN KEY ("restaurant_id","role_id") REFERENCES "public"."roles"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_role_id_idx" ON "users" USING btree ("role_id");