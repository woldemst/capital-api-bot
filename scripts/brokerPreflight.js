import { startSession, getSessionTokens } from "../api.js";
import { API, LIVE_SYMBOLS, NEWS_GUARD, SESSIONS, TRADING_WINDOWS } from "../config.js";
import logger from "../utils/logger.js";
import { assertStartupConfig, runBrokerPreflight, validateStartupConfig } from "../utils/startupValidation.js";

async function main() {
    const validation = validateStartupConfig({
        api: API,
        liveSymbols: LIVE_SYMBOLS,
        sessions: SESSIONS,
        tradingWindows: TRADING_WINDOWS,
        newsGuard: NEWS_GUARD,
        env: process.env,
    });

    for (const warning of validation.warnings) {
        logger.warn(`[Smoke][Config] ${warning}`);
    }
    assertStartupConfig(validation);

    logger.info(
        `[Smoke][Config] OK | env=${validation.environment} | api=${validation.apiBaseUrl} | symbols=${validation.liveSymbols.join(", ")}`,
    );

    await startSession();
    const tokens = getSessionTokens();
    if (!tokens?.cst || !tokens?.xsecurity) {
        throw new Error("Session-Start erfolgreich, aber Session-Tokens fehlen.");
    }

    const preflight = await runBrokerPreflight({
        symbols: validation.liveSymbols.length ? validation.liveSymbols : validation.configuredSessionSymbols,
    });

    logger.info(
        `[Smoke][Broker] account=${preflight.account.currency} balance=${preflight.account.balance} available=${preflight.account.available}`,
    );
    logger.info(
        `[Smoke][Broker] symbols=${preflight.symbols.map((row) => `${row.symbol}:${row.marketStatus}:min=${row.minDealSize}`).join(", ")}`,
    );

    for (const warning of preflight.warnings) {
        logger.warn(`[Smoke][Broker] ${warning}`);
    }
}

main()
    .then(() => {
        logger.info("[Smoke] Broker-Preflight erfolgreich.");
        process.exit(0);
    })
    .catch((error) => {
        logger.error("[Smoke] Broker-Preflight fehlgeschlagen:", error);
        process.exit(1);
    });
