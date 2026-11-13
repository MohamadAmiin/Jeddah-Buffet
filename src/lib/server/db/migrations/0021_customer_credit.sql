CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"method" text NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"payment_method_name" text NOT NULL,
	"tendered_minor" bigint,
	"change_minor" bigint,
	"balance_after_minor" bigint NOT NULL,
	"pos_session_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"reversal_reason" text,
	"reversal_entry_id" uuid,
	"reversal_business_date" date,
	CONSTRAINT "customer_payments_amount_positive" CHECK ("customer_payments"."amount_minor" > 0),
	CONSTRAINT "customer_payments_method_valid" CHECK ("customer_payments"."method" in ('cash', 'card', 'mobile')),
	CONSTRAINT "customer_payments_payment_method_name_length" CHECK (char_length("customer_payments"."payment_method_name") between 1 and 40),
	CONSTRAINT "customer_payments_cash_fields" CHECK (("customer_payments"."method" = 'cash' and "customer_payments"."tendered_minor" is not null and "customer_payments"."change_minor" is not null and "customer_payments"."tendered_minor" >= "customer_payments"."amount_minor" and "customer_payments"."change_minor" = "customer_payments"."tendered_minor" - "customer_payments"."amount_minor") or ("customer_payments"."method" <> 'cash' and "customer_payments"."tendered_minor" is null and "customer_payments"."change_minor" is null)),
	CONSTRAINT "customer_payments_balance_after_non_negative" CHECK ("customer_payments"."balance_after_minor" >= 0),
	CONSTRAINT "customer_payments_reversal_fields" CHECK (("customer_payments"."reversed_at" is null) = ("customer_payments"."reversed_by_user_id" is null) and ("customer_payments"."reversed_at" is null) = ("customer_payments"."reversal_reason" is null) and ("customer_payments"."reversed_at" is null) = ("customer_payments"."reversal_entry_id" is null) and ("customer_payments"."reversed_at" is null) = ("customer_payments"."reversal_business_date" is null) and ("customer_payments"."reversal_reason" is null or char_length(btrim("customer_payments"."reversal_reason")) between 3 and 200))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"credit_limit_minor" bigint,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "customers_name_valid" CHECK (char_length("customers"."name") between 1 and 80 and "customers"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "customers_phone_valid" CHECK (char_length("customers"."phone") between 3 and 32 and "customers"."phone" !~ '[[:cntrl:]]'),
	CONSTRAINT "customers_credit_limit_minor_non_negative" CHECK ("customers"."credit_limit_minor" is null or "customers"."credit_limit_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_event_valid";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_valid";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method_valid";--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT "payment_methods_kind_valid";--> statement-breakpoint
ALTER TABLE "pos_sync_ops" DROP CONSTRAINT "pos_sync_ops_kind_valid";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_fk" FOREIGN KEY ("restaurant_id","customer_id") REFERENCES "public"."customers"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_payment_method_fk" FOREIGN KEY ("restaurant_id","payment_method_id","method") REFERENCES "public"."payment_methods"("restaurant_id","id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_session_fk" FOREIGN KEY ("restaurant_id","pos_session_id") REFERENCES "public"."pos_sessions"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "customer_payments" USING btree ("restaurant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_payments_session_idx" ON "customer_payments" USING btree ("pos_session_id");--> statement-breakpoint
CREATE INDEX "customer_payments_business_date_idx" ON "customer_payments" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "customers_restaurant_id_idx" ON "customers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_unique" ON "customers" USING btree ("restaurant_id","phone") WHERE "customers"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_fk" FOREIGN KEY ("restaurant_id","customer_id") REFERENCES "public"."customers"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("restaurant_id","customer_id") WHERE "payments"."customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_one_credit" ON "payment_methods" USING btree ("restaurant_id") WHERE "payment_methods"."kind" = 'credit';--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_event_valid" CHECK ("journal_entries"."event" in ('cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close', 'purchase_paid', 'purchase_on_credit', 'supplier_paid', 'waste', 'stock_count_shortfall', 'stock_count_surplus', 'inventory_revaluation', 'opening_stock', 'credit_sale', 'customer_payment_received'));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_valid" CHECK ("journal_entries"."source_type" in ('order', 'pos_session', 'purchase', 'supplier_payment', 'waste_entry', 'stock_count', 'opening_stock', 'customer_payment'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_credit_customer" CHECK (("payments"."method" = 'credit') = ("payments"."customer_id" is not null) and ("payments"."customer_id" is null) = ("payments"."customer_name" is null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_name_length" CHECK ("payments"."customer_name" is null or char_length("payments"."customer_name") between 1 and 80);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_valid" CHECK ("payments"."method" in ('cash', 'card', 'mobile', 'credit'));--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_credit_rules" CHECK ("payment_methods"."kind" <> 'credit' or ("payment_methods"."archived_at" is null and "payment_methods"."merchant_number" is null));--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_kind_valid" CHECK ("payment_methods"."kind" in ('cash', 'card', 'mobile', 'credit'));--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_kind_valid" CHECK ("pos_sync_ops"."kind" in ('session.open', 'session.close', 'sale.complete', 'sale.abandoned', 'pin.login', 'customer.payment'));