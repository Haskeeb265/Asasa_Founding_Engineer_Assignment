ALTER TABLE "quotes" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "source_c_basis_bps" integer DEFAULT 28 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_basis_range" CHECK ("settings"."source_c_basis_bps" between -500 and 500);