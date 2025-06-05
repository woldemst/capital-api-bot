import WebSocket from "ws";
import { WS_BASE_URL, API_KEY } from "../config.js";

class WebSocketService {
  constructor() {
    this.ws = null;
    this.pingInterval = null;
  }

  connect(tokens, symbols, messageHandler) {
    const { cst, xsecurity } = tokens;
    const wsUrl = `${WS_BASE_URL}/connect`;

    const connectWS = () => {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          "X-SECURITY-TOKEN": xsecurity,
          "X-CAP-API-KEY": API_KEY,
          CST: cst,
        },
      });

      this.ws.on("open", () => {
        console.log("WebSocket connected");

        const subscriptionMessage = {
          destination: "OHLCMarketData.subscribe",
          correlationId: "1",
          cst,
          securityToken: xsecurity,
          payload: { epics: symbols },
        };
        this.ws.send(JSON.stringify(subscriptionMessage));

        this.pingInterval = setInterval(() => {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 9 * 60 * 1000);
      });

      this.ws.on("message", messageHandler);

      this.ws.on("error", (error) => {
        console.error("WebSocket error:", error);
      });

      this.ws.on("close", () => {
        console.log("WebSocket disconnected, attempting to reconnect in 5s...");
        clearInterval(this.pingInterval);
        setTimeout(connectWS, 5000);
      });
    };

    connectWS();
    return this;
  }

  disconnect() {
    if (this.ws) {
      clearInterval(this.pingInterval);
      this.ws.close();
      this.ws = null;
    }
  }
}

export default new WebSocketService();
