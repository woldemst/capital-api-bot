import WebSocket from "ws";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CapitalWebSocketPriceFeed {
    constructor({
        wsBaseUrl,
        apiKey,
        getAuthTokens,
        logger = console,
        reconnectMs = 5000,
        onMessage = null,
        onTick = null,
        subscriptionBuilder = null,
    }) {
        this.wsBaseUrl = String(wsBaseUrl || "").replace(/\/$/, "");
        this.apiKey = apiKey;
        this.getAuthTokens = getAuthTokens;
        this.logger = logger;
        this.reconnectMs = reconnectMs;
        this.onMessage = onMessage;
        this.onTick = onTick;
        this.subscriptionBuilder = subscriptionBuilder;
        this.ws = null;
        this.running = false;
        this.lastSymbols = [];
    }

    parseTick(rawMessage) {
        try {
            const msg = typeof rawMessage === "string" ? JSON.parse(rawMessage) : JSON.parse(rawMessage.toString("utf8"));
            if (msg?.payload?.epic && (msg?.payload?.bid || msg?.payload?.ofr || msg?.payload?.offer)) {
                return {
                    symbol: String(msg.payload.epic).toUpperCase(),
                    bid: Number(msg.payload.bid),
                    ask: Number(msg.payload.ofr ?? msg.payload.offer),
                    timestamp: msg.payload.timestamp || new Date().toISOString(),
                    raw: msg,
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    async connect(symbols = []) {
        this.lastSymbols = [...symbols];
        this.running = true;
        while (this.running) {
            try {
                const tokens = await this.getAuthTokens();
                await this.connectOnce(tokens, this.lastSymbols);
                return;
            } catch (error) {
                this.logger.warn?.(`[CapitalWebSocketPriceFeed] Connect error: ${error.message}`);
                if (!this.running) break;
                await sleep(this.reconnectMs);
            }
        }
    }

    connectOnce(tokens, symbols) {
        return new Promise((resolve, reject) => {
            const wsUrl = `${this.wsBaseUrl}/connect`;
            this.ws = new WebSocket(wsUrl, {
                headers: {
                    "X-CAP-API-KEY": this.apiKey,
                    "X-SECURITY-TOKEN": tokens?.xsecurity,
                    CST: tokens?.cst,
                },
            });

            let settled = false;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };

            this.ws.on("open", () => {
                const subMessage =
                    typeof this.subscriptionBuilder === "function"
                        ? this.subscriptionBuilder({ symbols, tokens })
                        : {
                              destination: "OHLCMarketData.subscribe",
                              correlationId: "intraday-1",
                              cst: tokens?.cst,
                              securityToken: tokens?.xsecurity,
                              payload: { epics: symbols },
                          };
                this.ws.send(JSON.stringify(subMessage));
                settle(resolve);
            });

            this.ws.on("message", async (msg) => {
                if (typeof this.onMessage === "function") {
                    await this.onMessage(msg);
                }
                const tick = this.parseTick(msg);
                if (tick && typeof this.onTick === "function") {
                    await this.onTick(tick);
                }
            });

            this.ws.on("error", (error) => {
                this.logger.warn?.(`[CapitalWebSocketPriceFeed] WS error: ${error.message}`);
                settle(reject, error);
            });

            this.ws.on("close", async () => {
                if (!this.running) return;
                await sleep(this.reconnectMs);
                if (this.running) {
                    this.connect(this.lastSymbols).catch((error) => {
                        this.logger.warn?.(`[CapitalWebSocketPriceFeed] Reconnect failed: ${error.message}`);
                    });
                }
            });
        });
    }

    disconnect() {
        this.running = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

export default CapitalWebSocketPriceFeed;

