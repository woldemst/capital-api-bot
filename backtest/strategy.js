// strategy.js
import * as signals from './signals.js';

export function generateSignal(pair, dataPoint) {
  switch(pair) {
    case 'EURUSD': return signals.generateSignal_EURUSD(dataPoint);
    case 'USDJPY': return signals.generateSignal_USDJPY(dataPoint);
    case 'GBPUSD': return signals.generateSignal_GBPUSD(dataPoint);
    case 'AUDUSD': return signals.generateSignal_AUDUSD(dataPoint);
    case 'NZDUSD': return signals.generateSignal_NZDUSD(dataPoint);
    case 'EURJPY': return signals.generateSignal_EURJPY(dataPoint);
    case 'GBPJPY': return signals.generateSignal_GBPJPY(dataPoint);
    case 'USDCAD': return signals.generateSignal_USDCAD(dataPoint);

    default: return null;
  }
}