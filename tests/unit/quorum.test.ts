import { describe, expect, it } from "vitest";
import {
  divergenceBps,
  median,
  runQuorum,
  type QuorumSample,
} from "../../domain/quorum";

const s = (source: QuorumSample["source"], price: bigint): QuorumSample => ({ source, pricePaisaPerGram: price });

describe("divergenceBps", () => {
  it("is symmetric and zero for equal prices", () => {
    expect(divergenceBps(4000n, 4000n)).toBe(0);
    expect(divergenceBps(4004n, 3989n)).toBe(divergenceBps(3989n, 4004n));
  });

  it("uses the symmetric formula |a-b| x 20000 / (a+b)", () => {
    // 15 apart on ~4000 -> 15*20000/7993 = 37.5 -> integer floors to 37
    expect(divergenceBps(4004n, 3989n)).toBe(37);
  });

  it("refuses non-positive prices", () => {
    expect(() => divergenceBps(0n, 5n)).toThrow(RangeError);
  });
});

describe("median", () => {
  it("picks the middle member", () => {
    expect(median([1n, 9n, 5n])).toBe(5n);
  });
  it("picks the lower middle for even lists", () => {
    expect(median([1n, 9n, 5n, 7n])).toBe(5n);
  });
  it("refuses an empty list", () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe("runQuorum", () => {
  it("pauses with zero samples", () => {
    const out = runQuorum([], 100, null);
    expect(out.confidence).toBe("paused");
    expect(out.selectedSource).toBeNull();
    expect(out.selectedPrice).toBeNull();
  });

  it("accepts a single source without waiting for a validator", () => {
    const out = runQuorum([s("C_yahoo", 3900n)], 100, null);
    expect(out.confidence).toBe("single_source");
    expect(out.selectedSource).toBe("C_yahoo");
    expect(out.degraded).toBe(true);
  });

  it("a single A source is not degraded", () => {
    const out = runQuorum([s("A_pakgold", 3900n)], 100, null);
    expect(out.degraded).toBe(false);
  });

  it("two agreeing sources validate and pick by priority", () => {
    const out = runQuorum(
      [s("C_yahoo", 3900n), s("A_pakgold", 3915n)], // ~38 bps apart
      100,
      null,
    );
    expect(out.confidence).toBe("validated");
    expect(out.selectedSource).toBe("A_pakgold");
    expect(out.selectedPrice).toBe(3915n);
    expect(out.degraded).toBe(false);
    expect(out.accepted).toHaveLength(2);
  });

  it("two disagreeing sources follow the last trusted price", () => {
    // A=3900, C=4100 -> ~505 bps apart. Anchor 3897 favours A.
    const out = runQuorum([s("C_yahoo", 4100n), s("A_pakgold", 3900n)], 100, 3897n);
    expect(out.selectedSource).toBe("A_pakgold");
    expect(out.rejected).toEqual([{ source: "C_yahoo", pricePaisaPerGram: 4100n, reason: "divergence" }]);
  });

  it("two disagreeing sources with no anchor keep priority and degrade loudly", () => {
    const out = runQuorum([s("C_yahoo", 4100n), s("A_pakgold", 3900n)], 100, null);
    expect(out.confidence).toBe("single_source");
    expect(out.selectedSource).toBe("A_pakgold");
    expect(out.degraded).toBe(true);
    expect(out.rejected).toHaveLength(1);
  });

  it("rejects a far outlier against the median", () => {
    const out = runQuorum(
      [s("A_pakgold", 3900n), s("C_yahoo", 3905n), s("B_goldprice", 4600n)],
      100,
      null,
    );
    expect(out.confidence).toBe("validated");
    expect(out.selectedSource).toBe("A_pakgold");
    expect(out.accepted).toHaveLength(2);
    expect(out.rejected.map((r) => r.source)).toEqual(["B_goldprice"]);
  });

  it("keeps everyone when all sources agree", () => {
    const out = runQuorum(
      [s("A_pakgold", 3900n), s("B_goldprice", 3902n), s("C_yahoo", 3898n)],
      100,
      null,
    );
    expect(out.rejected).toHaveLength(0);
    expect(out.accepted).toHaveLength(3);
    expect(out.selectedSource).toBe("A_pakgold");
  });

  it("tightening the threshold rejects previously acceptable spread", () => {
    const samples = [s("A_pakgold", 3900n), s("B_goldprice", 3940n), s("C_yahoo", 3902n)];
    expect(runQuorum(samples, 100, null).rejected).toHaveLength(0);
    const tight = runQuorum(samples, 25, null);
    expect(tight.rejected.map((r) => r.source)).toEqual(["B_goldprice"]);
    // the median (3902) still survives the tightening
    expect(tight.accepted.map((a) => a.source)).toEqual(["A_pakgold", "C_yahoo"]);
  });
});
