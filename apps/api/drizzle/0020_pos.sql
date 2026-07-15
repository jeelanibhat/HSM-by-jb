CREATE SCHEMA "pos";
--> statement-breakpoint
CREATE TABLE "pos"."menu_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"code" varchar(24) NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" varchar(40),
	"price_minor" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_menu_items_outlet_code_uq" UNIQUE("outlet_id","code")
);
--> statement-breakpoint
CREATE TABLE "pos"."order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"description" varchar(120) NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"notes" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos"."orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_no" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"table_ref" varchar(40),
	"business_date" date NOT NULL,
	"folio_id" uuid,
	"room_id" uuid,
	"charged_subtotal_minor" bigint,
	"charged_at" timestamp with time zone,
	"void_reason" text,
	"opened_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_orders_property_no_uq" UNIQUE("property_id","order_no")
);
--> statement-breakpoint
CREATE TABLE "pos"."outlets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(100) NOT NULL,
	"charge_code" varchar(16) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_outlets_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
ALTER TABLE "pos"."menu_items" ADD CONSTRAINT "menu_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."menu_items" ADD CONSTRAINT "menu_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "pos"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."order_lines" ADD CONSTRAINT "order_lines_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "pos"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."order_lines" ADD CONSTRAINT "order_lines_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "pos"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."orders" ADD CONSTRAINT "orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."orders" ADD CONSTRAINT "orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "pos"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."orders" ADD CONSTRAINT "orders_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "folio"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."orders" ADD CONSTRAINT "orders_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "inventory"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."orders" ADD CONSTRAINT "orders_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "identity"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."outlets" ADD CONSTRAINT "outlets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_menu_items_outlet_idx" ON "pos"."menu_items" USING btree ("outlet_id","active");--> statement-breakpoint
CREATE INDEX "pos_order_lines_order_idx" ON "pos"."order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pos_orders_board_idx" ON "pos"."orders" USING btree ("property_id","status","business_date");--> statement-breakpoint
CREATE INDEX "pos_orders_folio_idx" ON "pos"."orders" USING btree ("folio_id");--> statement-breakpoint
CREATE INDEX "pos_outlets_property_idx" ON "pos"."outlets" USING btree ("property_id");