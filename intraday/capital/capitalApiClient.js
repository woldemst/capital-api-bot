import axios from "axios";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionTokenError(error) {
    const status = error?.response?.status;
    const code = String(error?.response?.data?.errorCode || "").toLowerCase();
    if (status === 401 || status === 403) return true;
    return code.includes("session") || code.includes("token");
}

function isRetryableError(error) {
    if (isSessionTokenError(error)) return true;
    if (!error?.response) return true;
    const status = error.response.status;
    return status >= 500 || status === 429;
}

function normalizeSentimentPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num > 1 && num <= 100) return num / 100;
    if (num >= 0 && num <= 1) return num;
    return null;
}

export class CapitalApiClient {
    constructor({
        baseUrl,
        apiKey,
        identifier,
        password,
        encryptedPassword = false,
        timeoutMs = 15000,
        refreshBeforeMs = 90_000,
        sessionTtlMs = 9 * 60 * 1000,
        maxRetries = 3,
        logger = console,
        axiosInstance = null,
    }) {
        this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
        this.apiKey = apiKey;
        this.identifier = identifier;
        this.password = password;
        this.encryptedPassword = encryptedPassword;
        this.refreshBeforeMs = refreshBeforeMs;
        this.sessionTtlMs = sessionTtlMs;
        this.maxRetries = maxRetries;
        this.logger = logger;
        this.http =
            axiosInstance ||
            axios.create({
                timeout: timeoutMs,
            });
        this.tokens = {
            cst: null,
            securityToken: null,
            acquiredAtMs: 0,
            expiresAtMs: 0,
        };
        this.authPromise = null;
    }

    get sessionHeaders() {
        return {
            "X-CAP-API-KEY": this.apiKey,
            ...(this.tokens.securityToken ? { "X-SECURITY-TOKEN": this.tokens.securityToken } : {}),
            ...(this.tokens.cst ? { CST: this.tokens.cst } : {}),
        };
    }

    get authTokens() {
        return {
            cst: this.tokens.cst,
            xsecurity: this.tokens.securityToken,
        };
    }

    hasValidTokens() {
        return Boolean(this.tokens.cst && this.tokens.securityToken);
    }

    shouldRefresh() {
        if (!this.hasValidTokens()) return true;
        if (!Number.isFinite(this.tokens.expiresAtMs)) return true;
        return Date.now() >= this.tokens.expiresAtMs - this.refreshBeforeMs;
    }

    updateTokensFromHeaders(headers = {}) {
        const cst = headers.cst || headers.CST || headers["cst"] || headers["CST"];
        const securityToken =
            headers["x-security-token"] || headers["X-SECURITY-TOKEN"] || headers.xSecurityToken || headers.securityToken;

        if (cst) this.tokens.cst = cst;
        if (securityToken) this.tokens.securityToken = securityToken;
        if (cst || securityToken) {
            this.tokens.acquiredAtMs = Date.now();
            this.tokens.expiresAtMs = Date.now() + this.sessionTtlMs;
        }
    }

    async authenticate(force = false) {
        if (!force && !this.shouldRefresh()) return;
        if (this.authPromise) return this.authPromise;

        this.authPromise = (async () => {
            const hasTokens = this.hasValidTokens();
            if (hasTokens && !force) {
                try {
                    await this.refreshSession();
                    return;
                } catch (error) {
                    this.logger.warn?.(`[CapitalApiClient] Session refresh failed, re-authenticating: ${error.message}`);
                }
            }
            await this.startSession();
        })();

        try {
            await this.authPromise;
        } finally {
            this.authPromise = null;
        }
    }

    async startSession() {
        const url = `${this.baseUrl}/session`;
        const response = await this.http.post(
            url,
            {
                identifier: this.identifier,
                password: this.password,
                encryptedPassword: this.encryptedPassword,
            },
            {
                headers: {
                    "X-CAP-API-KEY": this.apiKey,
                    "Content-Type": "application/json",
                },
            },
        );
        this.updateTokensFromHeaders(response.headers || {});
        if (!this.hasValidTokens()) {
            throw new Error("Capital.com session started but tokens are missing (CST/X-SECURITY-TOKEN).");
        }
        return response.data;
    }

    async refreshSession() {
        const url = `${this.baseUrl}/session`;
        const response = await this.http.get(url, {
            headers: this.sessionHeaders,
        });
        this.updateTokensFromHeaders(response.headers || {});
        if (!this.hasValidTokens()) {
            throw new Error("Capital.com session refresh did not return valid tokens.");
        }
        return response.data;
    }

    async request(method, endpoint, { data, params, headers = {}, retry = 0 } = {}) {
        await this.authenticate(false);
        const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
        try {
            const response = await this.http.request({
                method,
                url,
                data,
                params,
                headers: {
                    ...this.sessionHeaders,
                    ...headers,
                },
            });
            this.updateTokensFromHeaders(response.headers || {});
            return response.data;
        } catch (error) {
            if (isSessionTokenError(error) && retry < 1) {
                await this.authenticate(true);
                return this.request(method, endpoint, { data, params, headers, retry: retry + 1 });
            }
            if (isRetryableError(error) && retry < this.maxRetries) {
                const backoffMs = Math.min(5000, 250 * 2 ** retry);
                await sleep(backoffMs);
                return this.request(method, endpoint, { data, params, headers, retry: retry + 1 });
            }
            throw error;
        }
    }

    async getSessionDetails() {
        return this.request("GET", "/session");
    }

    async getOpenPositions() {
        return this.request("GET", "/positions");
    }

    async getMarketInfo(symbol) {
        return this.request("GET", `/markets/${encodeURIComponent(symbol)}`);
    }

    async getClientSentiment(symbol) {
        const encoded = encodeURIComponent(symbol);
        try {
            const data = await this.request("GET", `/clientsentiment/${encoded}`);
            return this.normalizeClientSentiment(symbol, data);
        } catch (error) {
            const fallback = await this.request("GET", "/clientsentiment", { params: { marketIds: symbol } });
            return this.normalizeClientSentiment(symbol, fallback);
        }
    }

    normalizeClientSentiment(symbol, raw) {
        const row =
            raw?.clientSentiment ||
            raw?.market ||
            (Array.isArray(raw?.clientSentiments) ? raw.clientSentiments[0] : null) ||
            (Array.isArray(raw?.markets) ? raw.markets[0] : null) ||
            raw;
        const clientLongPct =
            normalizeSentimentPercent(row?.longPositionPercentage) ??
            normalizeSentimentPercent(row?.clientLongPct) ??
            normalizeSentimentPercent(row?.longPct);
        const clientShortPct =
            normalizeSentimentPercent(row?.shortPositionPercentage) ??
            normalizeSentimentPercent(row?.clientShortPct) ??
            normalizeSentimentPercent(row?.shortPct);

        return {
            symbol: String(symbol || row?.marketId || row?.epic || "").toUpperCase(),
            clientLongPct,
            clientShortPct,
            raw,
            timestamp: new Date().toISOString(),
        };
    }

    async placePosition(orderPlan) {
        if (!orderPlan?.symbol || !orderPlan?.side) {
            throw new Error("placePosition requires orderPlan.symbol and orderPlan.side.");
        }
        if (!Number.isFinite(Number(orderPlan.sl)) || !Number.isFinite(Number(orderPlan.tp))) {
            throw new Error("Initial SL/TP are mandatory.");
        }

        const direction = String(orderPlan.side).toUpperCase() === "LONG" ? "BUY" : "SELL";
        const payload = {
            epic: String(orderPlan.symbol).toUpperCase(),
            direction,
            size: Number(orderPlan.size),
            orderType: "MARKET",
            guaranteedStop: false,
            stopLevel: Number(orderPlan.sl),
            profitLevel: Number(orderPlan.tp),
        };

        return this.request("POST", "/positions", {
            data: payload,
            headers: {
                "Content-Type": "application/json",
            },
        });
    }

    async updatePositionProtection(dealId, { stopLevel, profitLevel }) {
        return this.request("PUT", `/positions/${encodeURIComponent(dealId)}`, {
            data: {
                ...(Number.isFinite(Number(stopLevel)) ? { stopLevel: Number(stopLevel) } : {}),
                ...(Number.isFinite(Number(profitLevel)) ? { profitLevel: Number(profitLevel) } : {}),
            },
            headers: {
                "Content-Type": "application/json",
            },
        });
    }
}

export default CapitalApiClient;

