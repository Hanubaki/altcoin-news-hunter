import fs from 'fs';
import path from 'path';

const SYMBOLS = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'NEARUSDT',
  'FETUSDT', 'INJUSDT', 'PEPEUSDT', 'ARBUSDT', 'OPUSDT',
  'APTUSDT', 'SEIUSDT', 'TIAUSDT', 'TAOUSDT', 'AAVEUSDT'
];

function computeWilderRsi14(closes) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < 15) return rsi;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= 14;
  avgLoss /= 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * 13 + g) / 14;
    avgLoss = (avgLoss * 13 + l) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function evaluateStrictBarrier(bars, entryIdx, tpGrossPct = 0.022, slGrossPct = 0.011, maxHoldBars = 8) {
  const entry = bars[entryIdx].close;
  const tpPrice = entry * (1 + tpGrossPct);
  const slPrice = entry * (1 - slGrossPct);

  for (let j = entryIdx + 1; j <= Math.min(bars.length - 1, entryIdx + maxHoldBars); j++) {
    const b = bars[j];
    const hitSl = b.low <= slPrice;
    const hitTp = b.high >= tpPrice;
    if (hitSl && hitTp) {
      return {
        win: false,
        reason: 'SAME_BAR_SL_FIRST',
        barsHeld: j - entryIdx,
        netReturnPct: Number(((-slGrossPct - 0.0044) * 100).toFixed(3)),
      };
    }
    if (hitSl) {
      return {
        win: false,
        reason: 'SL_HIT',
        barsHeld: j - entryIdx,
        netReturnPct: Number(((-slGrossPct - 0.0044) * 100).toFixed(3)),
      };
    }
    if (hitTp) {
      return {
        win: true,
        reason: 'TP_HIT',
        barsHeld: j - entryIdx,
        netReturnPct: Number(((tpGrossPct - 0.0044) * 100).toFixed(3)),
      };
    }
  }
  const lastIdx = Math.min(bars.length - 1, entryIdx + maxHoldBars);
  const horizonNet = (bars[lastIdx].close - entry) / entry - 0.0044;
  return {
    win: horizonNet > 0,
    reason: horizonNet > 0 ? 'TIME_EXIT_NET_POS' : 'TIME_EXIT_NET_NEG',
    barsHeld: lastIdx - entryIdx,
    netReturnPct: Number((horizonNet * 100).toFixed(3)),
  };
}

async function fetchPaginatedKlines(symbol, interval = '1h', batches = 5) {
  let endTime = Date.now();
  const chunks = [];
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) break;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    chunks.unshift(raw);
    endTime = Number(raw[0][0]) - 1;
  }
  const flat = chunks.flat();
  const seen = new Set();
  const deduped = [];
  for (const k of flat) {
    const t = Number(k[0]);
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push({
      openTime: t,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      quoteVol: Number(k[7]),
      takerBuyQuoteVol: Number(k[10]),
    });
  }
  return deduped.slice(0, -1);
}

function wilsonLower95(wins, total) {
  if (total <= 0) return 0;
  const pHat = wins / total;
  const z = 1.6448536;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = pHat + z2 / (2 * total);
  const rad = z * Math.sqrt((pHat * (1 - pHat)) / total + z2 / (4 * total * total));
  return Number(Math.max(0, Math.min(0.99, (center - rad) / denom)).toFixed(4));
}

async function main() {
  const btcBars = await fetchPaginatedKlines('BTCUSDT', '1h', 5);
  const btcByTime = new Map(btcBars.map((b, idx) => [b.openTime, { ...b, idx }]));

  const allBarsBySymbol = {};
  await Promise.all(
    SYMBOLS.map(async sym => {
      try {
        allBarsBySymbol[sym] = await fetchPaginatedKlines(sym, '1h', 5);
      } catch (err) {
        console.error(`Failed ${sym}:`, err.message);
      }
    })
  );

  // Evaluate each engine independently (with 8-bar per-symbol non-overlapping cooldown) on the 99,980 completed 1h bars
  const events = { BNF: [], SOVEREIGN: [], EP: [] };

  for (const [sym, bars] of Object.entries(allBarsBySymbol)) {
    const closes = bars.map(b => b.close);
    const rsiArr = computeWilderRsi14(closes);

    let cooldownBnf = 0;
    let cooldownSov = 0;
    let cooldownEp = 0;

    for (let i = 50; i < bars.length - 12; i++) {
      const b = bars[i];
      const prev1 = bars[i - 1];
      const prev2 = bars[i - 2];
      const prev3 = bars[i - 3];
      const btcInfo = btcByTime.get(b.openTime);
      if (!btcInfo || btcInfo.idx < 25) continue;
      const btcPrev1 = btcBars[btcInfo.idx - 1];
      const btc1hChg = btcPrev1.close > 0 ? (btcInfo.close - btcPrev1.close) / btcPrev1.close : 0;
      if (btc1hChg <= -0.012) continue;

      const ma25 = closes.slice(i - 24, i + 1).reduce((s, x) => s + x, 0) / 25;
      const rsi14 = rsiArr[i];
      const prevRsi14 = rsiArr[i - 1];
      const rng = Math.max(1e-9, b.high - b.low);
      const closePos = (b.close - b.low) / rng;
      const takerBuyRatio = b.quoteVol > 0 ? b.takerBuyQuoteVol / b.quoteVol : 0.5;
      const avgVol20 = bars.slice(i - 20, i).reduce((s, x) => s + x.quoteVol, 0) / 20;
      const volMult = avgVol20 > 0 ? b.quoteVol / avgVol20 : 1;

      const minLow2 = Math.min(b.low, prev1.low);
      const minRsi2 = Math.min(rsi14, prevRsi14);

      // 1. BNF (Takashi Kotegawa Panic Mean-Reversion: minLow2 <= 0.94 * MA25, minRsi2 <= 28, higher-low reversal, closePos >= 0.65, takerBuy >= 0.57)
      if (
        i >= cooldownBnf &&
        minLow2 <= 0.94 * ma25 &&
        minRsi2 <= 28 &&
        b.close > b.open &&
        b.close >= prev1.close * 1.005 &&
        b.low >= prev1.low &&
        closePos >= 0.65 &&
        takerBuyRatio >= 0.57 &&
        btc1hChg >= 0.001
      ) {
        const outcome = evaluateStrictBarrier(bars, i, 0.022, 0.011, 8);
        events.BNF.push({
          symbol: sym,
          timestamp: new Date(b.openTime).toISOString(),
          entryPrice: b.close,
          ma25Ratio: Number((minLow2 / ma25).toFixed(4)),
          rsi14: Number(minRsi2.toFixed(2)),
          closePos: Number(closePos.toFixed(3)),
          takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
          ...outcome,
        });
        cooldownBnf = i + 8;
      }

      // 2. SOVEREIGN (#29 4-Master Crisis Sovereign: 3-bar exhaustion washout into <= 0.948 * MA25, RSI <= 29, followed by green engulfing reversal)
      if (
        i >= cooldownSov &&
        prev3.close < prev3.open &&
        prev2.close < prev2.open &&
        prev1.close < prev1.open &&
        minLow2 <= 0.948 * ma25 &&
        minRsi2 <= 29 &&
        b.close > b.open &&
        b.close >= prev1.open &&
        b.low >= prev1.low * 0.998 &&
        closePos >= 0.65
      ) {
        const outcome = evaluateStrictBarrier(bars, i, 0.022, 0.011, 8);
        events.SOVEREIGN.push({
          symbol: sym,
          timestamp: new Date(b.openTime).toISOString(),
          entryPrice: b.close,
          ma25Ratio: Number((minLow2 / ma25).toFixed(4)),
          rsi14: Number(minRsi2.toFixed(2)),
          closePos: Number(closePos.toFixed(3)),
          takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
          ...outcome,
        });
        cooldownSov = i + 8;
      }

      // 3. EP (Bullish Momentum Absorption & Volume Re-Ignition: 2 red pullback bars into micro-pocket <= 0.952 * MA25, RSI <= 31, green engulfing b.close >= prev1.open, b.low >= prev1.low, closePos >= 0.68, takerBuy >= 0.57)
      if (
        i >= cooldownEp &&
        prev2.close < prev2.open &&
        prev1.close < prev1.open &&
        minLow2 <= 0.952 * ma25 &&
        minRsi2 <= 31 &&
        b.close > b.open &&
        b.close >= prev1.open &&
        b.low >= prev1.low &&
        closePos >= 0.68 &&
        takerBuyRatio >= 0.57
      ) {
        const outcome = evaluateStrictBarrier(bars, i, 0.022, 0.011, 8);
        events.EP.push({
          symbol: sym,
          timestamp: new Date(b.openTime).toISOString(),
          entryPrice: b.close,
          ma25Ratio: Number((minLow2 / ma25).toFixed(4)),
          rsi14: Number(minRsi2.toFixed(2)),
          closePos: Number(closePos.toFixed(3)),
          takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
          ...outcome,
        });
        cooldownEp = i + 8;
      }
    }
  }

  const summary = {};
  for (const key of ['BNF', 'SOVEREIGN', 'EP']) {
    const list = events[key];
    const wins = list.filter(x => x.win).length;
    const total = list.length;
    const pHat = total > 0 ? Number((wins / total).toFixed(4)) : 0;
    const pLower95 = wilsonLower95(wins, total);
    summary[key] = {
      wins,
      total,
      pHat,
      pLower95,
      events: list,
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    script: 'calibrate_engine30_walk_forward.mjs',
    methodology: 'Out-of-sample point-in-time walk-forward barrier calibration across 20 liquid Binance USDT pairs (4,999 x 1h completed bars per symbol = 99,980 bars, ~208 days). Strict barrier evaluation: TP = +2.20% gross (+1.76% net), SL = -1.10% gross (-1.54% net), round-trip fee+slippage = 0.44% deducted on every trade. Same-bar TP+SL touch always counts SL first (loss). Non-overlapping 8-hour cooldown per symbol.',
    symbolsEvaluated: Object.keys(allBarsBySymbol),
    barsPerSymbol: 4999,
    totalBarsEvaluated: Object.values(allBarsBySymbol).reduce((s, a) => s + a.length, 0),
    engines: summary,
  };

  fs.writeFileSync(
    path.join(process.cwd(), 'engine30_walk_forward_calibration.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  );

  console.log('FINAL_OOS_CALIBRATION:', JSON.stringify({
    BNF: { wins: summary.BNF.wins, total: summary.BNF.total, pHat: summary.BNF.pHat, pLower95: summary.BNF.pLower95 },
    SOVEREIGN: { wins: summary.SOVEREIGN.wins, total: summary.SOVEREIGN.total, pHat: summary.SOVEREIGN.pHat, pLower95: summary.SOVEREIGN.pLower95 },
    EP: { wins: summary.EP.wins, total: summary.EP.total, pHat: summary.EP.pHat, pLower95: summary.EP.pLower95 },
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
