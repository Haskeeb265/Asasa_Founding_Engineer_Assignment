CREATE TABLE "accounts" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"user_pkr" numeric NOT NULL,
	"user_gold" numeric NOT NULL,
	"platform_gold" numeric NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_non_negative" CHECK ("accounts"."user_pkr" >= 0 and "accounts"."user_gold" >= 0 and "accounts"."platform_gold" >= 0),
	CONSTRAINT "accounts_singleton" CHECK ("accounts"."id")
);
--> statement-breakpoint
CREATE TABLE "current_price" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"state" text NOT NULL,
	"market_price" numeric,
	"selected_source" text,
	"price_fetched_at" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"a_b_div" numeric,
	"b_c_div" numeric,
	"a_c_div" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "current_price_state_valid" CHECK ("current_price"."state" in ('VALID', 'NO_PRICE')),
	CONSTRAINT "current_price_source_valid" CHECK ("current_price"."selected_source" is null or "current_price"."selected_source" in ('A_pakgold', 'B_goldprice', 'C_yahoo'))
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"error_reason" text,
	"raw_value" text,
	"normalized_price" numeric,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_snapshots_source_valid" CHECK ("price_snapshots"."source" in ('A_pakgold', 'B_goldprice', 'C_yahoo')),
	CONSTRAINT "price_snapshots_status_valid" CHECK ("price_snapshots"."status" in ('OK', 'FAILED', 'INVALID', 'STALE', 'UNRELIABLE'))
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"input_amount" numeric NOT NULL,
	"pkr_total" numeric NOT NULL,
	"grams" numeric NOT NULL,
	"market_price" numeric NOT NULL,
	"execution_price" numeric NOT NULL,
	"guardrail_applied" numeric,
	"predicted_user_pkr" numeric NOT NULL,
	"predicted_user_gold" numeric NOT NULL,
	"price_source" text NOT NULL,
	"price_fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "quotes_side_valid" CHECK ("quotes"."side" in ('buy', 'sell')),
	CONSTRAINT "quotes_status_valid" CHECK ("quotes"."status" in ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "quotes_positive_terms" CHECK ("quotes"."pkr_total" > 0 and "quotes"."grams" > 0),
	CONSTRAINT "quotes_expiry_after_creation" CHECK ("quotes"."expires_at" > "quotes"."created_at"),
	CONSTRAINT "quotes_input_positive" CHECK ("quotes"."input_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"side" text NOT NULL,
	"grams" numeric NOT NULL,
	"market_price" numeric NOT NULL,
	"execution_price" numeric NOT NULL,
	"guardrail_applied" numeric,
	"pkr_total" numeric NOT NULL,
	"user_pkr_before" numeric NOT NULL,
	"user_gold_before" numeric NOT NULL,
	"user_pkr_after" numeric NOT NULL,
	"user_gold_after" numeric NOT NULL,
	"price_source" text NOT NULL,
	"price_fetched_at" timestamp with time zone NOT NULL,
	"quote_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "receipts_side_valid" CHECK ("receipts"."side" in ('buy', 'sell')),
	CONSTRAINT "receipts_positive_terms" CHECK ("receipts"."pkr_total" > 0 and "receipts"."grams"::numeric > 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"guardrail_pkr_per_gram" numeric DEFAULT 0 NOT NULL,
	"quote_ttl_seconds" integer DEFAULT 75 NOT NULL,
	"source_a_on" boolean DEFAULT true NOT NULL,
	"source_b_on" boolean DEFAULT true NOT NULL,
	"source_c_on" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id"),
	CONSTRAINT "settings_guardrail_non_negative" CHECK ("settings"."guardrail_pkr_per_gram" >= 0)
);
--> statement-breakpoint
CREATE INDEX "price_snapshots_fetched_at_idx" ON "price_snapshots" USING btree ("fetched_at");