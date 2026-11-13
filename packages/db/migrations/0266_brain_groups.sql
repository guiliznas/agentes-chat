CREATE TABLE "brain_group_members" (
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"provider_key" text NOT NULL,
	"model" text,
	"effort" text,
	CONSTRAINT "brain_group_members_org_id_group_id_account_id_pk" PRIMARY KEY("org_id","group_id","account_id"),
	CONSTRAINT "brain_group_members_position" UNIQUE("org_id","group_id","position"),
	CONSTRAINT "brain_group_members_provider" UNIQUE("org_id","group_id","provider_key")
);
--> statement-breakpoint
CREATE TABLE "brain_groups" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"name" text NOT NULL,
	"strategy" text DEFAULT 'order' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_groups_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "brain_groups_strategy" CHECK ("brain_groups"."strategy" in ('order', 'room')),
	CONSTRAINT "brain_groups_name_length" CHECK (char_length("brain_groups"."name") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "brain_group_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "brain_account_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_group_members" ADD CONSTRAINT "brain_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_group_members" ADD CONSTRAINT "brain_group_members_org_id_group_id_brain_groups_org_id_id_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "public"."brain_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_group_members" ADD CONSTRAINT "brain_group_members_org_id_account_id_machine_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."machine_accounts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_groups" ADD CONSTRAINT "brain_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_groups" ADD CONSTRAINT "brain_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_groups" ADD CONSTRAINT "brain_groups_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_group_members_org_id_account_id_index" ON "brain_group_members" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "brain_groups_org_id_machine_id_index" ON "brain_groups" USING btree ("org_id","machine_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_brain_group_id_brain_groups_org_id_id_fk" FOREIGN KEY ("org_id","brain_group_id") REFERENCES "public"."brain_groups"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_org_id_brain_group_id_index" ON "agents" USING btree ("org_id","brain_group_id");