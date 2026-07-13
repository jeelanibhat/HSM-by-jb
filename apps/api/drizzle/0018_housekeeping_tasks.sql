CREATE SCHEMA "housekeeping";
--> statement-breakpoint
CREATE TABLE "housekeeping"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"type" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"assigned_to" uuid,
	"credits" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"inspected_by" uuid,
	"inspected_at" timestamp with time zone,
	"inspection_note" text,
	"failed_inspections" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hk_tasks_room_date_type_uq" UNIQUE("room_id","business_date","type")
);
--> statement-breakpoint
ALTER TABLE "housekeeping"."tasks" ADD CONSTRAINT "tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping"."tasks" ADD CONSTRAINT "tasks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "inventory"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping"."tasks" ADD CONSTRAINT "tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping"."tasks" ADD CONSTRAINT "tasks_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hk_tasks_board_idx" ON "housekeeping"."tasks" USING btree ("property_id","business_date","status");--> statement-breakpoint
CREATE INDEX "hk_tasks_assignee_idx" ON "housekeeping"."tasks" USING btree ("assigned_to","business_date");