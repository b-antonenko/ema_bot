require("dotenv").config();
const axios = require("axios");
const cron = require("node-cron");
const { EMA, MACD, ADX } = require("technicalindicators");

// ── Shared config ──────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const MIN_SPREAD_PCT    = parseFloat(process.env.MIN_SPREAD_PCT)    || 0.005;
const CONFIRM_DELAY     = parseInt(process.env.CONFIRM_DELAY)       || 2;
const TRAILING_STOP_PCT = parseFloat(process.env.TRAILING_STOP_PCT) || 0.015;
const ADX_MIN           = parseFloat(process.env.ADX_MIN)           || 20;
const ADX_PERIOD        = parseInt(process.env.ADX_PERIOD)          || 14;
const PARTIAL_TP_PCT    = parseFloat(process.env.PARTIAL_TP_PCT)    || 0.015;
const POSITION_SIZE_USD = parseFloat(process.env.POSITION_SIZE_USD) || 1000;

// ── Symbols and timeframes to track ───────────────────────────────────────────
const SYMBOLS = ["BTCUSDT", "SOLUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "TRXUSDT", "DOGEUSDT", "ADAUSDT", "TONUSDT", "HYPEUSDT", "LTCUSDT", "LINKUSDT", "SUIUSDT", "SHIBUSDT", "DOTUSDT"];
const TIMEFRAMES = ["1h", "2h", "4h"];

// ── Per-coin per-timeframe isolated state ──────────────────────────────────────
// states[symbol][timeframe] — fully independent from every other combination
function makeState() {
  return {
    crossState:        null,
    waitingForTouch:   null,
    crossConfirmedAt:  null,
    lastCrossNotified: null,
    filtersNotified:   false,
    position:          null,
  };
}

const states = {};
for (const sym of SYMBOLS) {
  states[sym] = {};
  for (const tf of TIMEFRAMES) {
    states[sym][tf] = makeState();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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

async function fetchKlines(symbol, interval, limit = 200) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
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

// Label used in every Telegram message — e.g. "SOLUSDT | 4h"
function label(symbol, tf) {
  return `${symbol} | ${tf}`;
}

function calcIndicators(klines) {
  const closes = klines.map((k) => parseFloat(k[4]));
  const highs   = klines.map((k) => parseFloat(k[2]));
  const lows    = klines.map((k) => parseFloat(k[3]));
  const times   = klines.map((k) => k[0]);
  const len     = closes.length;
  const ema20   = padArray(EMA.calculate({ period: 20, values: closes }), len);
  const ema50   = padArray(EMA.calculate({ period: 50, values: closes }), len);
  const macdArr = padArray(
    MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
      values: closes,
    }),
    len,
  );
  const adxArr = padArray(
    ADX.calculate({ period: ADX_PERIOD, high: highs, low: lows, close: closes }),
    len,
  );
  return { closes, highs, lows, times, ema20, ema50, macdArr, adxArr, len };
}

// ── Per-symbol per-timeframe scan (fully isolated) ─────────────────────────────
async function scan(symbol, tf) {
  const state = states[symbol][tf];
  const lbl   = label(symbol, tf);
  try {
    const klines = await fetchKlines(symbol, tf, 200);
    const { closes, highs, lows, times, ema20, ema50, macdArr, adxArr, len } =
      calcIndicators(klines);

    const i       = len - 2; // last CLOSED candle
    const e20     = ema20[i], e50 = ema50[i];
    const e20prev = ema20[i - 1], e50prev = ema50[i - 1];
    if (!e20 || !e50 || !e20prev || !e50prev) return;

    const currentPrice = closes[len - 1];
    const goldenCross  = e20prev <= e50prev && e20 > e50;
    const deathCross   = e20prev >= e50prev && e20 < e50;
    const adxVal       = adxArr[i] ? adxArr[i].adx : null;
    const macdHist     = macdArr[i] ? macdArr[i].histogram : null;
    const spread       = Math.abs(e20 - e50) / e50;

    // ── Position management ──────────────────────────────────────────────────
    if (state.position) {
      const pos = state.position;

      if (pos.type === "LONG") {
        if (highs[i] > pos.trailPeak) {
          const old    = pos.trailStop;
          pos.trailPeak  = highs[i];
          pos.trailStop  = pos.trailPeak * (1 - TRAILING_STOP_PCT);
          if (pos.trailStop > old + 0.5)
            await sendTelegram(
              `🔄 STOP LOSS MOVED UP — ${lbl}\n\n📌 LONG | Entry: $${fmt(pos.entryPrice)}\n📈 New Peak: $${fmt(pos.trailPeak)}\n🛡 New SL: $${fmt(pos.trailStop)} | Old: $${fmt(old)}\n🕐 ${now()}`,
            );
        }
        if (!pos.partialDone && highs[i] >= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.partialTP - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ PARTIAL TP HIT — ${lbl}\n\n🎯 50% closed at $${fmt(pos.partialTP)}\n📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})\n🛡 SL still at $${fmt(pos.trailStop)}\n🕐 ${now()}`,
          );
        }
        if (lows[i] <= pos.trailStop) {
          const p = ((pos.trailStop - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — TRAILING STOP HIT — ${lbl}\n\n📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
          return;
        }
        if (deathCross) {
          const p = ((closes[i] - pos.entryPrice) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — DEATH CROSS — ${lbl}\n\n📌 LONG | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[i])}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
        }
      }

      if (pos.type === "SHORT") {
        if (lows[i] < pos.trailPeak) {
          const old    = pos.trailStop;
          pos.trailPeak  = lows[i];
          pos.trailStop  = pos.trailPeak * (1 + TRAILING_STOP_PCT);
          if (pos.trailStop < old - 0.5)
            await sendTelegram(
              `🔄 STOP LOSS MOVED DOWN — ${lbl}\n\n📌 SHORT | Entry: $${fmt(pos.entryPrice)}\n📉 New Trough: $${fmt(pos.trailPeak)}\n🛡 New SL: $${fmt(pos.trailStop)} | Old: $${fmt(old)}\n🕐 ${now()}`,
            );
        }
        if (!pos.partialDone && lows[i] <= pos.partialTP) {
          pos.partialDone = true;
          const pp = ((pos.entryPrice - pos.partialTP) / pos.entryPrice) * 100;
          await sendTelegram(
            `✂️ PARTIAL TP HIT — ${lbl}\n\n🎯 50% closed at $${fmt(pos.partialTP)}\n📊 ${fmtPct(pp)} (~$${(POSITION_SIZE_USD * 0.5 * (pp / 100)).toFixed(2)})\n🛡 SL still at $${fmt(pos.trailStop)}\n🕐 ${now()}`,
          );
        }
        if (highs[i] >= pos.trailStop) {
          const p = ((pos.entryPrice - pos.trailStop) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — TRAILING STOP HIT — ${lbl}\n\n📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(pos.trailStop)}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
          return;
        }
        if (goldenCross) {
          const p = ((pos.entryPrice - closes[i]) / pos.entryPrice) * 100;
          await sendTelegram(
            `🛑 CLOSED — GOLDEN CROSS — ${lbl}\n\n📌 SHORT | Entry $${fmt(pos.entryPrice)} → Exit $${fmt(closes[i])}\n📊 ${fmtPct(p)} (~$${(POSITION_SIZE_USD * (p / 100)).toFixed(2)})\n🕐 ${now()}`,
          );
          state.position = null;
        }
      }
    }

    // ── Detect new cross ───────────────────────────────────────────────────────
    if (goldenCross && state.lastCrossNotified !== "golden") {
      state.crossState        = "golden";
      state.waitingForTouch   = "LONG";
      state.crossConfirmedAt  = i;
      state.lastCrossNotified = "golden";
      state.filtersNotified   = false;
      await sendTelegram(
        `☀️ GOLDEN CROSS DETECTED — ${lbl}\n\nEMA20 crossed UP EMA50\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nSpread: ${(spread * 100).toFixed(3)}%\n\n⏳ Waiting ${CONFIRM_DELAY} candles, then watching for EMA20 touch\n🔍 Preparing to enter LONG...\n🕐 ${now()}`,
      );
    } else if (deathCross && state.lastCrossNotified !== "death") {
      state.crossState        = "death";
      state.waitingForTouch   = "SHORT";
      state.crossConfirmedAt  = i;
      state.lastCrossNotified = "death";
      state.filtersNotified   = false;
      await sendTelegram(
        `🌑 DEATH CROSS DETECTED — ${lbl}\n\nEMA20 crossed DOWN EMA50\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nSpread: ${(spread * 100).toFixed(3)}%\n\n⏳ Waiting ${CONFIRM_DELAY} candles, then watching for EMA20 touch\n🔍 Preparing to enter SHORT...\n🕐 ${now()}`,
      );
    }

    // ── Entry logic ────────────────────────────────────────────────────────────
    const delayPassed =
      state.crossConfirmedAt !== null &&
      i - state.crossConfirmedAt >= CONFIRM_DELAY;

    if (!state.position && state.waitingForTouch && delayPassed) {
      const spreadOk    = spread >= MIN_SPREAD_PCT;
      const adxOk       = adxVal !== null && adxVal >= ADX_MIN;
      const macdLongOk  = state.waitingForTouch === "LONG"  && macdHist !== null && macdHist > 0;
      const macdShortOk = state.waitingForTouch === "SHORT" && macdHist !== null && macdHist < 0;
      const macdOk      = macdLongOk || macdShortOk;
      const touchOk     = touchesEma(lows[i], highs[i], e20);
      const allOk       = spreadOk && adxOk && macdOk;

      if (allOk && !state.filtersNotified) {
        state.filtersNotified = true;
        const dir = state.waitingForTouch;
        await sendTelegram(
          `✅ ALL FILTERS PASSED — READY TO ENTER — ${lbl}\n\n🎯 Direction: ${dir}\n✅ Spread: ${(spread * 100).toFixed(3)}% ≥ ${(MIN_SPREAD_PCT * 100).toFixed(2)}%\n✅ ADX: ${adxVal?.toFixed(1)} ≥ ${ADX_MIN}\n✅ MACD Hist: ${macdHist?.toFixed(3)} (${dir === "LONG" ? "bullish" : "bearish"})\n\n👀 Watching for touch of EMA20 at $${fmt(e20)}\n🛡 Initial SL: $${fmt(dir === "LONG" ? e20 * (1 - TRAILING_STOP_PCT) : e20 * (1 + TRAILING_STOP_PCT))}\n🎯 Partial TP: $${fmt(dir === "LONG" ? e20 * (1 + PARTIAL_TP_PCT) : e20 * (1 - PARTIAL_TP_PCT))}\n🕐 ${now()}`,
        );
      }

      if (allOk && touchOk) {
        const ep = e20;
        if (state.waitingForTouch === "LONG") {
          const sl = ep * (1 - TRAILING_STOP_PCT),
                tp = ep * (1 + PARTIAL_TP_PCT);
          state.position = {
            type: "LONG", entryPrice: ep, entryTime: times[i],
            trailStop: sl, trailPeak: ep, partialTP: tp, partialDone: false,
          };
          state.waitingForTouch  = null;
          state.crossConfirmedAt = null;
          await sendTelegram(
            `📈 LONG ENTRY SIGNAL — ${lbl}\n\n💰 Entry: $${fmt(ep)}\n🛡 Stop Loss: $${fmt(sl)} (trailing −${(TRAILING_STOP_PCT * 100).toFixed(1)}%)\n🎯 Partial TP 50%: $${fmt(tp)} (+${(PARTIAL_TP_PCT * 100).toFixed(1)}%)\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}\n🕐 ${now()}`,
          );
        } else {
          const sl = ep * (1 + TRAILING_STOP_PCT),
                tp = ep * (1 - PARTIAL_TP_PCT);
          state.position = {
            type: "SHORT", entryPrice: ep, entryTime: times[i],
            trailStop: sl, trailPeak: ep, partialTP: tp, partialDone: false,
          };
          state.waitingForTouch  = null;
          state.crossConfirmedAt = null;
          await sendTelegram(
            `📉 SHORT ENTRY SIGNAL — ${lbl}\n\n💰 Entry: $${fmt(ep)}\n🛡 Stop Loss: $${fmt(sl)} (trailing +${(TRAILING_STOP_PCT * 100).toFixed(1)}%)\n🎯 Partial TP 50%: $${fmt(tp)} (−${(PARTIAL_TP_PCT * 100).toFixed(1)}%)\nEMA20: $${fmt(e20)} | EMA50: $${fmt(e50)}\nADX: ${adxVal?.toFixed(1)} | MACD Hist: ${macdHist?.toFixed(3)}\n🕐 ${now()}`,
          );
        }
      }
    }

    console.log(
      `[${new Date().toISOString()}] ${lbl} $${fmt(currentPrice)} EMA20:${e20?.toFixed(1)} EMA50:${e50?.toFixed(1)} ADX:${adxVal?.toFixed(1)} Pos:${state.position?.type || "none"}`,
    );
  } catch (err) {
    console.error(`[${lbl}] Scan error:`, err.message);
  }
}

// ── PnL heartbeat — all active symbol×timeframe combinations ──────────────────
async function sendPnlUpdate() {
  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const state = states[symbol][tf];
      if (!state.position) continue;
      const lbl = label(symbol, tf);
      try {
        const klines = await fetchKlines(symbol, tf, 5);
        const cp     = parseFloat(klines[klines.length - 1][4]);
        const pos    = state.position;
        const pnlPct =
          pos.type === "LONG"
            ? ((cp - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - cp) / pos.entryPrice) * 100;
        const pnlUsd = POSITION_SIZE_USD * (pnlPct / 100);
        const diff   = cp - pos.entryPrice;
        const toStop =
          pos.type === "LONG"
            ? ((cp - pos.trailStop) / cp) * 100
            : ((pos.trailStop - cp) / cp) * 100;
        await sendTelegram(
          `${pnlEmoji(pnlPct)} POSITION UPDATE — ${lbl}\n\n📌 ${pos.type} | Entry: $${fmt(pos.entryPrice)}\n📊 Current: $${fmt(cp)} (${diff >= 0 ? "+" : ""}${fmt(diff)})\n💵 PnL: ${fmtPct(pnlPct)} (~$${pnlUsd.toFixed(2)})\n🛡 SL: $${fmt(pos.trailStop)} (${toStop.toFixed(2)}% away)\n${pos.partialDone ? "✂️ Partial TP already taken" : `🎯 Partial TP target: $${fmt(pos.partialTP)}`}\n🕐 ${now()}`,
        );
      } catch (err) {
        console.error(`[${lbl}] PnL update error:`, err.message);
      }
    }
  }
}

// ── Run all symbol×timeframe combinations in parallel ─────────────────────────
async function scanAll() {
  const tasks = [];
  for (const sym of SYMBOLS)
    for (const tf of TIMEFRAMES)
      tasks.push(scan(sym, tf));
  await Promise.all(tasks);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const combos = SYMBOLS.length * TIMEFRAMES.length;
  console.log(
    `🚀 EMA Multi-Coin Scanner | ${SYMBOLS.join(", ")} | ${TIMEFRAMES.join(", ")} | ${combos} combinations`,
  );
  console.log(
    `📡 Telegram: ${TELEGRAM_TOKEN ? "configured" : "DISABLED — set TELEGRAM_BOT_TOKEN in .env"}`,
  );

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `🚀 EMA Multi-Coin Scanner Started\n\n📊 ${SYMBOLS.join(" | ")}\n⏱ Timeframes: ${TIMEFRAMES.join(" | ")} (${combos} combinations)\nSpread ≥${(MIN_SPREAD_PCT * 100).toFixed(1)}% | ADX ≥${ADX_MIN} | MACD | ${CONFIRM_DELAY}-candle delay\nTrailing SL: ${(TRAILING_STOP_PCT * 100).toFixed(1)}% | Partial TP: ${(PARTIAL_TP_PCT * 100).toFixed(1)}%\n🕐 ${now()}`,
    );
  }

  await scanAll();
  cron.schedule("*/5 * * * *", () => scanAll());
  cron.schedule("*/15 * * * *", () => sendPnlUpdate());
  console.log("✅ Running — scan: every 5m | PnL heartbeat: every 15m");
}

main().catch(console.error);
