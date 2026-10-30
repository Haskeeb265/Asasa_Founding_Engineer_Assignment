import { describe, expect, it } from "vitest";
import {
  MIN_TRADE_GOLD_MICRO,
  MIN_TRADE_PKR_PAISA,
  formatMicrograms,
  formatPaisa,
  marketPaisaPerGramFromPkrPerOz,
  marketPaisaPerGramFromUsdPerOz,
  parseGoldAmount,
  parseMinor,
  parsePkrAmount,
  toWire,
} from "../../domain/units";

describe("parseMinor", () => {
  it("reads plain and comma-grouped decimals", () => {
    expect(parseMinor("50000", 2, "PKR")).toEqual({ ok: true, value: 5_000_000n });
    expect(parseMinor("50,000.25", 2, "PKR")).toEqual({ ok: true, value: 5_000_025n });
    expect(parseMinor("1.5", 6, "grams")).toEqual({ ok: true, value: 1_500_000n });
    expect(parseMinor("0.000001", 6, "grams")).toEqual({ ok: true, value: 1n });
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "   ", "abc", "1e5", "+5", "-5", "5.", ".5", "1 000", "50,00", "0x10", "Infinity", "NaN"]) {
      const result = parseMinor(bad, 2, "PKR");
      expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("rejects more decimals than the unit allows", () => {
    const result = parseMinor("1.234", 2, "PKR");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_MANY_DECIMALS");
  });
});

describe("parsePkrAmount / parseGoldAmount", () => {
  it("enforces the documented trade limits", () => {
    expect(parsePkrAmount("1000")).toEqual({ ok: true, value: MIN_TRADE_PKR_PAISA });
    expect(parsePkrAmount("999.99").ok).toBe(false);
    expect(parsePkrAmount("1000000").ok).toBe(true);
    expect(parsePkrAmount("1000000.01").ok).toBe(false);
    expect(parsePkrAmount("0").ok).toBe(false);

    expect(parseGoldAmount("0.1")).toEqual({ ok: true, value: MIN_TRADE_GOLD_MICRO });
    expect(parseGoldAmount("0.099999").ok).toBe(false);
    expect(parseGoldAmount("0").ok).toBe(false);
  });

  it("does not accept a negative or absurd notional", () => {
    expect(parsePkrAmount("-5000").ok).toBe(false);
    expect(parsePkrAmount("999999999999").ok).toBe(false);
  });
});

describe("ingested market price", () => {
  it("converts PKR per troy ounce once, with a single round", () => {
    // 1,104,969.02 PKR/oz -> 35,525.5789... PKR/g -> 3,552,558 paisa/g
    expect(marketPaisaPerGramFromPkrPerOz(1_104_969.02)).toBe(3_552_558n);
  });

  it("converts USD per ounce through FX", () => {
    const viaFx = marketPaisaPerGramFromUsdPerOz(3996.899902, 276.820884);
    const direct = marketPaisaPerGramFromPkrPerOz(3996.899902 * 276.820884);
    expect(viaFx).toBe(direct);
    expect(viaFx).toBe(3_557_240n);
  });

  it("refuses nonsense prices", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => marketPaisaPerGramFromPkrPerOz(bad)).toThrow(RangeError);
    }
  });
});

describe("formatting", () => {
  it("formats paisa with thousands separators", () => {
    expect(formatPaisa(5_000_000n)).toBe("50,000.00");
    expect(formatPaisa(0n)).toBe("0.00");
    expect(formatPaisa(1n)).toBe("0.01");
    expect(formatPaisa(-1_500n)).toBe("-15.00");
  });

  it("formats micrograms to six places", () => {
    expect(formatMicrograms(1_278_241n)).toBe("1.278241");
    expect(formatMicrograms(50_000_000n)).toBe("50.000000");
    expect(formatMicrograms(1n)).toBe("0.000001");
  });

  it("refuses to serialise an unsafe integer", () => {
    expect(toWire(5_000_000n)).toBe(5_000_000);
    expect(() => toWire(2n ** 60n)).toThrow(RangeError);
  });
});
