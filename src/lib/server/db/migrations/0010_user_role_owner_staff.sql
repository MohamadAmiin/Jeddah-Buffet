-- drizzle-kit cannot express this change because three users objects depend on the type; this file was reordered by hand BEFORE first run, which CLAUDE.md permits; never edit it again.

ALTER TABLE "users" DROP CONSTRAINT "users_owner_has_credentials";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_non_owner_has_no_credentials";
--> statement-breakpoint
DROP INDEX "users_one_owner_per_restaurant";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;
--> statement-breakpoint
UPDATE "users" SET "role" = 'staff', "updated_at" = now() WHERE "role" IN ('cashier', 'waiter');
--> statement-breakpoint
DROP TYPE "public"."user_role";
--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'staff');
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owner_has_credentials" CHECK ("users"."role" <> 'owner' or ("users"."email" is not null and "users"."password_hash" is not null));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_non_owner_has_no_credentials" CHECK ("users"."role" = 'owner' or ("users"."email" is null and "users"."password_hash" is null));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_owner_per_restaurant" ON "users" USING btree ("restaurant_id") WHERE "users"."role" = 'owner';
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owner_has_no_role_staff_has_one" CHECK (("users"."role" = 'owner') = ("users"."role_id" is null));

