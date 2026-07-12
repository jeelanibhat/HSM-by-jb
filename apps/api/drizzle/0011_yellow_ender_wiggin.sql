CREATE SCHEMA "folio";
--> statement-breakpoint
CREATE TABLE "folio"."folio_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"type" varchar(16) NOT NULL,
	"code" varchar(32) NOT NULL,
	"description" varchar(255) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"reverses_line_id" uuid,
	"reason" text,
	"source_module" varchar(32) DEFAULT 'folio' NOT NULL,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folio"."folios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid,
	"guest_id" uuid NOT NULL,
	"folio_no" varchar(20) NOT NULL,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"type" varchar(16) DEFAULT 'GUEST' NOT NULL,
	"currency" char(3) NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folios_property_no_uq" UNIQUE("property_id","folio_no")
);
--> statement-breakpoint
CREATE TABLE "folio"."invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"invoice_no" varchar(24) NOT NULL,
	"totals" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_property_no_uq" UNIQUE("property_id","invoice_no")
);
--> statement-breakpoint
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT "folio_lines_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT "folio_lines_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "folio"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."folios" ADD CONSTRAINT "folios_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."folios" ADD CONSTRAINT "folios_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "reservations"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."folios" ADD CONSTRAINT "folios_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guests"."guests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."invoices" ADD CONSTRAINT "invoices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio"."invoices" ADD CONSTRAINT "invoices_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "folio"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folio_lines_folio_idx" ON "folio"."folio_lines" USING btree ("folio_id","created_at");--> statement-breakpoint
CREATE INDEX "folio_lines_date_idx" ON "folio"."folio_lines" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE INDEX "folio_lines_reverses_idx" ON "folio"."folio_lines" USING btree ("reverses_line_id");--> statement-breakpoint
CREATE INDEX "folios_reservation_idx" ON "folio"."folios" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "folios_guest_idx" ON "folio"."folios" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "folios_property_status_idx" ON "folio"."folios" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "invoices_folio_idx" ON "folio"."invoices" USING btree ("folio_id");