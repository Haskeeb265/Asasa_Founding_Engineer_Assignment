CREATE TABLE "balances" (
	"key" text PRIMARY KEY NOT NULL,
	"unit" text NOT NULL,
	"amount" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_key_valid" CHECK ("balances"."key" in ('pkr', 'user_gold', 'platform_gold')),
	CONSTRAINT "balances_unit_matches_key" CHECK (("balances"."key" = 'pkr' and "balances"."unit" = 'paisa') or ("balances"."key" <> 'pkr' and "balances"."unit" = 'microgram')),
	CONSTRAINT "balances_non_negative" CHECK ("balances"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"price_paisa_per_gram" bigint,
	"accepted" boolean DEFAULT false NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"reason" text,
	CONSTRAINT "prices_source_valid" CHECK ("prices"."source" in ('A_pakgold', 'B_goldprice', 'C_yahoo'))
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"input_mode" text NOT NULL,
	"input_minor" bigint NOT NULL,
	"market_paisa_per_gram" bigint NOT NULL,
	"unit_paisa_per_gram" bigint NOT NULL,
	"spread_bps" integer NOT NULL,
	"gold_micrograms" bigint NOT NULL,
	"pkr_paisa" bigint NOT NULL,
	"guardrail_paisa_per_gram" bigint DEFAULT 0 NOT NULL,
	"guardrail_applied" boolean DEFAULT false NOT NULL,
	"price_source" text NOT NULL,
	"price_cycle_id" uuid,
	"price_fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"rejection_reason" text,
	CONSTRAINT "quotes_side_valid" CHECK ("quotes"."side" in ('buy', 'sell')),
	CONSTRAINT "quotes_status_valid" CHECK ("quotes"."status" in ('active', 'settled', 'expired', 'cancelled', 'rejected')),
	CONSTRAINT "quotes_input_mode_valid" CHECK ("quotes"."input_mode" in ('pkr', 'gold')),
	CONSTRAINT "quotes_amounts_positive" CHECK ("quotes"."pkr_paisa" > 0 and "quotes"."gold_micrograms" > 0),
	CONSTRAINT "quotes_expiry_after_creation" CHECK ("quotes"."expires_at" > "quotes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"guardrail_paisa_per_gram" bigint DEFAULT 0 NOT NULL,
	"quote_ttl_seconds" integer DEFAULT 75 NOT NULL,
	"divergence_threshold_bps" integer DEFAULT 100 NOT NULL,
	"max_price_age_seconds" integer DEFAULT 600 NOT NULL,
	"source_a_on" boolean DEFAULT true NOT NULL,
	"source_b_on" boolean DEFAULT true NOT NULL,
	"source_c_on" boolean DEFAULT true NOT NULL,
	"price_override_paisa" bigint,
	"source_c_basis_bps" integer DEFAULT 28 NOT NULL,
	"force_paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id"),
	CONSTRAINT "settings_basis_range" CHECK ("settings"."source_c_basis_bps" between -500 and 500)
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"side" text NOT NULL,
	"gold_micrograms" bigint NOT NULL,
	"pkr_paisa" bigint NOT NULL,
	"market_paisa_per_gram" bigint NOT NULL,
	"unit_paisa_per_gram" bigint NOT NULL,
	"spread_bps" integer NOT NULL,
	"guardrail_paisa_per_gram" bigint NOT NULL,
	"guardrail_applied" boolean NOT NULL,
	"price_source" text NOT NULL,
	"price_fetched_at" timestamp with time zone NOT NULL,
	"quote_created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "trades_side_valid" CHECK ("trades"."side" in ('buy', 'sell')),
	CONSTRAINT "trades_amounts_positive" CHECK ("trades"."pkr_paisa" > 0 and "trades"."gold_micrograms" > 0),
	CONSTRAINT "trades_pkr_is_exact" CHECK ("trades"."pkr_paisa" = case when "trades"."side" = 'buy'
            then ("trades"."gold_micrograms" * "trades"."unit_paisa_per_gram" + 999999) / 1000000
            else ("trades"."gold_micrograms" * "trades"."unit_paisa_per_gram") / 1000000
          end)
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prices_cycle_idx" ON "prices" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "prices_fetched_at_idx" ON "prices" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "quotes_status_expiry_idx" ON "quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "trades_settled_at_idx" ON "trades" USING btree ("settled_at");