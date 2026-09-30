CREATE TABLE "ingredient_purchase_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_qty_per_unit" numeric(12, 3) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_purchase_units_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "ingredient_purchase_units_name_length" CHECK (char_length(btrim("ingredient_purchase_units"."name")) between 1 and 24),
	CONSTRAINT "ingredient_purchase_units_factor_positive" CHECK ("ingredient_purchase_units"."base_qty_per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_unit" text NOT NULL,
	"on_hand_qty" numeric(12, 3) DEFAULT '0' NOT NULL,
	"inventory_value_minor" bigint DEFAULT 0 NOT NULL,
	"avg_unit_cost_micro" bigint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredients_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "ingredients_name_length" CHECK (char_length(btrim("ingredients"."name")) between 1 and 80),
	CONSTRAINT "ingredients_base_unit_length" CHECK (char_length(btrim("ingredients"."base_unit")) between 1 and 16),
	CONSTRAINT "ingredients_avg_non_negative" CHECK ("ingredients"."avg_unit_cost_micro" >= 0),
	CONSTRAINT "ingredients_zero_qty_zero_value" CHECK ("ingredients"."on_hand_qty" <> 0 or "ingredients"."inventory_value_minor" = 0),
	CONSTRAINT "ingredients_positive_qty_non_negative_value" CHECK ("ingredients"."on_hand_qty" <= 0 or "ingredients"."inventory_value_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "opening_stock_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"purchase_unit_name" text NOT NULL,
	"unit_qty" numeric(12, 3) NOT NULL,
	"base_qty_per_unit" numeric(12, 3) NOT NULL,
	"base_qty" numeric(12, 3) NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"value_minor" bigint NOT NULL,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_stock_entries_amounts_valid" CHECK ("opening_stock_entries"."unit_qty" > 0 and "opening_stock_entries"."base_qty_per_unit" > 0 and "opening_stock_entries"."base_qty" > 0 and "opening_stock_entries"."unit_cost_minor" >= 0 and "opening_stock_entries"."value_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"modifier_id" uuid,
	"ingredient_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_lines_one_owner" CHECK (("recipe_lines"."menu_item_id" is null) <> ("recipe_lines"."modifier_id" is null)),
	CONSTRAINT "recipe_lines_qty_sign" CHECK (("recipe_lines"."menu_item_id" is not null and "recipe_lines"."qty" > 0) or ("recipe_lines"."modifier_id" is not null and "recipe_lines"."qty" <> 0))
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"system_qty" numeric(12, 3) NOT NULL,
	"counted_qty" numeric(12, 3) NOT NULL,
	"difference_qty" numeric(12, 3) NOT NULL,
	"cost_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_lines_counted_non_negative" CHECK ("stock_count_lines"."counted_qty" >= 0),
	CONSTRAINT "stock_count_lines_difference" CHECK ("stock_count_lines"."difference_qty" = "stock_count_lines"."counted_qty" - "stock_count_lines"."system_qty")
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_id_restaurant_unique" UNIQUE("id","restaurant_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"restaurant_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"movement_type" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"cost_minor" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_type_valid" CHECK ("stock_movements"."movement_type" in ('purchase', 'purchase_reversal', 'opening_stock', 'sale_consumption', 'waste', 'count_adjustment', 'comp', 'revaluation')),
	CONSTRAINT "stock_movements_source_valid" CHECK ("stock_movements"."source_type" in ('purchase', 'order', 'waste_entry', 'stock_count', 'opening_stock')),
	CONSTRAINT "stock_movements_sign_by_type" CHECK (("stock_movements"."movement_type" in ('purchase', 'opening_stock') and "stock_movements"."qty" > 0 and "stock_movements"."cost_minor" >= 0) or ("stock_movements"."movement_type" in ('purchase_reversal', 'sale_consumption', 'waste', 'comp') and "stock_movements"."qty" < 0 and "stock_movements"."cost_minor" <= 0) or ("stock_movements"."movement_type" = 'count_adjustment' and "stock_movements"."qty" <> 0) or ("stock_movements"."movement_type" = 'revaluation' and "stock_movements"."qty" = 0 and "stock_movements"."cost_minor" <> 0))
);
--> statement-breakpoint
CREATE TABLE "waste_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waste_entries_qty_positive" CHECK ("waste_entries"."qty" > 0),
	CONSTRAINT "waste_entries_reason_valid" CHECK ("waste_entries"."reason" in ('spoilage', 'preparation_error', 'breakage', 'other')),
	CONSTRAINT "waste_entries_note_for_other" CHECK ("waste_entries"."reason" <> 'other' or ("waste_entries"."note" is not null and char_length(btrim("waste_entries"."note")) between 3 and 200))
);
--> statement-breakpoint
CREATE TABLE "purchase_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"purchase_unit_name" text NOT NULL,
	"unit_qty" numeric(12, 3) NOT NULL,
	"base_qty_per_unit" numeric(12, 3) NOT NULL,
	"base_qty" numeric(12, 3) NOT NULL,
	"line_cost_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_lines_purchase_line_no_unique" UNIQUE("purchase_id","line_no"),
	CONSTRAINT "purchase_lines_amounts_valid" CHECK ("purchase_lines"."unit_qty" > 0 and "purchase_lines"."base_qty_per_unit" > 0 and "purchase_lines"."base_qty" > 0 and "purchase_lines"."line_cost_minor" >= 0 and "purchase_lines"."line_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"business_date" date NOT NULL,
	"paid_by" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"reversal_reason" text,
	"reversal_entry_id" uuid,
	CONSTRAINT "purchases_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "purchases_supplier_name_length" CHECK (char_length(btrim("purchases"."supplier_name")) between 1 and 120),
	CONSTRAINT "purchases_paid_by_valid" CHECK ("purchases"."paid_by" in ('cash', 'bank', 'credit')),
	CONSTRAINT "purchases_total_non_negative" CHECK ("purchases"."total_minor" >= 0),
	CONSTRAINT "purchases_reversal_fields" CHECK (("purchases"."reversed_at" is null) = ("purchases"."reversed_by_user_id" is null) and ("purchases"."reversed_at" is null) = ("purchases"."reversal_reason" is null) and ("purchases"."reversal_reason" is null or char_length(btrim("purchases"."reversal_reason")) between 3 and 200))
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"paid_from" text NOT NULL,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"reversal_reason" text,
	"reversal_entry_id" uuid,
	CONSTRAINT "supplier_payments_amount_positive" CHECK ("supplier_payments"."amount_minor" > 0),
	CONSTRAINT "supplier_payments_paid_from_valid" CHECK ("supplier_payments"."paid_from" in ('cash', 'bank')),
	CONSTRAINT "supplier_payments_reversal_fields" CHECK (("supplier_payments"."reversed_at" is null) = ("supplier_payments"."reversed_by_user_id" is null) and ("supplier_payments"."reversed_at" is null) = ("supplier_payments"."reversal_reason" is null) and ("supplier_payments"."reversal_reason" is null or char_length(btrim("supplier_payments"."reversal_reason")) between 3 and 200))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_event_valid";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_valid";--> statement-breakpoint
ALTER TABLE "ingredient_purchase_units" ADD CONSTRAINT "ingredient_purchase_units_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_purchase_units" ADD CONSTRAINT "ingredient_purchase_units_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_entries" ADD CONSTRAINT "opening_stock_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_entries" ADD CONSTRAINT "opening_stock_entries_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_entries" ADD CONSTRAINT "opening_stock_entries_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_menu_item_fk" FOREIGN KEY ("restaurant_id","menu_item_id") REFERENCES "public"."menu_items"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("restaurant_id","count_id") REFERENCES "public"."stock_counts"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_fk" FOREIGN KEY ("restaurant_id","purchase_id") REFERENCES "public"."purchases"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_ingredient_fk" FOREIGN KEY ("restaurant_id","ingredient_id") REFERENCES "public"."ingredients"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchase_fk" FOREIGN KEY ("restaurant_id","purchase_id") REFERENCES "public"."purchases"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_purchase_units_name_unique" ON "ingredient_purchase_units" USING btree ("ingredient_id",lower("name")) WHERE "ingredient_purchase_units"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "ingredient_purchase_units_ingredient_idx" ON "ingredient_purchase_units" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_name_unique" ON "ingredients" USING btree ("restaurant_id",lower("name")) WHERE "ingredients"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "ingredients_restaurant_id_idx" ON "ingredients" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_stock_entries_ingredient_unique" ON "opening_stock_entries" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_lines_item_ingredient_unique" ON "recipe_lines" USING btree ("menu_item_id","ingredient_id") WHERE "recipe_lines"."menu_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_lines_modifier_ingredient_unique" ON "recipe_lines" USING btree ("modifier_id","ingredient_id") WHERE "recipe_lines"."modifier_id" is not null;--> statement-breakpoint
CREATE INDEX "recipe_lines_ingredient_idx" ON "recipe_lines" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_count_ingredient_unique" ON "stock_count_lines" USING btree ("count_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "stock_counts_restaurant_business_date_idx" ON "stock_counts" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "stock_movements_ingredient_time_idx" ON "stock_movements" USING btree ("restaurant_id","ingredient_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_restaurant_business_date_idx" ON "stock_movements" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "stock_movements_source_idx" ON "stock_movements" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "waste_entries_restaurant_business_date_idx" ON "waste_entries" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "purchase_lines_ingredient_idx" ON "purchase_lines" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "purchases_restaurant_business_date_idx" ON "purchases" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "purchases_restaurant_recorded_idx" ON "purchases" USING btree ("restaurant_id","recorded_at" desc);--> statement-breakpoint
CREATE INDEX "supplier_payments_purchase_idx" ON "supplier_payments" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_entry_unique" ON "journal_entries" USING btree ("reverses_entry_id") WHERE "journal_entries"."reverses_entry_id" is not null;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_event_valid" CHECK ("journal_entries"."event" in ('cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close', 'purchase_paid', 'purchase_on_credit', 'supplier_paid', 'waste', 'stock_count_shortfall', 'stock_count_surplus', 'inventory_revaluation', 'opening_stock'));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_valid" CHECK ("journal_entries"."source_type" in ('order', 'pos_session', 'purchase', 'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock'));