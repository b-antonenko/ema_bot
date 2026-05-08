require("dotenv").config();
const axios = require("axios");
const cron = require("node-cron");
const { EMA, MACD, ADX } = require("technicalindicators");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1h";
const MIN_SPREAD_PCT = parseFloat(process.env.MIN_SPREAD_PCT) || 0.005;
const CONFIRM_DELAY = parseInt(process.env.CONFIRM_DELAY) || 2;
const TRAILING_STOP_PCT = parseFloat(process.env.TRAILING_STOP_PCT) || 0.015;
const ADX_MIN = parseFloat(process.env.ADX_MIN) || 20;
const ADX_PERIOD = parseInt(process.env.ADX_PERIOD) || 14;
const PARTIAL_TP_PCT = parseFloat(process.env.PARTIAL_TP_PCT) || 0.015;
const POSITION_SIZE_USD = parseFloat(process.env.POSITION_SIZE_USD) || 1000;

let state = {
  crossState: null,
  waitingForTouch: null,
  crossConfirmedAt: null,
  lastCrossNotified: null,
  filtersNotified: false,
  position: null,
};

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[TG]\n" + message);
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" },
    );
  } catch (err) {
    console.error("TG error:", err.response?.data?.description || err.message);
  }
}

async function fetchKlines(limit = 200) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}`,
  );
  return res.data;
}

function padArray(arr, len) {
  return [...Array(len - arr.length).fill(null), ...arr];
}
function touchesEma(low, high, v) {
  return v !== null && low <= v && v <= high;
}
function fmt(p) {
  return p >= 1000 ? p.toFixed(2) : p.toFixed(4);
}
function fmtPct(p) {
  return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
}
function pnlEmoji(p) {
  return p >= 2 ? "🚀" : p >= 0 ? "🟢" : p >= -1 ? "🟡" : "🔴";
}
function now() {
  return new Date().toUTCString();
}

function calcIndicators(klines) {
  const closes = klines.map((k) => parseFloat(k[4]));
  const highs = klines.map((k) => parseFloat(k[2]));
  const lows = klines.map((k) => parseFloat(k[3]));
  const times = klines.map((k) => k[0]);
  const len = closes.length;
  const ema20 = padArray(EMA.calculate({ period: 20, values: closes }), len);
  const ema50 = padArray(EMA.calculate({ period: 50, values: closes }), len);
  const macdArr = padArray(
    MACD.calculate({
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
      values: closes,
    }),
    len,
  );
  const adxArr = padArray(
    ADX.calculate({
      period: ADX_PERIOD,
      high: highs,
      low: lows,
      close: closes,
    }),
    len,
  );
  return { closes, highs, lows, times, ema20, ema50, macdArr, adxArr, len };
}

async function scan() {
  try {
    const klines = await fetchKlines(200);
    const { closes, highs, lows, times, ema20, ema50, macdArr, adxArr, len } =
      calcIndicators(klines);
    const i = len - 2; // last CLOSED candle — avoids false signals on forming candle
    const e20 = ema20[i],
      e50 = ema50[i];
    const e20prev = ema20[i - 1],
      e50prev = ema50[i - 1];
    if (!e20 || !e50 || !e20prev || !e50prev) return;

    const currentPrice = closes[len - 1];
    const goldenCross = e20prev <= e50prev && e20 > e50;
    const deathCross = e20prev >= e50prev && e20 < e50;
    const adxVal = adxArr[i] ? adxArr[i].adx : null;
    const macdHist = macdArr[i] ? macdArr[i].histogram : null;
    const spread = Math.abs(e20 - e50) / e50;

    // ── Position management ────────────────────────────────────────────────
    if (state.position) {
      const pos = state.position;

      if (pos.type === "LONG") {
        // Update trailing stop on new highs
        if (highs[i] > pos.trailPeak) {
          const old = pos.trailStop;
          pos.trailPeak = highs[i];
          pos.trailStop = pos.trailPeak * (1 - TRAILING_STOP_PCT);
          if (pos.trailStop > old + 0.5)
            await sendTelegram(
              `🔄 <b>STOP LOSS MOVED UP</b> — ${SYMBOL}

📌 LONG | Entry: <b>$${fmt(pos.entryPrice)}</b>
📈 New Peak: <b>$${fmt(pos.trailPeak)}</b>
🛡 <b>New SL: $${fmt(pos.trailStop)}</b> | Old: $${fmt(old)}
🕐 ${now()}`,
            );
        }
        // Partial TP
        if (!pos.partialDone && highs[i] >= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.partialTP - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ <b>PARTIAL TP HIT</b> — ${SYMBOL}

🎯 50% closed at <b>$${fmt(pos.partialTP)}</b>
📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})
🛡 SL still at $${fmt(pos.trailStop)}
🕐 ${now()}`,
          );
        }
        // Trailing stop hit
        if (lows[i] <= pos.trailStop) {
          const p = ((pos.trailStop - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 <b>CLOSED — TRAILING STOP HIT</b> — ${SYMBOL}

📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}
📊 <b>${fmtPct(p)}</b> (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})
🕐 ${now()}`,
          );
          state.position = null;
          return;
        }
        // Death cross exit
        if (deathCross) {
          const p = ((closes[i] - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 <b>CLOSED — DEATH CROSS</b> — ${SYMBOL}

📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[i])}
📊 <b>${fmtPct(p)}</b> (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})
🕐 ${now()}`,
          );
          state.position = null;
        }
      }

      if (pos.type === "SHORT") {
        // Update trailing stop on new lows
        if (lows[i] < pos.trailPeak) {
          const old = pos.trailStop;
          pos.trailPeak = lows[i];
          pos.trailStop = pos.trailPeak * (1 + TRAILING_STOP_PCT);
          if (pos.trailStop < old - 0.5)
            await sendTelegram(
              `🔄 <b>STOP LOSS MOVED DOWN</b> — ${SYMBOL}

📌 SHORT | Entry: <b>$${fmt(pos.entryPrice)}</b>
📉 New Trough: <b>$${fmt(pos.trailPeak)}</b>
🛡 <b>New SL: $${fmt(pos.trailStop)}</b> | Old: $${fmt(old)}
🕐 ${now()}`,
            );
        }
        // Partial TP
        if (!pos.partialDone && lows[i] <= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.entryPrice - pos.partialTP) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ <b>PARTIAL TP HIT</b> — ${SYMBOL}

🎯 50% closed at <b>$${fmt(pos.partialTP)}</b>
📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})
🛡 SL still at $${fmt(pos.trailStop)}
🕐 ${now()}`,
          );
        }
        // Trailing stop hit
        if (highs[i] >= pos.trailStop) {
          const p = ((pos.entryPrice - pos.trailStop) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 <b>CLOSED — TRAILING STOP HIT</b> — ${SYMBOL}

📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}
📊 <b>${fmtPct(p)}</b> (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})
🕐 ${now()}`,
          );
          state.position = null;
          return;
        }
        // Golden cross exit
        if (goldenCross) {
          const p = ((pos.entryPrice - closes[i]) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 <b>CLOSED — GOLDEN CROSS</b> — ${SYMBOL}

📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[i])}
📊 <b>${fmtPct(p)}</b> (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})
🕐 ${now()}`,
          );
          state.position = null;
        }
      }
    }

    // ── Detect new cross ───────────────────────────────────────────────────
    if (goldenCross && state.lastCrossNotified !== "golden") {
      state.crossState = "golden";
      state.waitingForTouch = "LONG";
      state.crossConfirmedAt = i;
      state.lastCrossNotified = "golden";
      state.filtersNotified = false;
      await sendTelegram(
        `☀️ <b>GOLDEN CROSS DETECTED</b> — ${SYMBOL}

EMA20 crossed <b>UP</b> EMA50
EMA20: <b>$${fmt(e20)}</b> | EMA50: <b>$${fmt(e50)}</b>
Spread: ${(spread * 100).toFixed(3)}%

⏳ Waiting ${CONFIRM_DELAY} candles, then watching for EMA20 touch
🔍 <i>Preparing to enter LONG...</i>
🕐 ${now()}`,
      );
    } else if (deathCross && state.lastCrossNotified !== "death") {
      state.crossState = "death";
      state.waitingForTouch = "SHORT";
      state.crossConfirmedAt = i;
      state.lastCrossNotified = "death";
      state.filtersNotified = false;
      await sendTelegram(
        `🌑 <b>DEATH CROSS DETECTED</b> — ${SYMBOL}

EMA20 crossed <b>DOWN</b> EMA50
EMA20: <b>$${fmt(e20)}</b> | EMA50: <b>$${fmt(e50)}</b>
Spread: ${(spread * 100).toFixed(3)}%

⏳ Waiting ${CONFIRM_DELAY} candles, then watching for EMA20 touch
🔍 <i>Preparing to enter SHORT...</i>
🕐 ${now()}`,
      );
    }

    // ── Entry logic ────────────────────────────────────────────────────────
    const delayPassed =
      state.crossConfirmedAt !== null &&
      i - state.crossConfirmedAt >= CONFIRM_DELAY;
    if (!state.position && state.waitingForTouch && delayPassed) {
      const spreadOk = spread >= MIN_SPREAD_PCT;
      const adxOk = adxVal !== null && adxVal >= ADX_MIN;
      const macdLongOk =
        state.waitingForTouch === "LONG" && macdHist !== null && macdHist > 0;
      const macdShortOk =
        state.waitingForTouch === "SHORT" && macdHist !== null && macdHist < 0;
      const macdOk = macdLongOk || macdShortOk;
      const touchOk = touchesEma(lows[i], highs[i], e20);
      const allOk = spreadOk && adxOk && macdOk;

      // Notify once when all filters pass (before touch)
      if (allOk && !state.filtersNotified) {
        state.filtersNotified = true;
        const dir = state.waitingForTouch;
        await sendTelegram(
          `✅ <b>ALL FILTERS PASSED — READY TO ENTER</b> — ${SYMBOL}

🎯 Direction: <b>${dir}</b>
✅ Spread: ${(spread * 100).toFixed(3)}% ≥ ${(MIN_SPREAD_PCT * 100).toFixed(2)}%
✅ ADX: ${adxVal?.toFixed(1)} ≥ ${ADX_MIN}
✅ MACD Hist: ${macdHist?.toFixed(3)} (${dir === "LONG" ? "bullish" : "bearish"})

👀 Watching for touch of EMA20 at <b>$${fmt(e20)}</b>
🛡 Initial SL: $${fmt(dir === "LONG" ? e20 * (1 - TRAILING_STOP_PCT) : e20 * (1 + TRAILING_STOP_PCT))}
🎯 Partial TP: $${fmt(dir === "LONG" ? e20 * (1 + PARTIAL_TP_PCT) : e20 * (1 - PARTIAL_TP_PCT))}
🕐 ${now()}`,
        );
      }

      // Enter on EMA20 touch
      if (allOk && touchOk) {
        const ep = e20;
        if (state.waitingForTouch === "LONG") {
          const sl = ep * (1 - TRAILING_STOP_PCT),
            tp = ep * (1 + PARTIAL_TP_PCT);
          state.position = {
            type: "LONG",
            entryPrice: ep,
            entryTime: times[i],
            trailStop: sl,
            trailPeak: ep,
            partialTP: tp,
            partialDone: false,
          };
          state.waitingForTouch = null;
          state.crossConfirmedAt = null;
          await sendTelegram(
            `📈 <b>LONG ENTRY SIGNAL</b> — ${SYMBOL}

💰 Entry: <b>$${fmt(ep)}</b>
🛡 Stop Loss: <b>$${fmt(sl)}</b> (trailing −${(TRAILING_STOP_PCT * 100).toFixed(1)}%)
🎯 Partial TP 50%: <b>$${fmt(tp)}</b> (+${(PARTIAL_TP_PCT * 100).toFixed(1)}%)
EMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}
ADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}
🕐 ${now()}`,
          );
        } else {
          const sl = ep * (1 + TRAILING_STOP_PCT),
            tp = ep * (1 - PARTIAL_TP_PCT);
          state.position = {
            type: "SHORT",
            entryPrice: ep,
            entryTime: times[i],
            trailStop: sl,
            trailPeak: ep,
            partialTP: tp,
            partialDone: false,
          };
          state.waitingForTouch = null;
          state.crossConfirmedAt = null;
          await sendTelegram(
            `📉 <b>SHORT ENTRY SIGNAL</b> — ${SYMBOL}

💰 Entry: <b>$${fmt(ep)}</b>
🛡 Stop Loss: <b>$${fmt(sl)}</b> (trailing +${(TRAILING_STOP_PCT * 100).toFixed(1)}%)
🎯 Partial TP 50%: <b>$${fmt(tp)}</b> (−${(PARTIAL_TP_PCT * 100).toFixed(1)}%)
EMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}
ADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}
🕐 ${now()}`,
          );
        }
      }
    }

    console.log(
      `[${new Date().toISOString()}] $${fmt(currentPrice)} EMA20:${e20?.toFixed(1)} EMA50:${e50?.toFixed(1)} ADX:${adxVal?.toFixed(1)} Pos:${state.position?.type || "none"}`,
    );
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

async function sendPnlUpdate() {
  if (!state.position) return;
  try {
    const klines = await fetchKlines(5);
    const cp = parseFloat(klines[klines.length - 1][4]);
    const pos = state.position;
    const pnlPct =
      pos.type === "LONG"
        ? ((cp - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - cp) / pos.entryPrice) * 100;
    const pnlUsd = POSITION_SIZE_USD * (pnlPct / 100);
    const diff = cp - pos.entryPrice;
    const toStop =
      pos.type === "LONG"
        ? ((cp - pos.trailStop) / cp) * 100
        : ((pos.trailStop - cp) / cp) * 100;
    await sendTelegram(
      `${pnlEmoji(pnlPct)} <b>POSITION UPDATE</b> — ${SYMBOL}

📌 <b>${pos.type}</b> | Entry: $${fmt(pos.entryPrice)}
📊 Current: <b>$${fmt(cp)}</b> (${diff >= 0 ? "+" : ""}${fmt(diff)})
💵 PnL: <b>${fmtPct(pnlPct)}</b> (~$${pnlUsd.toFixed(2)})
🛡 SL: $${fmt(pos.trailStop)} (${toStop.toFixed(2)}% away)
${pos.partialDone ? "✂️ Partial TP already taken" : `🎯 Partial TP target: $${fmt(pos.partialTP)}`}
🕐 ${now()}`,
    );
  } catch (err) {
    console.error("PnL update error:", err.message);
  }
}

async function main() {
  console.log(`🚀 EMA Scanner | ${SYMBOL} ${INTERVAL}`);
  console.log(
    `📡 Telegram: ${TELEGRAM_TOKEN ? "configured" : "DISABLED — set TELEGRAM_BOT_TOKEN in .env"}`,
  );
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `🚀 <b>EMA Scanner Started</b>

📊 ${SYMBOL} | ⏱ ${INTERVAL}
Spread ≥${(MIN_SPREAD_PCT * 100).toFixed(1)}% | ADX ≥${ADX_MIN} | MACD | ${CONFIRM_DELAY}-candle delay
Trailing SL: ${(TRAILING_STOP_PCT * 100).toFixed(1)}% | Partial TP: ${(PARTIAL_TP_PCT * 100).toFixed(1)}%
🕐 ${now()}`,
    );
  }
  await scan();
  cron.schedule("*/5 * * * *", () => scan());
  cron.schedule("*/15 * * * *", () => sendPnlUpdate());
  console.log("✅ Running — scan: every 5m | PnL heartbeat: every 15m");
}

main().catch(console.error);
