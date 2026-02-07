import { CRYPTO_SYMBOLS } from "../config.js";
import forexTradingService from "./trading/forexTradingService.js";
import cryptoTradingService from "./trading/cryptoTradingService.js";

class TradingRouter {
    isCryptoSymbol(symbol) {
        return CRYPTO_SYMBOLS.includes(symbol);
    }

    getServiceForSymbol(symbol) {
        return this.isCryptoSymbol(symbol) ? cryptoTradingService : forexTradingService;
    }

    setAccountBalance(balance) {
        forexTradingService.setAccountBalance(balance);
        cryptoTradingService.setAccountBalance(balance);
    }

    setAvailableMargin(margin) {
        forexTradingService.setAvailableMargin(margin);
        cryptoTradingService.setAvailableMargin(margin);
    }

    setOpenTrades(trades) {
        forexTradingService.setOpenTrades(trades);
        cryptoTradingService.setOpenTrades(trades);
    }

    async processPrice(payload) {
        return this.getServiceForSymbol(payload?.symbol).processPrice(payload);
    }

    async updateTrailingStopIfNeeded(position, indicators) {
        return this.getServiceForSymbol(position?.symbol).updateTrailingStopIfNeeded(position, indicators);
    }

    // Closing logic is shared; use one instance.
    async closePosition(dealId, label) {
        return forexTradingService.closePosition(dealId, label);
    }
}

export default new TradingRouter();
