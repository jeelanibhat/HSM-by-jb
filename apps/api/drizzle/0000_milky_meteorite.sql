CREATE SCHEMA "shared";
--> statement-breakpoint
CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE SCHEMA "property";
--> statement-breakpoint
CREATE TABLE "shared"."audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"user_id" uuid,
	"action" varchar(128) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared"."night_audit_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" varchar(16) NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shared"."outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "identity"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "identity"."user_property_roles" (
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_property_roles_user_id_property_id_role_id_pk" PRIMARY KEY("user_id","property_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"name" varchar(200) NOT NULL,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "property"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property"."properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"currency" char(3) NOT NULL,
	"business_date" date NOT NULL,
	"check_in_time" time DEFAULT '14:00' NOT NULL,
	"check_out_time" time DEFAULT '11:00' NOT NULL,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property"."taxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"rate_bps" integer NOT NULL,
	"type" varchar(16) DEFAULT 'EXCLUSIVE' NOT NULL,
	"applies_above_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."user_property_roles" ADD CONSTRAINT "user_property_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."user_property_roles" ADD CONSTRAINT "user_property_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property"."properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "property"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property"."taxes" ADD CONSTRAINT "taxes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "property"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "shared"."audit_log" USING btree ("property_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "shared"."audit_log" USING btree ("property_id","at");--> statement-breakpoint
CREATE INDEX "night_audit_property_date_idx" ON "shared"."night_audit_runs" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE INDEX "outbox_unprocessed_idx" ON "shared"."outbox_events" USING btree ("created_at") WHERE "shared"."outbox_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "upr_user_idx" ON "identity"."user_property_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "upr_property_idx" ON "identity"."user_property_roles" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "identity"."users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "properties_org_idx" ON "property"."properties" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "taxes_property_idx" ON "property"."taxes" USING btree ("property_id");