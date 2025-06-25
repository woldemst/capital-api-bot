import WebSocket from "ws";
import { API } from "../config.js";
import logger from "../utils/logger.js";

const { WS_URL, KEY: API_KEY } = API;

class WebSocketService {
  constructor() {
    this.ws = null;
  }

  connect(tokens, symbols, messageHandler) {
    const { cst, xsecurity } = tokens;
    const wsUrl = `${WS_URL}/connect`;

    const connectWS = () => {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          "X-SECURITY-TOKEN": xsecurity,
          "X-CAP-API-KEY": API_KEY,
          CST: cst,
        },
      });

      this.ws.on("open", () => {
        // logger.info("WebSocket connected");

        const subscriptionMessage = {
          destination: "OHLCMarketData.subscribe",
          correlationId: "1",
          cst,
          securityToken: xsecurity,
          payload: { epics: symbols },
        };
        this.ws.send(JSON.stringify(subscriptionMessage));
      });

      this.ws.on("message", messageHandler);

      this.ws.on("error", (error) => {
        logger.error("WebSocket error:", error);
      });

      this.ws.on("close", () => {
        logger.info("WebSocket disconnected, attempting to reconnect in 5s...");
        setTimeout(connectWS, 5000);
      });
    };

    connectWS();
    return this;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default new WebSocketService();
