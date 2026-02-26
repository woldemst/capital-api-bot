function isoDayKey(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toISOString().slice(0, 10);
}

export function createIntradayRuntimeState(seed = {}) {
    return {
        strategyId: seed.strategyId || null,
        dayKey: seed.dayKey || null,
        dailyTradeCount: 0,
        dailyPnl: 0,
        openPositions: new Map(),
        closedTrades: [],
        sentimentBySymbol: new Map(),
        lastDecisionBySymbol: new Map(),
        ...seed,
    };
}

export function ensureStateDay(state, nowUtc) {
    const nextDayKey = isoDayKey(nowUtc);
    if (state.dayKey === nextDayKey) return state;
    state.dayKey = nextDayKey;
    state.dailyTradeCount = 0;
    state.dailyPnl = 0;
    state.lastDecisionBySymbol = new Map();
    return state;
}

export function registerOpenedTrade(state, position) {
    state.openPositions.set(String(position.symbol).toUpperCase(), { ...position });
    state.dailyTradeCount += 1;
    return state;
}

export function registerClosedTrade(state, closedTrade) {
    const symbolKey = String(closedTrade.symbol || "").toUpperCase();
    state.openPositions.delete(symbolKey);
    state.closedTrades.push({ ...closedTrade });
    if (Number.isFinite(closedTrade.pnl)) {
        state.dailyPnl += closedTrade.pnl;
    }
    return state;
}

export function upsertSentiment(state, sentimentSnapshot) {
    const symbol = String(sentimentSnapshot?.symbol || "").toUpperCase();
    if (!symbol) return state;
    state.sentimentBySymbol.set(symbol, { ...sentimentSnapshot });
    return state;
}

export function getSentimentForSymbol(state, symbol) {
    return state.sentimentBySymbol.get(String(symbol || "").toUpperCase()) || null;
}

export function getOpenPosition(state, symbol) {
    return state.openPositions.get(String(symbol || "").toUpperCase()) || null;
}

