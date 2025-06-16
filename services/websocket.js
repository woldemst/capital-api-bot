import WebSocket from "ws";
import { API, MODE } from "../config.js";

const { WS_URL, KEY: API_KEY } = API;

class WebSocketService {
  constructor() {
    this.ws = null;
    // this.pingInterval = MODE.DEV_MODE === true ? 1000 : 9 * 60 * 1000; // Ping every 9 minutes in production, 1 second in dev mode
    
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
        console.log("WebSocket connected");

        const subscriptionMessage = {
          destination: "OHLCMarketData.subscribe",
          correlationId: "1",
          cst,
          securityToken: xsecurity,
          payload: { epics: symbols },
        };
        this.ws.send(JSON.stringify(subscriptionMessage));

        setInterval(() => {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, this.pingInterval);
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
