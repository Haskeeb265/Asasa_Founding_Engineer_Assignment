CREATE TABLE "balances" (
	"key" text PRIMARY KEY NOT NULL,
	"unit" text NOT NULL,
	"amount" bigint NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "balances_key_check" CHECK ("key" in ('pkr', 'user_gold', 'platform_gold')),
	CONSTRAINT "balances_amount_check" CHECK ("amount" >= 0),
	CONSTRAINT "balances_unit_check" CHECK (("key" = 'pkr' and "unit" = 'paisa') or ("key" <> 'pkr' and "unit" = 'microgram'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"guardrail_paisa_per_gram" bigint DEFAULT 0 NOT NULL,
	"quote_ttl_seconds" integer DEFAULT 75 NOT NULL,
	"divergence_threshold_bps" integer DEFAULT 100 NOT NULL,
	"max_price_age_seconds" integer DEFAULT 600 NOT NULL,
	"price_fetch_interval_seconds" integer DEFAULT 300 NOT NULL,
	"source_a_on" boolean DEFAULT true NOT NULL,
	"source_b_on" boolean DEFAULT true NOT NULL,
	"source_c_on" boolean DEFAULT true NOT NULL,
	"source_c_basis_bps" integer DEFAULT 28 NOT NULL,
	"price_override_paisa" bigint,
	"force_paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row_check" CHECK ("id"),
	CONSTRAINT "settings_guardrail_check" CHECK ("guardrail_paisa_per_gram" >= 0),
	CONSTRAINT "settings_fetch_interval_check" CHECK ("price_fetch_interval_seconds" between 1 and 86400),
	CONSTRAINT "settings_c_basis_check" CHECK ("source_c_basis_bps" between -500 and 500),
	CONSTRAINT "settings_override_check" CHECK ("price_override_paisa" is null or "price_override_paisa" > 0)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"side" text NOT NULL,
	"status" text NOT NULL,
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
	"price_fetched_at" timestamptz NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"settled_at" timestamptz,
	"rejection_reason" text,
	CONSTRAINT "quotes_side_check" CHECK ("side" in ('buy', 'sell')),
	CONSTRAINT "quotes_status_check" CHECK ("status" in ('active', 'confirmed', 'settled', 'expired', 'cancelled', 'rejected')),
	CONSTRAINT "quotes_input_mode_check" CHECK ("input_mode" in ('pkr', 'grams')),
	CONSTRAINT "quotes_gold_positive_check" CHECK ("gold_micrograms" > 0),
	CONSTRAINT "quotes_pkr_positive_check" CHECK ("pkr_paisa" > 0),
	CONSTRAINT "quotes_expiry_check" CHECK ("expires_at" > "created_at")
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
	"guardrail_paisa_per_gram" bigint DEFAULT 0 NOT NULL,
	"guardrail_applied" boolean DEFAULT false NOT NULL,
	"price_source" text NOT NULL,
	"price_fetched_at" timestamptz NOT NULL,
	"quote_created_at" timestamptz NOT NULL,
	"settled_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "trades_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "trades_side_check" CHECK ("side" in ('buy', 'sell')),
	CONSTRAINT "trades_gold_positive_check" CHECK ("gold_micrograms" > 0),
	CONSTRAINT "trades_pkr_positive_check" CHECK ("pkr_paisa" > 0),
	CONSTRAINT "pkr_is_exact" CHECK ("pkr_paisa" = case when "side" = 'buy' then ("gold_micrograms" * "unit_paisa_per_gram" + 999999) / 1000000 else ("gold_micrograms" * "unit_paisa_per_gram") / 1000000 end)
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" uuid NOT NULL,
	"fetched_at" timestamptz NOT NULL,
	"source" text NOT NULL,
	"price_paisa_per_gram" bigint,
	"accepted" boolean NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "prices_source_check" CHECK ("source" in ('A_pakgold', 'B_goldprice', 'C_yahoo')),
	CONSTRAINT "prices_cycle_source_unique" UNIQUE("cycle_id","source")
);
--> statement-breakpoint
CREATE INDEX "quotes_status_expires_idx" ON "quotes" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "quotes_created_idx" ON "quotes" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX "trades_settled_idx" ON "trades" ("settled_at" DESC);
--> statement-breakpoint
CREATE INDEX "prices_fetched_idx" ON "prices" ("fetched_at" DESC);
--> statement-breakpoint
CREATE INDEX "prices_selected_idx" ON "prices" ("selected","fetched_at" DESC);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;
