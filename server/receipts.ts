import type { Balances, TradeRow } from './db/repo';

export interface ReceiptBalances {
  pkr_paisa: bigint;
  user_gold_micrograms: bigint;
  platform_gold_micrograms: bigint;
}

export interface Receipt {
  trade: TradeRow;
  balances_before: ReceiptBalances;
  balances_after: ReceiptBalances;
}

function currentBalances(balances: Balances): ReceiptBalances {
  return {
    pkr_paisa: balances.pkrPaisa,
    user_gold_micrograms: balances.userGoldMicrograms,
    platform_gold_micrograms: balances.platformGoldMicrograms,
  };
}

/**
 * `trades` stores deltas only, so receipt balances are walked backwards from
 * the current wallet, newest first. Exact unless a demo set-balance ran later.
 */
export function walkReceipts(trades: TradeRow[], balances: Balances): Receipt[] {
  let after = currentBalances(balances);
  const receipts: Receipt[] = [];

  for (const trade of trades) {
    const before: ReceiptBalances =
      trade.side === 'buy'
        ? {
            pkr_paisa: after.pkr_paisa + trade.pkrPaisa,
            user_gold_micrograms: after.user_gold_micrograms - trade.goldMicrograms,
            platform_gold_micrograms:
              after.platform_gold_micrograms + trade.goldMicrograms,
          }
        : {
            pkr_paisa: after.pkr_paisa - trade.pkrPaisa,
            user_gold_micrograms: after.user_gold_micrograms + trade.goldMicrograms,
            platform_gold_micrograms:
              after.platform_gold_micrograms - trade.goldMicrograms,
          };

    receipts.push({ trade, balances_before: before, balances_after: after });
    after = before;
  }

  return receipts;
}
