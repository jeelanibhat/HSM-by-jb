ALTER TABLE "reservations"."room_type_availability" DROP CONSTRAINT "availability_never_oversold";--> statement-breakpoint
ALTER TABLE "guests"."guests" ADD COLUMN "id_number_encrypted" text;--> statement-breakpoint
ALTER TABLE "guests"."guests" ADD COLUMN "id_number_hash" text;--> statement-breakpoint
ALTER TABLE "guests"."guests" ADD COLUMN "id_number_masked" varchar(16);--> statement-breakpoint
ALTER TABLE "guests"."guests" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "guests_id_hash_idx" ON "guests"."guests" USING btree ("property_id","id_number_hash");--> statement-breakpoint
ALTER TABLE "reservations"."room_type_availability" ADD CONSTRAINT "availability_never_oversold" CHECK ("reservations"."room_type_availability"."sold" >= 0 AND "reservations"."room_type_availability"."sold" <= "reservations"."room_type_availability"."total");