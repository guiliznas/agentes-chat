ALTER TABLE "organization_settings" ADD COLUMN "plan_cross_provider" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "order_model" text;