CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TABLE "inventory"."rate_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"currency" char(3) NOT NULL,
	"meal_plan" varchar(8) DEFAULT 'EP' NOT NULL,
	"active" varchar(8) DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_plans_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."rate_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"price_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_prices_grid_uq" UNIQUE("rate_plan_id","room_type_id","date")
);
--> statement-breakpoint
CREATE TABLE "inventory"."room_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"base_occupancy" integer DEFAULT 2 NOT NULL,
	"max_occupancy" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_types_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"number" varchar(16) NOT NULL,
	"floor" varchar(16),
	"status" varchar(16) DEFAULT 'VACANT_CLEAN' NOT NULL,
	"status_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_property_number_uq" UNIQUE("property_id","number")
);
--> statement-breakpoint
ALTER TABLE "inventory"."rate_plans" ADD CONSTRAINT "rate_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."rate_prices" ADD CONSTRAINT "rate_prices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."rate_prices" ADD CONSTRAINT "rate_prices_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "inventory"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."rate_prices" ADD CONSTRAINT "rate_prices_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."room_types" ADD CONSTRAINT "room_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."rooms" ADD CONSTRAINT "rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."rooms" ADD CONSTRAINT "rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_plans_property_idx" ON "inventory"."rate_plans" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "rate_prices_lookup_idx" ON "inventory"."rate_prices" USING btree ("property_id","room_type_id","date");--> statement-breakpoint
CREATE INDEX "room_types_property_idx" ON "inventory"."room_types" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "rooms_property_idx" ON "inventory"."rooms" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "rooms_type_idx" ON "inventory"."rooms" USING btree ("room_type_id");--> statement-breakpoint
CREATE INDEX "rooms_status_idx" ON "inventory"."rooms" USING btree ("property_id","status");