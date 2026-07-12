CREATE SCHEMA "reporting";
--> statement-breakpoint
CREATE TABLE "reporting"."daily_stats" (
	"property_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"rooms_available" integer NOT NULL,
	"rooms_sold" integer NOT NULL,
	"rooms_out_of_order" integer DEFAULT 0 NOT NULL,
	"occupancy_bps" integer NOT NULL,
	"room_revenue_minor" bigint NOT NULL,
	"other_revenue_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"adr_minor" bigint NOT NULL,
	"revpar_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_stats_property_id_business_date_pk" PRIMARY KEY("property_id","business_date")
);
--> statement-breakpoint
ALTER TABLE "folio"."folio_lines" ADD COLUMN "reservation_room_id" uuid;--> statement-breakpoint
ALTER TABLE "reporting"."daily_stats" ADD CONSTRAINT "daily_stats_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_stats_date_idx" ON "reporting"."daily_stats" USING btree ("property_id","business_date");