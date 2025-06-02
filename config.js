import "dotenv/config";

export const API_KEY = process.env.API_KEY;
export const API_IDENTIFIER = process.env.API_IDENTIFIER;
export const API_PASSWORD = process.env.API_PASSWORD;
export const BASE_URL = process.env.BASE_URL;
export const API_PATH = process.env.API_PATH;
export const WS_BASE_URL = process.env.WS_BASE_URL;

// Trading configuration
export const SYMBOLS = ["EURUSD", "GBPUSD", "EURGBP", "AUDUSD", "USDCAD"];
export const LEVERAGE = 30;
export const RISK_PER_TRADE = 0.02; // 2% risk per trade
export const MAX_OPEN_TRADES = 3;
export const TAKE_PROFIT_FACTOR = 2; // Take profit at 2x stop loss
export const TRAILING_STOP_ACTIVATION = 0.5; // Activate trailing stop at 50% of take profit
export const TRAILING_STOP_PIPS = 10; // 10 pips trailing stop for EUR/USD
export const PROFIT_THRESHOLD = 0.05; // 5% profit threshold for increasing position size
export const POSITION_SIZE_INCREASE = 0.5; // 50% increase in position size after profit threshold