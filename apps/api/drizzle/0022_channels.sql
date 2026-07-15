CREATE SCHEMA "channel";
--> statement-breakpoint
CREATE TABLE "channel"."channel_bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_ref" varchar(64) NOT NULL,
	"reservation_id" uuid,
	"status" varchar(16) DEFAULT 'RECEIVED' NOT NULL,
	"reason" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_bookings_channel_ref_uq" UNIQUE("channel_id","external_ref")
);
--> statement-breakpoint
CREATE TABLE "channel"."channel_outbound" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel"."channel_rate_plan_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"external_rate_code" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_rp_map_channel_rateplan_uq" UNIQUE("channel_id","rate_plan_id"),
	CONSTRAINT "channel_rp_map_channel_extcode_uq" UNIQUE("channel_id","external_rate_code")
);
--> statement-breakpoint
CREATE TABLE "channel"."channel_room_type_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"external_room_code" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_rt_map_channel_roomtype_uq" UNIQUE("channel_id","room_type_id"),
	CONSTRAINT "channel_rt_map_channel_extcode_uq" UNIQUE("channel_id","external_room_code")
);
--> statement-breakpoint
CREATE TABLE "channel"."channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(24) NOT NULL,
	"name" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_channels_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
ALTER TABLE "channel"."channel_bookings" ADD CONSTRAINT "channel_bookings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_bookings" ADD CONSTRAINT "channel_bookings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channel"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_bookings" ADD CONSTRAINT "channel_bookings_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "reservations"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_outbound" ADD CONSTRAINT "channel_outbound_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_outbound" ADD CONSTRAINT "channel_outbound_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channel"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_outbound" ADD CONSTRAINT "channel_outbound_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channel"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_rate_plan_mappings" ADD CONSTRAINT "channel_rate_plan_mappings_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "inventory"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channel"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channel_room_type_mappings" ADD CONSTRAINT "channel_room_type_mappings_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."channels" ADD CONSTRAINT "channels_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_bookings_property_idx" ON "channel"."channel_bookings" USING btree ("property_id","channel_id");--> statement-breakpoint
CREATE INDEX "channel_bookings_reservation_idx" ON "channel"."channel_bookings" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "channel_outbound_due_idx" ON "channel"."channel_outbound" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "channel_outbound_property_idx" ON "channel"."channel_outbound" USING btree ("property_id","channel_id");--> statement-breakpoint
CREATE INDEX "channel_channels_property_idx" ON "channel"."channels" USING btree ("property_id");