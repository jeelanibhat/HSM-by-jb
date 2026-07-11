CREATE SCHEMA "guests";
--> statement-breakpoint
CREATE SCHEMA "reservations";
--> statement-breakpoint
CREATE TABLE "guests"."guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(254),
	"phone" varchar(20),
	"id_type" varchar(32),
	"id_number" varchar(64),
	"address" jsonb,
	"vip" boolean DEFAULT false NOT NULL,
	"blacklisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations"."reservation_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"room_id" uuid,
	"rate_plan_id" uuid NOT NULL,
	"arrival_date" date NOT NULL,
	"departure_date" date NOT NULL,
	"status" varchar(16) NOT NULL,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "res_rooms_dates_valid" CHECK ("reservations"."reservation_rooms"."departure_date" > "reservations"."reservation_rooms"."arrival_date")
);
--> statement-breakpoint
CREATE TABLE "reservations"."reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"confirmation_no" varchar(20) NOT NULL,
	"guest_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"source" varchar(16) NOT NULL,
	"arrival_date" date NOT NULL,
	"departure_date" date NOT NULL,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_confirmation_uq" UNIQUE("property_id","confirmation_no"),
	CONSTRAINT "reservations_dates_valid" CHECK ("reservations"."reservations"."departure_date" > "reservations"."reservations"."arrival_date")
);
--> statement-breakpoint
CREATE TABLE "reservations"."room_type_availability" (
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_type_availability_property_id_room_type_id_date_pk" PRIMARY KEY("property_id","room_type_id","date"),
	CONSTRAINT "availability_never_oversold" CHECK ("reservations"."room_type_availability"."sold" >= 0 AND "reservations"."room_type_availability"."sold" + "reservations"."room_type_availability"."blocked" <= "reservations"."room_type_availability"."total")
);
--> statement-breakpoint
ALTER TABLE "guests"."guests" ADD CONSTRAINT "guests_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT "reservation_rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT "reservation_rooms_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "reservations"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT "reservation_rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT "reservation_rooms_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "inventory"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT "reservation_rooms_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "inventory"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."reservations" ADD CONSTRAINT "reservations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guests"."guests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."room_type_availability" ADD CONSTRAINT "room_type_availability_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations"."room_type_availability" ADD CONSTRAINT "room_type_availability_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "inventory"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guests_property_idx" ON "guests"."guests" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "guests_name_idx" ON "guests"."guests" USING btree ("property_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "guests_email_idx" ON "guests"."guests" USING btree ("property_id","email");--> statement-breakpoint
CREATE INDEX "guests_phone_idx" ON "guests"."guests" USING btree ("property_id","phone");--> statement-breakpoint
CREATE INDEX "res_rooms_reservation_idx" ON "reservations"."reservation_rooms" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "res_rooms_room_idx" ON "reservations"."reservation_rooms" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "res_rooms_type_dates_idx" ON "reservations"."reservation_rooms" USING btree ("property_id","room_type_id","arrival_date");--> statement-breakpoint
CREATE INDEX "reservations_property_status_idx" ON "reservations"."reservations" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "reservations_arrival_idx" ON "reservations"."reservations" USING btree ("property_id","arrival_date");--> statement-breakpoint
CREATE INDEX "reservations_departure_idx" ON "reservations"."reservations" USING btree ("property_id","departure_date");--> statement-breakpoint
CREATE INDEX "reservations_guest_idx" ON "reservations"."reservations" USING btree ("guest_id");