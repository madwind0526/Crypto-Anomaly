import { anomalyStrategy } from "./anomaly";
import { arbitrageStrategy } from "./arbitrage";
import { momentumStrategy } from "./momentum";
import { rangeGridStrategy } from "./rangeGrid";

export const strategies = [momentumStrategy, rangeGridStrategy, arbitrageStrategy, anomalyStrategy];

