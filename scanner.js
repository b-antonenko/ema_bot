require("dotenv").config();
const axios = require("axios");
const cron = require("node-cron");
const { EMA, MACD, ADX } = require("technicalindicators");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = process.env.INTERVAL || "1h";
const MIN_SPREAD_PCT = parseFloat(process.env.MIN_SPREAD_PCT) || 0.005;
const CONFIRM_DELAY = parseInt(process.env.CONFIRM_DELAY) || 2;
const TRAILING_STOP_PCT = parseFloat(process.env.TRAILING_STOP_PCT) || 0.015;
const ADX_MIN = parseFloat(process.env.ADX_MIN) || 20;
const ADX_PERIOD = parseInt(process.env.ADX_PERIOD) || 14;
const PARTIAL_TP_PCT = parseFloat(process.env.PARTIAL_TP_PCT) || 0.015;
const POSITION_SIZE_USD = parseFloat(process.env.POSITION_SIZE_USD) || 1000;

const SYMBOLS = [
  "BTCUSDT",
  "SOLUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "XRPUSDT",
];

function makeState() {
  return {
    crossState: null,
    waitingForTouch: null,
    crossConfirmedAt: null,
    lastCrossNotified: null,
    filtersNotified: false,
    position: null,
    lastTouchCandleTime: null,
    lastEntryCheckCandleTime: null,
  };
}

const states = {};
for (const sym of SYMBOLS) states[sym] = makeState();

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

async function fetchKlines(symbol, limit = 200) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`,
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

async function scan(symbol) {
  const state = states[symbol];

  try {
    const klines = await fetchKlines(symbol, 200);
    const { closes, highs, lows, times, ema20, ema50, macdArr, adxArr, len } =
      calcIndicators(klines);

    if (len < 3) return;

    const signalIdx = len - 2;
    const liveIdx = len - 1;

    const e20 = ema20[signalIdx];
    const e50 = ema50[signalIdx];
    const e20prev = ema20[signalIdx - 1];
    const e50prev = ema50[signalIdx - 1];
    const liveE20 = ema20[liveIdx] ?? e20;

    if (!e20 || !e50 || !e20prev || !e50prev) return;

    const currentPrice = closes[liveIdx];
    const goldenCross = e20prev <= e50prev && e20 > e50;
    const deathCross = e20prev >= e50prev && e20 < e50;
    const adxVal = adxArr[signalIdx] ? adxArr[signalIdx].adx : null;
    const macdHist = macdArr[signalIdx] ? macdArr[signalIdx].histogram : null;
    const spread = Math.abs(e20 - e50) / e50;
    const liveTouchOk = touchesEma(lows[liveIdx], highs[liveIdx], liveE20);
    const liveCandleTime = times[liveIdx];

    if (state.position) {
      const pos = state.position;

      if (pos.type === "LONG") {
        if (highs[signalIdx] > pos.trailPeak) {
          const old = pos.trailStop;
          pos.trailPeak = highs[signalIdx];
          pos.trailStop = pos.trailPeak * (1 - TRAILING_STOP_PCT);
          if (pos.trailStop > old + 0.5) {
            await sendTelegram(
              `🔄 STOP LOSS MOVED UP — ${symbol}\n\n📌 LONG | Entry: $${fmt(pos.entryPrice)}\n📈 New Peak: $${fmt(pos.trailPeak)}\n🛡 New SL: $${fmt(pos.trailStop)} | Old: $${fmt(old)}\n🕐 ${now()}`,
            );
          }
        }

        if (!pos.partialDone && highs[signalIdx] >= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.partialTP - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ PARTIAL TP HIT — ${symbol}\n\n🎯 50% closed at $${fmt(pos.partialTP)}\n📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})\n🛡 SL still at $${fmt(pos.trailStop)}\n🕐 ${now()}`,
          );
        }

        if (lows[signalIdx] <= pos.trailStop) {
          const p = ((pos.trailStop - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — TRAILING STOP HIT — ${symbol}\n\n📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
          return;
        }

        if (deathCross) {
          const p = ((closes[signalIdx] - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — DEATH CROSS — ${symbol}\n\n📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[signalIdx])}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
        }
      }

      if (state.position && pos.type === "SHORT") {
        if (lows[signalIdx] < pos.trailPeak) {
          const old = pos.trailStop;
          pos.trailPeak = lows[signalIdx];
          pos.trailStop = pos.trailPeak * (1 + TRAILING_STOP_PCT);
          if (pos.trailStop < old - 0.5) {
            await sendTelegram(
              `🔄 STOP LOSS MOVED DOWN — ${symbol}\n\n📌 SHORT | Entry: $${fmt(pos.entryPrice)}\n📉 New Trough: $${fmt(pos.trailPeak)}\n🛡 New SL: $${fmt(pos.trailStop)} | Old: $${fmt(old)}\n🕐 ${now()}`,
            );
          }
        }

        if (!pos.partialDone && lows[signalIdx] <= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.entryPrice - pos.partialTP) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ PARTIAL TP HIT — ${symbol}\n\n🎯 50% closed at $${fmt(pos.partialTP)}\n📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})\n🛡 SL still at $${fmt(pos.trailStop)}\n🕐 ${now()}`,
          );
        }

        if (highs[signalIdx] >= pos.trailStop) {
          const p = ((pos.entryPrice - pos.trailStop) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — TRAILING STOP HIT — ${symbol}\n\n📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
          return;
        }

        if (goldenCross) {
          const p = ((pos.entryPrice - closes[signalIdx]) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — GOLDEN CROSS — ${symbol}\n\n📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[signalIdx])}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
        }
      }
    }

    if (goldenCross && state.lastCrossNotified !== "golden") {
      state.crossState = "golden";
      state.waitingForTouch = "LONG";
      state.crossConfirmedAt = signalIdx;
      state.lastCrossNotified = "golden";
      state.filtersNotified = false;
      state.lastTouchCandleTime = null;
      state.lastEntryCheckCandleTime = null;
      await sendTelegram(
        `☀️ GOLDEN CROSS DETECTED — ${symbol}\n\nEMA20 crossed UP EMA50\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nSpread: ${(spread * 100).toFixed(3)}%\n\n⏳ Waiting ${CONFIRM_DELAY} candles, then watching for LIVE EMA20 touch\n🔍 Preparing to enter LONG...\n🕐 ${now()}`,
      );
    } else if (deathCross && state.lastCrossNotified !== "death") {
      state.crossState = "death";
      state.waitingForTouch = "SHORT";
      state.crossConfirmedAt = signalIdx;
      state.lastCrossNotified = "death";
      state.filtersNotified = false;
      state.lastTouchCandleTime = null;
      state.lastEntryCheckCandleTime = null;
      await sendTelegram(
        `🌑 DEATH CROSS DETECTED — ${symbol}\n\nEMA20 crossed DOWN EMA50\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nSpread: ${(spread * 100).toFixed(3)}%\n\n⏳ Waiting ${CONFIRM_DELAY} candles, then watching for LIVE EMA20 touch\n🔍 Preparing to enter SHORT...\n🕐 ${now()}`,
      );
    }

    const delayPassed =
      state.crossConfirmedAt !== null &&
      signalIdx - state.crossConfirmedAt >= CONFIRM_DELAY;

    if (!state.position && state.waitingForTouch && delayPassed) {
      const spreadOk = spread >= MIN_SPREAD_PCT;
      const adxOk = adxVal !== null && adxVal >= ADX_MIN;
      const macdLongOk =
        state.waitingForTouch === "LONG" && macdHist !== null && macdHist > 0;
      const macdShortOk =
        state.waitingForTouch === "SHORT" && macdHist !== null && macdHist < 0;
      const macdOk = macdLongOk || macdShortOk;
      const allOk = spreadOk && adxOk && macdOk;

      if (state.lastEntryCheckCandleTime !== liveCandleTime) {
        state.lastEntryCheckCandleTime = liveCandleTime;
        console.log(
          `[ENTRY CHECK] ${symbol} dir=${state.waitingForTouch} ` +
            `signalTime=${new Date(times[signalIdx]).toISOString()} ` +
            `liveTime=${new Date(liveCandleTime).toISOString()} ` +
            `spread=${(spread * 100).toFixed(3)} ok=${spreadOk} ` +
            `adx=${adxVal?.toFixed(2)} ok=${adxOk} ` +
            `macdHist=${macdHist?.toFixed(4)} ok=${macdOk} ` +
            `touch=${liveTouchOk} liveLow=${lows[liveIdx]} liveHigh=${highs[liveIdx]} ema20Live=${liveE20}`,
        );
      }

      if (allOk && !state.filtersNotified) {
        state.filtersNotified = true;
        const dir = state.waitingForTouch;
        await sendTelegram(
          `✅ ALL FILTERS PASSED — READY TO ENTER — ${symbol}\n\n🎯 Direction: ${dir}\n✅ Spread: ${(spread * 100).toFixed(3)}% ≥ ${(MIN_SPREAD_PCT * 100).toFixed(2)}%\n✅ ADX: ${adxVal?.toFixed(1)} ≥ ${ADX_MIN}\n✅ MACD Hist: ${macdHist?.toFixed(3)} (${dir === "LONG" ? "bullish" : "bearish"})\n\n👀 Watching LIVE candle for touch of EMA20 at $${fmt(liveE20)}\n🛡 Initial SL: $${fmt(dir === "LONG" ? liveE20 * (1 - TRAILING_STOP_PCT) : liveE20 * (1 + TRAILING_STOP_PCT))}\n🎯 Partial TP: $${fmt(dir === "LONG" ? liveE20 * (1 + PARTIAL_TP_PCT) : liveE20 * (1 - PARTIAL_TP_PCT))}\n🕐 ${now()}`,
        );
      }

      if (allOk && liveTouchOk && state.lastTouchCandleTime !== liveCandleTime) {
        state.lastTouchCandleTime = liveCandleTime;
        const ep = liveE20;

        if (state.waitingForTouch === "LONG") {
          const sl = ep * (1 - TRAILING_STOP_PCT);
          const tp = ep * (1 + PARTIAL_TP_PCT);
          state.position = {
            type: "LONG",
            entryPrice: ep,
            entryTime: liveCandleTime,
            trailStop: sl,
            trailPeak: ep,
            partialTP: tp,
            partialDone: false,
          };
          state.waitingForTouch = null;
          state.crossConfirmedAt = null;
          state.filtersNotified = false;
          await sendTelegram(
            `📈 LONG ENTRY SIGNAL — ${symbol}\n\n💰 Entry: $${fmt(ep)}\n🛡 Stop Loss: $${fmt(sl)} (trailing −${(TRAILING_STOP_PCT * 100).toFixed(1)}%)\n🎯 Partial TP 50%: $${fmt(tp)} (+${(PARTIAL_TP_PCT * 100).toFixed(1)}%)\nEMA20(live): $${fmt(liveE20)} | EMA20(signal): $${fmt(e20)} | EMA50(signal): $${fmt(e50)}\nADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}\n🕐 ${now()}`,
          );
        } else {
          const sl = ep * (1 + TRAILING_STOP_PCT);
          const tp = ep * (1 - PARTIAL_TP_PCT);
          state.position = {
            type: "SHORT",
            entryPrice: ep,
            entryTime: liveCandleTime,
            trailStop: sl,
            trailPeak: ep,
            partialTP: tp,
            partialDone: false,
          };
          state.waitingForTouch = null;
          state.crossConfirmedAt = null;
          state.filtersNotified = false;
          await sendTelegram(
            `📉 SHORT ENTRY SIGNAL — ${symbol}\n\n💰 Entry: $${fmt(ep)}\n🛡 Stop Loss: $${fmt(sl)} (trailing +${(TRAILING_STOP_PCT * 100).toFixed(1)}%)\n🎯 Partial TP 50%: $${fmt(tp)} (−${(PARTIAL_TP_PCT * 100).toFixed(1)}%)\nEMA20(live): $${fmt(liveE20)} | EMA20(signal): $${fmt(e20)} | EMA50(signal): $${fmt(e50)}\nADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}\n🕐 ${now()}`,
          );
        }
      }
    }

    console.log(
      `[${new Date().toISOString()}] ${symbol} | ${INTERVAL} $${fmt(currentPrice)} EMA20:${e20?.toFixed(1)} EMA50:${e50?.toFixed(1)} ADX:${adxVal?.toFixed(1)} Pos:${state.position?.type || "none"}`,
    );
  } catch (err) {
    console.error(`[${symbol}] Scan error:`, err.message);
  }
}

async function sendPnlUpdate() {
  for (const symbol of SYMBOLS) {
    const state = states[symbol];
    if (!state.position) continue;

    try {
      const klines = await fetchKlines(symbol, 5);
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
        `${pnlEmoji(pnlPct)} POSITION UPDATE — ${symbol}\n\n📌 ${pos.type} | Entry: $${fmt(pos.entryPrice)}\n📊 Current: $${fmt(cp)} (${diff >= 0 ? "+" : ""}${fmt(diff)})\n💵 PnL: ${fmtPct(pnlPct)} (~$${pnlUsd.toFixed(2)})\n🛡 SL: $${fmt(pos.trailStop)} (${toStop.toFixed(2)}% away)\n${pos.partialDone ? "✂️ Partial TP already taken" : `🎯 Partial TP target: $${fmt(pos.partialTP)}`}\n🕐 ${now()}`,
      );
    } catch (err) {
      console.error(`[${symbol}] PnL update error:`, err.message);
    }
  }
}

async function scanAll() {
  await Promise.all(SYMBOLS.map((sym) => scan(sym)));
}

async function main() {
  console.log(`🚀 EMA Multi-Coin Scanner | ${SYMBOLS.join(", ")} | ${INTERVAL}`);
  console.log(
    `📡 Telegram: ${TELEGRAM_TOKEN ? "configured" : "DISABLED — set TELEGRAM_BOT_TOKEN in .env"}`,
  );

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `🚀 EMA Multi-Coin Scanner Started\n\n📊 ${SYMBOLS.join(" | ")} | ⏱ ${INTERVAL}\nSpread ≥${(MIN_SPREAD_PCT * 100).toFixed(1)}% | ADX ≥${ADX_MIN} | MACD | ${CONFIRM_DELAY}-candle delay\nTrailing SL: ${(TRAILING_STOP_PCT * 100).toFixed(1)}% | Partial TP: ${(PARTIAL_TP_PCT * 100).toFixed(1)}%\nMode: closed-candle cross/filter + LIVE candle EMA touch\n🕐 ${now()}`,
    );
  }

  await scanAll();
  cron.schedule("*/5 * * * *", () => scanAll());
  cron.schedule("*/15 * * * *", () => sendPnlUpdate());
  console.log("✅ Running — scan: every 5m | PnL heartbeat: every 15m");
}

main().catch(console.error);
