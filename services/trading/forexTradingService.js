import { RISK, ANALYSIS } from "../../config.js";
import BaseTradingService from "./baseTradingService.js";

const { PER_TRADE } = RISK;

class ForexTradingService extends BaseTradingService {
    getPipValue(symbol) {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    positionSizeForex(balance, entryPrice, stopLossPrice, symbol) {
        const riskAmount = balance * PER_TRADE;
        const pipValue = this.getPipValue(symbol);
        if (!pipValue || pipValue <= 0) return 100;

        const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
        if (stopLossPips === 0) return 0;

        let size = (riskAmount / (stopLossPips * pipValue)) * 1000;
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        const leverage = 30;
        const marginPrice = symbol.includes("JPY") ? entryPrice / 100 : entryPrice;
        const marginRequired = (size * marginPrice) / leverage;
        const maxMarginPerTrade = balance / 5;

        if (marginRequired > maxMarginPerTrade) {
            size = Math.floor((maxMarginPerTrade * leverage) / marginPrice / 100) * 100;
            if (size < 100) size = 100;
        }

        return size;
    }

    async calculateTradeParameters(signal, symbol, bid, ask, indicators) {
        const direction = this.normalizeDirection(signal);
        if (!["BUY", "SELL"].includes(direction)) {
            throw new Error(`[Trade Params] Invalid signal for ${symbol}: ${signal}`);
        }

        const isBuy = direction === "BUY";
        const price = this.resolveMarketPrice(direction, bid, ask);
        if (!Number.isFinite(price)) {
            throw new Error(`[Trade Params] Missing valid market price for ${symbol} (${direction})`);
        }

        const atrFromSnapshot = this.toNumber(indicators?.m15?.atr);
        const atr = atrFromSnapshot !== null && atrFromSnapshot > 0 ? atrFromSnapshot : await this.calculateATR(symbol, ANALYSIS.TIMEFRAMES);
        const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.abs(ask - bid) : 0;
        const stopLossDistance = Math.max(1.5 * atr, spread * 2);
        const stopLossPrice = isBuy ? price - stopLossDistance : price + stopLossDistance;
        const takeProfitDistance = 2 * stopLossDistance;
        const takeProfitPrice = isBuy ? price + takeProfitDistance : price - takeProfitDistance;
        const size = this.positionSizeForex(this.accountBalance, price, stopLossPrice, symbol);

        return {
            size,
            stopLossPrice,
            takeProfitPrice,
            stopLossPips: stopLossDistance,
            takeProfitPips: takeProfitDistance,
            trailingStopParams: {
                activationPrice: isBuy ? price + stopLossDistance : price - stopLossDistance,
                trailingDistance: atr,
            },
            partialTakeProfit: isBuy ? price + stopLossDistance : price - stopLossDistance,
            price,
        };
    }
}

export default new ForexTradingService();
