import type { Candle } from "../types/trading";

export function sma(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

export function ema(values: number[], period: number): Array<number | null> {
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;

  return values.map((value, index) => {
    if (index + 1 < period) return null;
    if (previous === null) {
      const seed = values.slice(index + 1 - period, index + 1);
      previous = seed.reduce((sum, item) => sum + item, 0) / period;
      return previous;
    }

    previous = (value - previous) * multiplier + previous;
    return previous;
  });
}

export function rsi(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    if (index <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (index === period) {
        avgGain /= period;
        avgLoss /= period;
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (index >= period) {
      if (avgLoss === 0) {
        result[index] = 100;
      } else {
        const relativeStrength = avgGain / avgLoss;
        result[index] = 100 - 100 / (1 + relativeStrength);
      }
    }
  }

  return result;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = values.map((_, index) => {
    const fastValue = fastEma[index];
    const slowValue = slowEma[index];
    return fastValue === null || slowValue === null ? null : fastValue - slowValue;
  });
  const signalLine = ema(
    macdLine.map((value) => value ?? 0),
    signal,
  );

  return {
    macdLine,
    signalLine: signalLine.map((value, index) => (macdLine[index] === null ? null : value)),
    histogram: macdLine.map((value, index) => {
      const signalValue = signalLine[index];
      return value === null || signalValue === null ? null : value - signalValue;
    }),
  };
}

export function bollinger(values: number[], period: number, deviations: number) {
  const middle = sma(values, period);
  return values.map((_, index) => {
    const average = middle[index];
    if (average === null) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    const variance = slice.reduce((sum, value) => sum + (value - average) ** 2, 0) / period;
    const sd = Math.sqrt(variance);

    return {
      lower: average - deviations * sd,
      middle: average,
      upper: average + deviations * sd,
      widthPct: average === 0 ? 0 : (2 * deviations * sd) / average,
    };
  });
}

export function averageTrueRange(candles: Candle[], period: number): Array<number | null> {
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  return sma(trueRanges, period);
}

export function rateOfChange(values: number[], period: number): Array<number | null> {
  return values.map((value, index) => {
    if (index < period) return null;
    const previous = values[index - period];
    return previous === 0 ? 0 : (value - previous) / previous;
  });
}

