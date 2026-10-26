import { describe, expect, it } from "vitest";
import {
  BUY_SPREAD_BPS,
  SELL_SPREAD_BPS,
  buildQuote,
  buyUnitPaisaPerGram,
  sellUnitPaisaPerGram,
  type Side,
  type InputMode,
} from "../../domain/trade-math";
import { MICROGRAMS_PER_GRAM, MIN_TRADE_GOLD_MICRO } from "../../domain/units";

const MARKET = 3_557_240n; // 35,572.40 PKR/g, Sunday's measured spot
const NO_GUARDRAIL = 0n;

/** The exact formula the trades table re-checks in SQL. */
const expectedCharge = (side: Side, goldMicrograms: bigint, unit: bigint): bigint =>
  side === "buy"
    ? (goldMicrograms * unit + 999_999n) / 1_000_000n
    : (goldMicrograms * unit) / 1_000_000n;

describe("spreads", () => {
  it("applies 1.10 up and 0.90 down in integer bps", () => {
    expect(BUY_SPREAD_BPS).toBe(11_000n);
    expect(SELL_SPREAD_BPS).toBe(9_000n);
    expect(buyUnitPaisaPerGram(MARKET)).toBe(3_912_964n);
    expect(sellUnitPaisaPerGram(MARKET)).toBe(3_201_516n);
  });

  it("rounds the buy price up and the sell price down", () => {
    expect(buyUnitPaisaPerGram(1_000_001n)).toBe(1_100_002n);
    expect(sellUnitPaisaPerGram(1_000_001n)).toBe(900_000n);
  });
});

describe("guardrail", () => {
  it("does nothing when it sits below market x 1.10", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "gold",
      inputMinor: MICROGRAMS_PER_GRAM,
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: 3_000_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unitPaisaPerGram).toBe(3_912_964n);
      expect(result.value.guardrailApplied).toBe(false);
    }
  });

  it("takes over the moment it exceeds market x 1.10", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "gold",
      inputMinor: MICROGRAMS_PER_GRAM,
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: 4_000_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unitPaisaPerGram).toBe(4_000_000n);
      expect(result.value.guardrailApplied).toBe(true);
    }
  });

  it("never applies to a sell", () => {
    const result = buildQuote({
      side: "sell",
      inputMode: "gold",
      inputMinor: MICROGRAMS_PER_GRAM,
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: 9_000_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unitPaisaPerGram).toBe(3_201_516n);
      expect(result.value.guardrailApplied).toBe(false);
    }
  });
});

describe("one gram trades", () => {
  it("buys 1 g at the rounded-up price", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "gold",
      inputMinor: MICROGRAMS_PER_GRAM,
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.goldMicrograms).toBe(MICROGRAMS_PER_GRAM);
      expect(result.value.pkrPaisa).toBe(3_912_964n);
    }
  });

  it("sells 1 g at the rounded-down price", () => {
    const result = buildQuote({
      side: "sell",
      inputMode: "gold",
      inputMinor: MICROGRAMS_PER_GRAM,
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pkrPaisa).toBe(3_201_516n);
    }
  });
});

describe("invariants", () => {
  const cases: Array<{ side: Side; inputMode: InputMode; input: bigint }> = [
    { side: "buy", inputMode: "pkr", input: 5_000_000n },
    { side: "buy", inputMode: "pkr", input: 123_457n },
    { side: "buy", inputMode: "gold", input: 1_278_241n },
    { side: "sell", inputMode: "gold", input: 20_000_000n },
    { side: "sell", inputMode: "pkr", input: 5_000_000n },
    { side: "sell", inputMode: "pkr", input: 100_000n },
  ];

  it("every quote satisfies pkr = f(grams, unit price) exactly", () => {
    for (const testCase of cases) {
      const result = buildQuote({
        side: testCase.side,
        inputMode: testCase.inputMode,
        inputMinor: testCase.input,
        marketPaisaPerGram: MARKET,
        guardrailPaisaPerGram: NO_GUARDRAIL,
      });
      expect(result.ok, `${testCase.side}/${testCase.inputMode}/${testCase.input}`).toBe(true);
      if (!result.ok) continue;
      const { side, goldMicrograms, unitPaisaPerGram, pkrPaisa } = result.value;
      expect(pkrPaisa).toBe(expectedCharge(side, goldMicrograms, unitPaisaPerGram));
      expect(goldMicrograms > 0n).toBe(true);
      expect(pkrPaisa > 0n).toBe(true);
    }
  });

  it("never charges more than the PKR the user named, and keeps the leftover under one paisa-worth", () => {
    for (const input of [100_000n, 123_457n, 999_999n, 5_000_000n, 50_000_000n]) {
      const result = buildQuote({
        side: "buy",
        inputMode: "pkr",
        inputMinor: input,
        marketPaisaPerGram: MARKET,
        guardrailPaisaPerGram: NO_GUARDRAIL,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.pkrPaisa).toBeLessThanOrEqual(input);
      // leftover is less than the price of one microgram
      const leftover = input - result.value.pkrPaisa;
      expect(leftover).toBeLessThan(result.value.unitPaisaPerGram / 1_000_000n + 1n);
    }
  });

  it("is monotonic: more PKR never buys less gold", () => {
    let previous = 0n;
    for (const input of [100_000n, 200_000n, 500_000n, 1_000_000n, 5_000_000n]) {
      const result = buildQuote({
        side: "buy",
        inputMode: "pkr",
        inputMinor: input,
        marketPaisaPerGram: MARKET,
        guardrailPaisaPerGram: NO_GUARDRAIL,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.goldMicrograms).toBeGreaterThan(previous);
      previous = result.value.goldMicrograms;
    }
  });
});

describe("rejections", () => {
  it("refuses a trade below the minimum", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "pkr",
      inputMinor: 50_000n, // Rs 500
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BELOW_MIN");
  });

  it("refuses an amount so small it rounds to no gold at all", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "pkr",
      inputMinor: 100_000n, // Rs 1,000
      marketPaisaPerGram: 1_000_000_000_000n, // absurd price: 10,000,000 PKR/g

      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BELOW_MIN");
  });

  it("refuses a trade above the notional cap", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "gold",
      inputMinor: 1_000_000_000n, // 1,000 g
      marketPaisaPerGram: MARKET,
      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ABOVE_MAX");
  });

  it("refuses to quote without a market price", () => {
    const result = buildQuote({
      side: "buy",
      inputMode: "gold",
      inputMinor: MIN_TRADE_GOLD_MICRO,
      marketPaisaPerGram: 0n,
      guardrailPaisaPerGram: NO_GUARDRAIL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PRICE_UNAVAILABLE");
  });
});
