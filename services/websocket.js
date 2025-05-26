import WebSocket from "ws";
import { WS_BASE_URL } from "../config.js";
import logger from "../utils/logger.js";

class WebSocketService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.pingInterval = null;
  }

  connect(tokens, symbols, messageHandler) {
    const { cst, xsecurity } = tokens;
    const wsUrl = `${WS_BASE_URL}/connect`;

    logger.info(`Connecting to WebSocket: ${wsUrl}`);
    
    this.ws = new WebSocket(wsUrl, {
      headers: { "X-SECURITY-TOKEN": xsecurity, CST: cst },
    });

    this.ws.on("open", () => {
      logger.info("WebSocket connected");
      this.isConnected = true;

      // Subscribe to price updates for each symbol
      const formattedSymbols = symbols.map((s) => s.replace("/", "_"));

      // Send subscription message
      const subscriptionMessage = {
        destination: "marketData.subscribe",
        correlationId: "1",
        payload: {
          epics: formattedSymbols,
        },
      };

      this.ws.send(JSON.stringify(subscriptionMessage));
      logger.info(`Subscribed to symbols: ${formattedSymbols.join(', ')}`);

      // Keep connection alive with ping every 9 minutes
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
          logger.info("Ping sent to keep WebSocket connection alive");
        }
      }, 9 * 60 * 1000);
    });

    this.ws.on("error", (error) => logger.error("WebSocket error:", error));
    
    this.ws.on("close", () => {
      logger.info("WebSocket connection closed");
      this.isConnected = false;
      clearInterval(this.pingInterval);
    });

    this.ws.on("message", messageHandler);

    return this;
  }

  disconnect() {
    if (this.ws) {
      clearInterval(this.pingInterval);
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}

export default new WebSocketService();