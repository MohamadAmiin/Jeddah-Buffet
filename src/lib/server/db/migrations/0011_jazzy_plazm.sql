CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_restaurant_code_unique" UNIQUE("restaurant_id","code"),
	CONSTRAINT "accounts_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "accounts_code_format" CHECK ("accounts"."code" ~ '^[0-9]{4}$'),
	CONSTRAINT "accounts_type_valid" CHECK ("accounts"."type" in ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense'))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"event" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"memo" text NOT NULL,
	"reverses_entry_id" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "journal_entries_event_valid" CHECK ("journal_entries"."event" in ('cash_sale', 'card_sale', 'mobile_sale', 'cost_of_goods_sold', 'cash_shortage_at_close', 'cash_overage_at_close')),
	CONSTRAINT "journal_entries_source_type_valid" CHECK ("journal_entries"."source_type" in ('order', 'pos_session'))
);
--> statement-breakpoint
CREATE TABLE "journal_entry_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_entry_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"restaurant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entry_lines_entry_line_no_unique" UNIQUE("entry_id","line_no"),
	CONSTRAINT "journal_entry_lines_non_negative" CHECK ("journal_entry_lines"."debit_minor" >= 0 and "journal_entry_lines"."credit_minor" >= 0),
	CONSTRAINT "journal_entry_lines_one_side" CHECK (("journal_entry_lines"."debit_minor" = 0) <> ("journal_entry_lines"."credit_minor" = 0))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"invoice_seq" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_order_unique" UNIQUE("order_id"),
	CONSTRAINT "invoices_device_number_unique" UNIQUE("device_id","invoice_number"),
	CONSTRAINT "invoices_device_seq_unique" UNIQUE("device_id","invoice_seq"),
	CONSTRAINT "invoices_seq_range" CHECK ("invoices"."invoice_seq" between 1 and 999999),
	CONSTRAINT "invoices_number_format" CHECK ("invoices"."invoice_number" ~ '^[A-Z0-9]{1,8}-[0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "order_line_modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"modifier_name" text NOT NULL,
	"price_delta_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"item_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "order_lines_order_line_no_unique" UNIQUE("order_id","line_no"),
	CONSTRAINT "order_lines_quantity_positive" CHECK ("order_lines"."quantity" >= 1),
	CONSTRAINT "order_lines_unit_price_minor_non_negative" CHECK ("order_lines"."unit_price_minor" >= 0),
	CONSTRAINT "order_lines_tax_rate_bp_range" CHECK ("order_lines"."tax_rate_bp" >= 0 and "order_lines"."tax_rate_bp" <= 10000),
	CONSTRAINT "order_lines_discount_minor_non_negative" CHECK ("order_lines"."discount_minor" >= 0),
	CONSTRAINT "order_lines_status_valid" CHECK ("order_lines"."status" in ('new', 'sent', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"pos_session_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"employee_user_id" uuid NOT NULL,
	"order_type" text NOT NULL,
	"table_label" text,
	"status" text NOT NULL,
	"tax_mode" text NOT NULL,
	"currency_code" text NOT NULL,
	"menu_version" integer NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"flag_reason" text,
	"opened_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "orders_order_type_valid" CHECK ("orders"."order_type" in ('dine_in', 'takeaway')),
	CONSTRAINT "orders_table_label_length" CHECK ("orders"."table_label" is null or char_length("orders"."table_label") between 1 and 32),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" in ('open', 'billed', 'paid', 'voided', 'refunded')),
	CONSTRAINT "orders_tax_mode_valid" CHECK ("orders"."tax_mode" in ('exclusive', 'inclusive')),
	CONSTRAINT "orders_currency_code_format" CHECK ("orders"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_amounts_non_negative" CHECK ("orders"."subtotal_minor" >= 0 and "orders"."discount_minor" >= 0 and "orders"."tax_minor" >= 0 and "orders"."total_minor" >= 0),
	CONSTRAINT "orders_totals_identity" CHECK ("orders"."subtotal_minor" - "orders"."discount_minor" + "orders"."tax_minor" = "orders"."total_minor")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"tendered_minor" bigint,
	"change_minor" bigint,
	"paid_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method_valid" CHECK ("payments"."method" in ('cash', 'card', 'mobile')),
	CONSTRAINT "payments_amount_minor_non_negative" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payments_cash_fields" CHECK (("payments"."method" = 'cash' and "payments"."tendered_minor" is not null and "payments"."change_minor" is not null and "payments"."tendered_minor" >= "payments"."amount_minor" and "payments"."change_minor" = "payments"."tendered_minor" - "payments"."amount_minor") or ("payments"."method" <> 'cash' and "payments"."tendered_minor" is null and "payments"."change_minor" is null))
);
--> statement-breakpoint
CREATE TABLE "pos_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_date" date NOT NULL,
	"opening_cash_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"closed_from_device_id" uuid,
	"counted_cash_minor" bigint,
	"expected_cash_minor" bigint,
	"difference_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sessions_id_restaurant_unique" UNIQUE("id","restaurant_id"),
	CONSTRAINT "pos_sessions_opening_cash_non_negative" CHECK ("pos_sessions"."opening_cash_minor" >= 0),
	CONSTRAINT "pos_sessions_status_valid" CHECK ("pos_sessions"."status" in ('open', 'closed')),
	CONSTRAINT "pos_sessions_closed_fields" CHECK ((("pos_sessions"."status" = 'closed') = ("pos_sessions"."closed_at" is not null)) and ("pos_sessions"."status" = 'open' or ("pos_sessions"."counted_cash_minor" is not null and "pos_sessions"."expected_cash_minor" is not null and "pos_sessions"."difference_minor" is not null and "pos_sessions"."closed_by_user_id" is not null and "pos_sessions"."closed_from_device_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "pos_sync_ops" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pos_sync_ops_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"restaurant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"received_via_device_id" uuid NOT NULL,
	"client_op_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"employee_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"flag" text,
	"error" text,
	"payload" jsonb NOT NULL,
	"pos_session_id" uuid,
	"order_id" uuid,
	"invoice_seq" integer,
	"invoice_number" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sync_ops_kind_valid" CHECK ("pos_sync_ops"."kind" in ('session.open', 'session.close', 'sale.complete', 'sale.abandoned', 'pin.login')),
	CONSTRAINT "pos_sync_ops_status_valid" CHECK ("pos_sync_ops"."status" in ('accepted', 'recorded_flagged', 'unrecorded')),
	CONSTRAINT "pos_sync_ops_resolution_valid" CHECK ("pos_sync_ops"."resolution" is null or "pos_sync_ops"."resolution" in ('retried', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "accepts_card" boolean;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "accepts_mobile" boolean;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_journal_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_entry_fk" FOREIGN KEY ("restaurant_id","entry_id") REFERENCES "public"."journal_entries"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_fk" FOREIGN KEY ("restaurant_id","account_id") REFERENCES "public"."accounts"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_fk" FOREIGN KEY ("restaurant_id","order_id") REFERENCES "public"."orders"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_line_fk" FOREIGN KEY ("restaurant_id","order_line_id") REFERENCES "public"."order_lines"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("restaurant_id","order_id") REFERENCES "public"."orders"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_menu_item_fk" FOREIGN KEY ("restaurant_id","menu_item_id") REFERENCES "public"."menu_items"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_employee_user_id_users_id_fk" FOREIGN KEY ("employee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_fk" FOREIGN KEY ("restaurant_id","pos_session_id") REFERENCES "public"."pos_sessions"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_fk" FOREIGN KEY ("restaurant_id","order_id") REFERENCES "public"."orders"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_closed_from_device_id_pos_devices_id_fk" FOREIGN KEY ("closed_from_device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_received_via_device_id_pos_devices_id_fk" FOREIGN KEY ("received_via_device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_employee_user_id_users_id_fk" FOREIGN KEY ("employee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_ops" ADD CONSTRAINT "pos_sync_ops_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_restaurant_id_idx" ON "accounts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "journal_entries_restaurant_business_date_idx" ON "journal_entries" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_account_idx" ON "journal_entry_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_entry_idx" ON "journal_entry_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "order_line_modifiers_line_idx" ON "order_line_modifiers" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "order_lines_menu_item_idx" ON "order_lines" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "orders_restaurant_session_idx" ON "orders" USING btree ("restaurant_id","pos_session_id");--> statement-breakpoint
CREATE INDEX "orders_session_idx" ON "orders" USING btree ("pos_session_id");--> statement-breakpoint
CREATE INDEX "orders_employee_idx" ON "orders" USING btree ("employee_user_id");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sessions_one_open_per_device" ON "pos_sessions" USING btree ("device_id") WHERE "pos_sessions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "pos_sessions_restaurant_business_date_idx" ON "pos_sessions" USING btree ("restaurant_id","business_date");--> statement-breakpoint
CREATE INDEX "pos_sessions_device_status_idx" ON "pos_sessions" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sync_ops_device_client_op_unique" ON "pos_sync_ops" USING btree ("device_id","client_op_id");--> statement-breakpoint
CREATE INDEX "pos_sync_ops_restaurant_unresolved_idx" ON "pos_sync_ops" USING btree ("restaurant_id","received_at") WHERE "pos_sync_ops"."status" <> 'accepted' and "pos_sync_ops"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "pos_sync_ops_session_idx" ON "pos_sync_ops" USING btree ("pos_session_id");--> statement-breakpoint
CREATE INDEX "pos_sync_ops_device_invoice_seq_idx" ON "pos_sync_ops" USING btree ("device_id","invoice_seq");