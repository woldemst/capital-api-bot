import { RISK, ANALYSIS } from "../../config.js";
import { getMarketDetails } from "../../api.js";
import BaseTradingService from "./baseTradingService.js";
import logger from "../../utils/logger.js";

const { PER_TRADE } = RISK;

class CryptoTradingService extends BaseTradingService {
    constructor() {
        super();
        this.marketRulesCache = new Map();
    }

    getDecimalPlaces(value) {
        if (!Number.isFinite(value)) return 0;
        const s = String(value);
        if (!s.includes(".")) return 0;
        return s.split(".")[1].length;
    }

    floorToStep(value, step) {
        if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
        const decimals = this.getDecimalPlaces(step);
        const floored = Math.floor((value + Number.EPSILON) / step) * step;
        return Number(floored.toFixed(Math.max(0, decimals)));
    }

    async getMarketRules(symbol) {
        if (this.marketRulesCache.has(symbol)) return this.marketRulesCache.get(symbol);

        const fallback = { minDealSize: 0.01, maxDealSize: null, dealSizeStep: 0.01 };
        try {
            const details = await getMarketDetails(symbol);
            const minDealSize = this.firstNumber(
                details?.dealingRules?.minDealSize?.value,
                details?.dealingRules?.minDealSize,
                details?.instrument?.minDealSize,
                fallback.minDealSize,
            );
            const maxDealSize = this.firstNumber(
                details?.dealingRules?.maxDealSize?.value,
                details?.dealingRules?.maxDealSize,
                details?.instrument?.maxDealSize,
                fallback.maxDealSize,
            );
            const dealSizeStep = this.firstNumber(
                details?.dealingRules?.dealSizeIncrement?.value,
                details?.dealingRules?.dealSizeIncrement,
                details?.instrument?.dealSizeIncrement,
                details?.instrument?.minDealSizeIncrement,
                fallback.dealSizeStep,
            );

            const rules = { minDealSize, maxDealSize, dealSizeStep };
            this.marketRulesCache.set(symbol, rules);
            return rules;
        } catch (error) {
            logger.warn(`[CryptoRules] Failed to fetch market rules for ${symbol}, using fallback. ${error.message}`);
            this.marketRulesCache.set(symbol, fallback);
            return fallback;
        }
    }

    normalizeSizeToMarket(size, rules) {
        let adjusted = size;
        const minDealSize = this.toNumber(rules?.minDealSize);
        const maxDealSize = this.toNumber(rules?.maxDealSize);
        const dealSizeStep = this.toNumber(rules?.dealSizeStep);

        if (Number.isFinite(maxDealSize) && adjusted > maxDealSize) adjusted = maxDealSize;
        if (Number.isFinite(dealSizeStep) && dealSizeStep > 0) adjusted = this.floorToStep(adjusted, dealSizeStep);

        const decimals = this.getDecimalPlaces(dealSizeStep || minDealSize || 0.01);
        adjusted = Number(adjusted.toFixed(Math.max(2, Math.min(8, decimals))));

        if (Number.isFinite(minDealSize) && adjusted < minDealSize) return 0;
        return adjusted;
    }

    async positionSizeCrypto(balance, entryPrice, stopLossPrice, symbol) {
        const riskAmount = balance * PER_TRADE;
        const stopDistance = Math.abs(entryPrice - stopLossPrice);
        if (!Number.isFinite(stopDistance) || stopDistance <= 0) return 0;

        const rawSize = riskAmount / stopDistance;
        if (!Number.isFinite(rawSize) || rawSize <= 0) return 0;

        // Crypto margin uses 2:1 leverage.
        const leverage = 20;
        const availableMargin = Number.isFinite(this.availableMargin) && this.availableMargin > 0 ? this.availableMargin : balance;
        const maxMarginPerTrade = availableMargin / 5;
        const marginCappedSize = (maxMarginPerTrade * leverage) / entryPrice;
        const sizeBeforeRules = Math.min(rawSize, marginCappedSize);

        const rules = await this.getMarketRules(symbol);
        return this.normalizeSizeToMarket(sizeBeforeRules, rules);
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

        // Crypto: wider breathing room due to higher volatility.
        const stopLossDistance = Math.max(2.5 * atr, spread * 3);
        const stopLossPrice = isBuy ? price - stopLossDistance : price + stopLossDistance;
        const takeProfitDistance = 2 * stopLossDistance;
        const takeProfitPrice = isBuy ? price + takeProfitDistance : price - takeProfitDistance;
        const size = await this.positionSizeCrypto(this.accountBalance, price, stopLossPrice, symbol);

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

export default new CryptoTradingService();
