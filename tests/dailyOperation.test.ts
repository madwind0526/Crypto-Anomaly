import { describe, expect, it } from "vitest";
import { decideDailyOperation } from "../src/simulation/dailyOperation";

const now = Date.UTC(2026, 4, 12);

describe("daily operation engine", () => {
  it("buys the strongest qualified signal when no position is open", () => {
    const decision = decideDailyOperation({
      currentPosition: null,
      now,
      signals: [
        createSignal("KRW-BTC", "buy", 0.58, 0.5),
        createSignal("KRW-XRP", "buy", 0.9, 0.8),
      ],
    });

    expect(decision.action).toBe("buy");
    expect(decision.buyMarket).toBe("KRW-XRP");
  });

  it("prioritizes sell signal for the currently held market", () => {
    const decision = decideDailyOperation({
      currentPosition: {
        market: "KRW-BTC",
        entryPrice: 100,
        currentPrice: 95,
        quantity: 1,
        openedAt: now - 60_000,
      },
      now,
      signals: [createSignal("KRW-BTC", "sell", 0.8, 0.8), createSignal("KRW-XRP", "buy", 0.95, 0.95)],
    });

    expect(decision.action).toBe("sell");
    expect(decision.sellMarket).toBe("KRW-BTC");
  });

  it("rotates only when a different market is meaningfully stronger", () => {
    const position = {
      market: "KRW-BTC",
      entryPrice: 100,
      currentPrice: 105,
      quantity: 1,
      openedAt: now - 60_000,
    };
    const decision = decideDailyOperation({
      currentPosition: position,
      now,
      signals: [createSignal("KRW-BTC", "buy", 0.55, 0.55), createSignal("KRW-XRP", "buy", 0.95, 0.95)],
    });

    expect(decision.action).toBe("rotate");
    expect(decision.sellMarket).toBe("KRW-BTC");
    expect(decision.buyMarket).toBe("KRW-XRP");
  });
});

function createSignal(market: string, action: "buy" | "sell" | "hold", strength: number, qualityScore: number) {
  return {
    market,
    action,
    strength,
    qualityScore,
    timestamp: now,
    reasonCodes: [`${market}-${action}`],
  };
}
