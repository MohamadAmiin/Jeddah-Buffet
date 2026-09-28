-- Seed the two spec 8 roles for every restaurant that exists BEFORE editable roles, and point
-- its legacy cashier/waiter users at them. New restaurants get the same rows from
-- restaurantInitializers (insertDefaultRoles). Idempotent: re-running changes nothing.
INSERT INTO "roles" ("restaurant_id", "name")
SELECT r."id", v."name"
FROM "restaurants" r CROSS JOIN (VALUES ('Cashier'), ('Waiter')) AS v("name")
ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("restaurant_id", "role_id", "permission_key")
SELECT ro."restaurant_id", ro."id", k."key"
FROM "roles" ro
JOIN (VALUES
  ('cashier', 'pos.sell'), ('cashier', 'pos.payment'), ('cashier', 'pos.print_receipt'),
  ('cashier', 'pos.void_unsent_item'), ('cashier', 'pos.cash_payout'),
  ('waiter', 'pos.create_order'), ('waiter', 'pos.view_menu'), ('waiter', 'pos.modify_order'),
  ('waiter', 'pos.send_to_kitchen'), ('waiter', 'pos.transfer_table')
) AS k("role_name", "key") ON lower(ro."name") = k."role_name"
WHERE ro."archived_at" IS NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
--> statement-breakpoint
UPDATE "users" u
SET "role_id" = ro."id", "updated_at" = now()
FROM "roles" ro
WHERE u."role_id" IS NULL
  AND u."role"::text IN ('cashier', 'waiter')
  AND ro."restaurant_id" = u."restaurant_id"
  AND ro."archived_at" IS NULL
  AND lower(ro."name") = u."role"::text;
