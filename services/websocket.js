import WebSocket from "ws";
import { WS_BASE_URL, API_KEY } from "../config.js";
import { getHeaders } from "../api.js";

class WebSocketService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.pingInterval = null;
    this.analysisInterval = null;
  }

  connect(tokens, symbols, messageHandler) {
    const { cst, xsecurity } = tokens;
    const wsUrl = `${WS_BASE_URL}/connect`;

    console.log(`Connecting to WebSocket: ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        "X-SECURITY-TOKEN": xsecurity,
        "X-CAP-API-KEY": API_KEY,
        CST: cst,
      },
    });

    this.ws.on("open", async () => {
      try {
        this.isConnected = true;
        console.log("WebSocket connected");

        // Send subscription message with authentication tokens
        const subscriptionMessage = {
          destination: "OHLCMarketData.subscribe",
          correlationId: "1",
          cst: cst,
          securityToken: xsecurity,
          payload: { epics: symbols },
        };
        this.ws.send(JSON.stringify(subscriptionMessage));
        console.log(`Subscribed to symbols: ${symbols}`);

        // Keep connection alive with ping every 9 minutes
        this.pingInterval = setInterval(() => {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
            console.log("Ping sent to keep WebSocket connection alive");
          }
        }, 9 * 60 * 1000);
      } catch (error) {
        console.error("Error connecting to WebSocket:", error);
      }
    });

    this.ws.on("message", messageHandler);

    this.ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    this.ws.on("close", () => {
      console.log("WebSocket connection closed");
      this.isConnected = false;
      clearInterval(this.pingInterval);
      clearImmediate(this.analysisInterval);
    });

    return this;
  }

  disconnect() {
    if (this.ws) {
      clearInterval(this.pingInterval);
      clearImmediate(this.analysisInterval);
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}

export default new WebSocketService();
