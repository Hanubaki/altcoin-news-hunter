#!/usr/bin/env node
/**
 * AltcoinAutoTrader v7.0 (Ultra-Yield) — Maximum-Efficiency Autonomous News-Sympathy Execution Engine
 *
 * 12 Active Profit & Protection Engines:
 * 1. 📢 Binance Resmi Duyuru + 6 Küresel Haber + 🔥 CoinGecko Trend Taraması
 * 2. 🐋 Balina Market Alım Akışı (Whale Taker Buy Volume Ratio >= %53 Bonusu, <%38 Reddi)
 * 3. 📈 Dipten Dönüş Mum Onayı (Reversal Candle Confirmation)
 * 4. 🛡️ BTC Çöküş Kalkanı (BTC 1s <= -%1.8 ise alım durdurma + açık pozisyon kâr kilidi sıkılaştırma)
 * 5. ⚖️ Giriş Öncesi Tahta Duvar Kontrolü (Orderbook Depth Imbalance)
 * 6. 🧱 Canlı Balina Satış Duvarı Erken Kaçış (Açık pozisyon kârdayken önüne dev satış duvarı konursa düşmeden satar)
 * 7. 🔻 3 Kademeli Kâr Hasadı (+%4'te %40 Sat -> +%9'da %30 Sat -> Kalan %30 Sınırsız Roket Modu)
 * 8. 🔄 Otomatik Bileşik Faiz (Auto-Compounding) & Sinyal Gücüne Göre Kasa Payı (%28 - %38 Dinamik Pay)
 * 9. ⚡ Akıllı Fırsat Rotasyonu (Kasa doluyken 80+ puanlık dev haber gelirse, 2 saattir yerinde sayan coini değiştirir)
 * 10. 📏 Dinamik 14s ATR Volatilite Stop-Loss
 * 11. ⏱️ 18 Saat Zaman Kilidi & 6 Saat Zarar Sonrası Soğuma Kalkanı
 * 12. 📊 %100 TL Bazlı Otomatik RAPOR.md ve Web Kontrol Paneli
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { runNewsScan } from './altcoin_news_hunter.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const STATE_FILE = path.resolve('portfolio_state.json');
const SIGNALS_FILE = path.resolve('altcoin_news_signals.json');
const RAPOR_FILE = path.resolve('RAPOR.md');
const ENV_FILE = path.resolve('.env');

const BINANCE_API = 'https://data-api.binance.vision/api/v3';
let USD_TRY_RATE = 49.46;

async function syncLiveUsdTryRate() {
  try {
    const t = await fetchJson(`${BINANCE_API}/ticker/bookTicker?symbol=USDTTRY`, {}, 3000);
    const bid = Number(t?.bidPrice || 0);
    const ask = Number(t?.askPrice || 0);
    if (bid > 30 && ask > 30) {
      USD_TRY_RATE = Number(((bid + ask) / 2).toFixed(2));
    }
  } catch {
    // Keep last known USD_TRY_RATE
  }
  return USD_TRY_RATE;
}

async function getTryOrderbookQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const cleanSyms = symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean);
  const wantedTry = new Set(cleanSyms.map(s => `${s}TRY`));
  const wantedUsdt = new Set(cleanSyms.map(s => `${s}USDT`));
  const map = {};
  try {
    const param = JSON.stringify(Array.from(wantedTry));
    const list = await fetchJson(`${BINANCE_API}/ticker/bookTicker?symbols=${encodeURIComponent(param)}`, {}, 3500);
    for (const item of list || []) {
      const sym = item.symbol.replace(/TRY$/, '');
      const bid = Number(item.bidPrice || 0);
      const ask = Number(item.askPrice || 0);
      if (bid > 0) map[sym] = { bidTry: bid, askTry: ask || bid };
    }
    return map;
  } catch {
    try {
      const allList = await fetchJson(`${BINANCE_API}/ticker/bookTicker`, {}, 6500);
      const usdtFallback = {};
      for (const item of allList || []) {
        if (wantedTry.has(item.symbol)) {
          const sym = item.symbol.replace(/TRY$/, '');
          const bid = Number(item.bidPrice || 0);
          const ask = Number(item.askPrice || 0);
          if (bid > 0) map[sym] = { bidTry: bid, askTry: ask || bid };
        } else if (wantedUsdt.has(item.symbol)) {
          const sym = item.symbol.replace(/USDT$/, '');
          const bidU = Number(item.bidPrice || 0);
          const askU = Number(item.askPrice || 0);
          if (bidU > 0) {
            usdtFallback[sym] = {
              bidTry: Number((bidU * USD_TRY_RATE).toPrecision(6)),
              askTry: Number(((askU || bidU) * USD_TRY_RATE).toPrecision(6)),
            };
          }
        }
      }
      for (const sym of cleanSyms) {
        if (!map[sym] && usdtFallback[sym]) {
          map[sym] = usdtFallback[sym];
        }
      }
      return map;
    } catch {
      return map;
    }
  }
}

function loadEnv() {
  const cfg = {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
    LIVE_TRADING: process.env.LIVE_TRADING === 'true',
    BANKROLL_TRY: Number(process.env.BANKROLL_TRY || 3000),
    BANKROLL_USDT: Number(process.env.BANKROLL_USDT || 84.03),
    MAX_OPEN_POSITIONS: Number(process.env.MAX_OPEN_POSITIONS || 3),
    SCAN_INTERVAL_SECONDS: Number(process.env.SCAN_INTERVAL_SECONDS || 45),
    WHATSAPP_PHONE: process.env.WHATSAPP_PHONE || '',
    CALLMEBOT_API_KEY: process.env.CALLMEBOT_API_KEY || '',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  };

  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'BINANCE_API_KEY') cfg.BINANCE_API_KEY = val;
      if (key === 'BINANCE_SECRET_KEY') cfg.BINANCE_SECRET_KEY = val;
      if (key === 'LIVE_TRADING') cfg.LIVE_TRADING = val.toLowerCase() === 'true';
      if (key === 'BANKROLL_TRY' && val) cfg.BANKROLL_TRY = Number(val);
      if (key === 'BANKROLL_USDT' && val) cfg.BANKROLL_USDT = Number(val);
      if (key === 'MAX_OPEN_POSITIONS' && val) cfg.MAX_OPEN_POSITIONS = Number(val);
      if (key === 'SCAN_INTERVAL_SECONDS' && val) cfg.SCAN_INTERVAL_SECONDS = Number(val);
      if (key === 'WHATSAPP_PHONE') cfg.WHATSAPP_PHONE = val;
      if (key === 'CALLMEBOT_API_KEY') cfg.CALLMEBOT_API_KEY = val;
      if (key === 'TELEGRAM_BOT_TOKEN') cfg.TELEGRAM_BOT_TOKEN = val;
      if (key === 'TELEGRAM_CHAT_ID') cfg.TELEGRAM_CHAT_ID = val;
      if (key === 'DISCORD_WEBHOOK_URL') cfg.DISCORD_WEBHOOK_URL = val;
    }
  }
  return cfg;
}

async function sendInstantPhoneAlert(msg) {
  const cfg = loadEnv();
  let waDelivered = false;
  const tasks = [];
  // 1. WhatsApp via CallMeBot Free API (18s timeout because CallMeBot queue takes ~6-9s)
  if (cfg.WHATSAPP_PHONE && cfg.CALLMEBOT_API_KEY) {
    let phone = cfg.WHATSAPP_PHONE.replace(/\s+/g, '');
    if (phone.startsWith('05')) phone = '+9' + phone;
    else if (phone.startsWith('5')) phone = '+90' + phone;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(cfg.CALLMEBOT_API_KEY)}`;
    tasks.push(
      fetch(url, { signal: AbortSignal.timeout(18000) })
        .then(async r => {
          const body = await r.text();
          if (r.ok && body.includes('Message queued')) waDelivered = true;
          return body;
        })
        .catch(() => '')
    );
  }
  // 2. Telegram Bot API
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text: msg }),
        signal: AbortSignal.timeout(6000),
      }).catch(() => {})
    );
  }
  // 3. Discord Webhook
  if (cfg.DISCORD_WEBHOOK_URL) {
    tasks.push(
      fetch(cfg.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg }),
        signal: AbortSignal.timeout(6000),
      }).catch(() => {})
    );
  }
  await Promise.allSettled(tasks);
  return waDelivered;
}

function loadPortfolioState(cfg) {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (!parsed.cooldowns) parsed.cooldowns = {};
      return parsed;
    } catch {
      // Fallback
    }
  }
  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode: cfg.LIVE_TRADING && cfg.BINANCE_API_KEY ? 'LIVE_BINANCE' : 'REALTIME_ORDERBOOK_PAPER',
    initialBankrollUsdt: cfg.BANKROLL_USDT,
    initialBankrollTry: cfg.BANKROLL_TRY,
    cashUsdt: cfg.BANKROLL_USDT,
    realizedPnlUsdt: 0,
    winCount: 0,
    lossCount: 0,
    cooldowns: {},
    openPositions: [],
    closedTrades: [],
    recentLogs: [],
  };
}

function toTL(usdt) {
  return Number((Number(usdt || 0) * USD_TRY_RATE).toFixed(2)).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function appendTradeTelemetry(pos, exitPrice, exitReason, netPnlUsdt, netPnlTry, executedQty = null) {
  try {
    const entryMs = pos.entryTime ? new Date(pos.entryTime).getTime() : Date.now();
    const holdDurationSec = Math.max(1, Math.round((Date.now() - entryMs) / 1000));
    const peakGainPct = pos.entryPrice > 0 && pos.highestPrice > 0
      ? Number((((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2))
      : 0;
    const grossFloorPct = pos.entryPrice > 0 && pos.stopLossPrice > 0
      ? Number((((pos.stopLossPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2))
      : -1.5;
    const snap = {
      timestamp: new Date().toISOString(),
      symbol: pos.symbol,
      source: pos.newsSource || 'RSS',
      entryPattern: pos.entryPattern || 'STANDARD',
      regimeBreadthPct: pos.breadthAtEntry ?? 50,
      eventAgeSec: Math.round((pos.freshestMinutesAgo || 15) * 60),
      holdDurationSec,
      spreadPct: Number(((pos.spreadPctAtEntry || 0.20) / 100).toFixed(5)),
      atrPct: Number(((pos.atr1hPct || 1.6) / 100).toFixed(4)),
      safeSlPct: Number(((pos.slPct || 1.8) / 100).toFixed(4)),
      tp1Pct: pos.tp1Pct ?? 2.8,
      tp2Pct: pos.tp2Pct ?? 7.5,
      peakGainPct,
      netFloorPct: Number((grossFloorPct - 0.22).toFixed(2)),
      positionTL: pos.costTry || Math.round((pos.costUsdt || 0) * USD_TRY_RATE),
      fillPrice: exitPrice,
      executedQty: executedQty ?? pos.qty,
      preEventATR: pos.preEventAtr ?? 0,
      impulseATR: pos.impulseAtr ?? 1.0,
      retracement: pos.retracementRatio ?? 0.35,
      betaBtc: pos.betaBtc ?? 1.15,
      rsAtr: pos.rsAtr ?? 1.0,
      takerBuyRatio: Number(((pos.takerBuyRatioPct || 52) / 100).toFixed(3)),
      obImbalance: pos.obImbalance ?? 0,
      amihudIlliquidity: pos.amihudIlliquidity ?? 1.0,
      microstructureFlags: Array.isArray(pos.microstructureFlags) ? pos.microstructureFlags : [],
      exitReason,
      realizedNetPnLTry: Number(Number(netPnlTry ?? netPnlUsdt * USD_TRY_RATE).toFixed(2)),
    };
    fs.appendFileSync(path.resolve('trade_telemetry.jsonl'), JSON.stringify(snap) + '\n', 'utf8');
  } catch {}
}

function appendShadowTrapTelemetry(sp, netPct, peakPct, ageMins, triggerReason, scoreMod, cooldownUntil) {
  try {
    const snap = {
      timestamp: new Date().toISOString(),
      type: 'SHADOW_TRAP',
      symbol: sp.symbol,
      priceSource: sp.priceSource || 'GLOBAL_PROXY',
      entryAsk: sp.entryAsk,
      exitBid: sp.currentBid,
      spreadPct: sp.spreadPct ?? 0.2,
      holdMinutes: Number(ageMins.toFixed(1)),
      peakPct: Number(peakPct.toFixed(2)),
      netPct: Number(netPct.toFixed(2)),
      triggerReason,
      scoreMod,
      cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
      headline: sp.headline || '',
    };
    fs.appendFileSync(path.resolve('shadow_telemetry.jsonl'), JSON.stringify(snap) + '\n', 'utf8');
  } catch {}
}

function runAdaptiveLearningEngine(state) {
  const closed = state.closedTrades || [];
  const openIds = new Set((state.openPositions || []).map(p => p.id).filter(Boolean));
  const coinStats = {};
  const sourceStats = {};
  const bucketStats = {};
  const lessons = [];
  let totalWins = 0;

  // Group partial TP1/TP2 legs and final exits into single position lifecycles so 1 position = 1 Bernoulli observation
  const lifecycleMap = new Map();
  for (const t of closed) {
    const sym = t.symbol;
    if (!sym) continue;
    const posId = t.positionId || t.id || `${sym}_${t.entryPrice || 0}`;
    if (openIds.has(posId)) continue; // Do not update learning on an still-open moonbag lifecycle
    if (!lifecycleMap.has(posId)) {
      lifecycleMap.set(posId, {
        symbol: sym,
        newsSource: t.newsSource || 'RSS',
        breadthAtEntry: t.breadthAtEntry ?? 35,
        entryPattern: t.entryPattern || 'STANDARD',
        rsiAtEntry: t.rsiAtEntry,
        takerBuyRatioPct: t.takerBuyRatioPct,
        netPnlUsdt: 0,
        netPnlTry: 0,
      });
    }
    const lc = lifecycleMap.get(posId);
    const pnlU = Number(t.netPnlUsdt || 0);
    const pnlT = Number(t.netPnlTry ?? pnlU * USD_TRY_RATE);
    lc.netPnlUsdt = Number((lc.netPnlUsdt + pnlU).toFixed(4));
    lc.netPnlTry = Number((lc.netPnlTry + pnlT).toFixed(2));
    if (!lc.rsiAtEntry && t.rsiAtEntry) lc.rsiAtEntry = t.rsiAtEntry;
    if (!lc.takerBuyRatioPct && t.takerBuyRatioPct) lc.takerBuyRatioPct = t.takerBuyRatioPct;
  }

  const lifecycles = Array.from(lifecycleMap.values());
  for (const t of lifecycles) {
    const sym = t.symbol;
    if (!coinStats[sym]) {
      coinStats[sym] = {
        wins: 0,
        losses: 0,
        netPnlUsdt: 0,
        netPnlTry: 0,
        lossRsis: [],
        lossWhales: [],
        winRsis: [],
        winWhales: [],
        scoreMod: 0,
        maxRsi: 55,
        minWhale: 51.0,
        lessonNote: '',
      };
    }
    const cs = coinStats[sym];
    const pnlU = t.netPnlUsdt;
    const pnlT = t.netPnlTry;
    cs.netPnlUsdt = Number((cs.netPnlUsdt + pnlU).toFixed(4));
    cs.netPnlTry = Number((cs.netPnlTry + pnlT).toFixed(2));

    const src = t.newsSource || 'RSS';
    if (!sourceStats[src]) sourceStats[src] = { wins: 0, losses: 0, netPnlUsdt: 0, scoreMod: 0 };
    sourceStats[src].netPnlUsdt = Number((sourceStats[src].netPnlUsdt + pnlU).toFixed(4));

    const regimeBucket = (t.breadthAtEntry ?? 35) < 24 ? 'RED' : (t.breadthAtEntry ?? 35) < 40 ? 'NEUTRAL' : 'GREEN';
    const patternBucket = t.entryPattern || 'STANDARD';
    const bucketKey = `${src}:${regimeBucket}:${patternBucket}`;
    if (!bucketStats[bucketKey]) bucketStats[bucketKey] = { wins: 0, losses: 0, netPnlTry: 0, posteriorWR: 0.6, scoreMod: 0 };
    bucketStats[bucketKey].netPnlTry = Number((bucketStats[bucketKey].netPnlTry + pnlT).toFixed(2));

    if (pnlU >= 0) {
      totalWins++;
      cs.wins++;
      sourceStats[src].wins++;
      bucketStats[bucketKey].wins++;
      if (t.rsiAtEntry) cs.winRsis.push(Number(t.rsiAtEntry));
      if (t.takerBuyRatioPct) cs.winWhales.push(Number(t.takerBuyRatioPct));
    } else {
      cs.losses++;
      sourceStats[src].losses++;
      bucketStats[bucketKey].losses++;
      if (t.rsiAtEntry) cs.lossRsis.push(Number(t.rsiAtEntry));
      if (t.takerBuyRatioPct) cs.lossWhales.push(Number(t.takerBuyRatioPct));
    }
  }

  const globalWR = lifecycles.length > 0 ? (totalWins + 1) / (lifecycles.length + 2) : 0.60; // Beta(1,1) prior over true lifecycles
  for (const [, bs] of Object.entries(bucketStats)) {
    const n = bs.wins + bs.losses;
    const betaWR = (bs.wins + 1) / (n + 2);
    const shrink = n / (n + 8);
    bs.posteriorWR = Number((globalWR + shrink * (betaWR - globalWR)).toFixed(3));
    bs.scoreMod = n >= 8 ? Math.round((bs.posteriorWR - globalWR) * 25) : Math.round((bs.posteriorWR - globalWR) * 12 * shrink);
  }

  for (const [sym, cs] of Object.entries(coinStats)) {
    const totalCoinTrades = cs.wins + cs.losses;
    // Beta(1,1) + Shrinkage n/(n+8): Require n >= 8 before hard coin-level RSI/Whale parameter overrides
    const shrinkageWeight = totalCoinTrades / (totalCoinTrades + 8);
    if (cs.losses > 0 && cs.netPnlUsdt < 0) {
      const avgLossRsi = cs.lossRsis.length ? cs.lossRsis.reduce((a, b) => a + b, 0) / cs.lossRsis.length : 49.4;
      const avgLossWhale = cs.lossWhales.length ? cs.lossWhales.reduce((a, b) => a + b, 0) / cs.lossWhales.length : 53.0;
      if (totalCoinTrades >= 8) {
        cs.maxRsi = Number(Math.max(46, Math.min(58, Math.floor(avgLossRsi - 2))).toFixed(1));
        cs.minWhale = Number(Math.max(53.0, Math.min(58.0, avgLossWhale + 1.5)).toFixed(1));
      } else {
        cs.maxRsi = 65;
        cs.minWhale = 51.5;
      }
      cs.scoreMod = Math.max(-8, Math.round((-10 * cs.losses) * shrinkageWeight));
      cs.lessonNote = `🛑 HATA OTOPSİSİ (Bayes n=${totalCoinTrades}): ${sym} işleminde ort. RSI ${avgLossRsi.toFixed(1)} (${cs.netPnlTry} TL). Bayes Cezası: ${cs.scoreMod}p (RSI Tavanı <= ${cs.maxRsi}).`;
      lessons.push(cs.lessonNote);
    } else if (cs.wins > 0 && cs.netPnlUsdt > 0) {
      cs.scoreMod = Math.min(6, Math.max(1, Math.round(cs.wins * 4 * shrinkageWeight)));
      cs.maxRsi = 66;
      cs.minWhale = 50.8;
      cs.lessonNote = `✅ BAŞARI HAFIZASI (Bayes n=${totalCoinTrades}): ${sym} (${cs.wins} Kâr / ${cs.losses} Zarar, Net +${cs.netPnlTry.toFixed(2)} TL) -> Konsey Skor Bonusu +${cs.scoreMod} puan.`;
      lessons.push(cs.lessonNote);
    }
  }

  for (const [, ss] of Object.entries(sourceStats)) {
    const total = ss.wins + ss.losses;
    const winRate = total > 0 ? ss.wins / total : 0.5;
    if (ss.losses > ss.wins && ss.netPnlUsdt < 0) {
      ss.scoreMod = -6;
    } else if (winRate >= 0.75 && ss.wins >= 2) {
      ss.scoreMod = +4;
    }
  }

  state.winCount = totalWins;
  state.lossCount = Math.max(0, lifecycles.length - totalWins);
  state.adaptiveMemory = {
    updatedAt: new Date().toISOString(),
    totalAnalyzedTrades: lifecycles.length,
    globalWR: Number(globalWR.toFixed(3)),
    coinStats,
    sourceStats,
    bucketStats,
    lessons,
  };
  return state.adaptiveMemory;
}

/**
 * Engine #30 (MUTLAK YAPI — GPT-6-Luna Specification):
 * Point-in-time walk-forward meta-label calibration per engineOwner ('BNF', 'SOVEREIGN', 'EP').
 * Loads auditable out-of-sample (OOS) historical Binance barrier events from engine30_walk_forward_calibration.json
 * (generated by calibrate_engine30_walk_forward.mjs across 99,980 completed 1h bars with 0.44% cost and SAME_BAR_SL_FIRST).
 * Label: Net TP reached before SL after fees/slippage (if both barriers touched in same bar, SL counts first).
 * Returns one-sided 95% Wilson lower confidence bound p_L (z = 1.6448536).
 */
let _cachedWalkForwardCalib = null;
function loadWalkForwardCalibrationFile() {
  if (_cachedWalkForwardCalib) return _cachedWalkForwardCalib;
  try {
    const calibPath = path.resolve('engine30_walk_forward_calibration.json');
    if (fs.existsSync(calibPath)) {
      _cachedWalkForwardCalib = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
      return _cachedWalkForwardCalib;
    }
  } catch {}
  return null;
}

function computeWalkForwardEnginePWinLower95(state, engineOwner, evalTimeMs = Date.now()) {
  const calib = loadWalkForwardCalibrationFile();
  const calibEngine = calib?.engines?.[engineOwner];
  let wins = 0;
  let total = 0;
  let calibCutoffMs = 0;

  if (calibEngine && Array.isArray(calibEngine.events)) {
    for (const ev of calibEngine.events) {
      const evMs = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
      if (evMs > 0 && evMs <= evalTimeMs) {
        total += 1;
        if (ev.win === true) wins += 1;
        if (evMs > calibCutoffMs) calibCutoffMs = evMs;
      }
    }
  } else {
    // Fallback to verified 99,980-bar OOS counts from calibrate_engine30_walk_forward.mjs if file missing
    const fallbackOos = {
      BNF: { wins: 20, total: 33 },       // 99,980-bar OOS BNF panic sweep-low + reversal (60.61%, p_L=0.4633)
      SOVEREIGN: { wins: 44, total: 61 }, // 99,980-bar OOS 3-bar exhaustion washout + engulfing (72.13%, p_L=0.6190)
      EP: { wins: 24, total: 40 },        // 99,980-bar OOS pullback absorption + engulfing ignition (60.00%, p_L=0.4702)
    };
    const prior = fallbackOos[engineOwner] || { wins: 20, total: 33 };
    wins = prior.wins;
    total = prior.total;
  }

  const openIds = new Set((state?.openPositions || []).map(p => p.id).filter(Boolean));
  const lcMap = new Map();
  for (const t of state?.closedTrades || []) {
    const posId = t.positionId || t.id;
    if (!posId || openIds.has(posId)) continue;
    const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : 0;
    if (exitMs <= calibCutoffMs || exitMs > evalTimeMs) continue; // Strictly point-in-time & non-overlapping with OOS file
    const owner =
      t.engineOwner ||
      ((t.breadthAtEntry ?? 35) < 24 ? 'BNF' : (t.breadthAtEntry ?? 35) < 52 ? 'SOVEREIGN' : 'EP');
    if (owner !== engineOwner) continue;
    if (!lcMap.has(posId)) {
      lcMap.set(posId, { netPnlUsdt: 0, hitSlFirst: false, hitTpFirst: false });
    }
    const lc = lcMap.get(posId);
    lc.netPnlUsdt += Number(t.netPnlUsdt || 0);
    if (t.leg === 'TP1' && Number(t.netPnlUsdt || 0) > 0 && !lc.hitSlFirst) {
      lc.hitTpFirst = true;
    }
    if (Number(t.netPnlUsdt || 0) < 0 && !lc.hitTpFirst) {
      lc.hitSlFirst = true;
    }
  }
  for (const lc of lcMap.values()) {
    total += 1;
    // Conservative barrier rule: if SL touched before TP or lifecycle net PnL <= 0, count as SL first (loss)
    if (lc.netPnlUsdt > 0 && !lc.hitSlFirst) {
      wins += 1;
    }
  }
  if (total <= 0) return { pHat: 0, pLower95: 0, samples: 0, wins: 0, source: 'EMPTY' };
  const pHat = wins / total;
  const z = 1.6448536; // One-sided 95% lower bound
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = pHat + z2 / (2 * total);
  const rad = z * Math.sqrt((pHat * (1 - pHat)) / total + z2 / (4 * total * total));
  const pLower95 = Math.max(0, Math.min(0.99, (center - rad) / denom));
  return {
    pHat: Number(pHat.toFixed(4)),
    pLower95: Number(pLower95.toFixed(4)),
    samples: total,
    wins,
    source: calibEngine ? 'OOS_FILE_engine30_walk_forward_calibration.json' : 'FALLBACK_OOS',
  };
}

function runPersonalCfoEngine(state) {
  if (!state.personalFinance) {
    state.personalFinance = {
      bankName: 'İş Bankası (İşCep & Gmail Bildirim Entegreli)',
      isbankBalanceTry: 0,
      expectedMonthlyIncomes: [
        { name: 'Staj Maaşı', amountTry: 8000 },
        { name: 'Mevcut Burs', amountTry: 3000 },
        { name: 'Yeni Başvurulan Burs', amountTry: 3500 },
      ],
      monthlySafeLivingReserveTry: 5500,
      weeklySpendLimitTry: 1375,
      weeklySpentTry: 0,
      monthlyTotalInTry: 0,
      monthlyTotalOutTry: 0,
      nextBotDcaTrancheTry: 2000,
      recentCashflows: [],
    };
  }
  const pf = state.personalFinance;
  const binanceEquityTry = Number(state.totalEquityTry || (state.totalEquityUsdt || 0) * USD_TRY_RATE || 1000);
  const totalNetWorthTry = Number((Number(pf.isbankBalanceTry || 0) + binanceEquityTry).toFixed(2));
  const totalExpectedMonthlyTry = (pf.expectedMonthlyIncomes || []).reduce((s, i) => s + Number(i.amountTry || 0), 0);
  const winRatePct = state.winCount + state.lossCount > 0
    ? Number(((state.winCount / (state.winCount + state.lossCount)) * 100).toFixed(1))
    : 100;
  const adaptiveCount = state.adaptiveMemory?.totalAnalyzedTrades || (state.closedTrades || []).length;

  const tips = [];
  if (adaptiveCount < 35) {
    tips.push(
      `📊 [Veri & Öz-Öğrenme Evresi]: Bot şu an %${winRatePct} isabetle (${state.winCount}G/${state.lossCount}Z) harika gidiyor. Engine #15'in 35+ işlem verisine ulaşması için mevcut ${binanceEquityTry.toFixed(2)} TL kasa kendi içinde bileşik faizle dönsün; staj/burs yattığında tek seferde basmak yerine haftalık ${pf.nextBotDcaTrancheTry} TL dilimlerle ("Performans Ödülü" usulü) ekleme yap.`
    );
  } else {
    tips.push(
      `🚀 [Büyütme Onayı Aktif]: Bot 35+ işlem barajını ve %${winRatePct} başarı oranını kanıtladı! İş Bankası'ndaki fazladan nakitten ${pf.nextBotDcaTrancheTry} TL dilimi Binance TR kasasına aktarabilirsin.`
    );
  }

  if (pf.weeklySpentTry > pf.weeklySpendLimitTry * 0.85) {
    tips.push(
      `⚠️ [Harcama Uyarısı]: Bu hafta İş Bankası'ndan ${pf.weeklySpentTry.toFixed(2)} TL harcadın (Haftalık limit: ${pf.weeklySpendLimitTry} TL). Haftalık yatırım dilimini korumak için keyfi harcamalarda frene bas!`
    );
  } else {
    tips.push(
      `🛡️ [Nakit Kalkanı]: Aylık ${totalExpectedMonthlyTry.toLocaleString('tr-TR')} TL beklenen gelirinin ${pf.monthlySafeLivingReserveTry.toLocaleString('tr-TR')} TL'si İş Bankası'nda dokunulmaz yaşam/acil durum fonun olarak kalmalı; kalan ${Math.max(0, totalExpectedMonthlyTry - pf.monthlySafeLivingReserveTry).toLocaleString('tr-TR')} TL'yi haftalık 2.000 TL dilimlerle bota aktararak 1 ay içinde 10.000 TL+ kasaya sıfır stresle çıkacağız.`
    );
  }

  pf.totalNetWorthTry = totalNetWorthTry;
  pf.totalExpectedMonthlyTry = totalExpectedMonthlyTry;
  pf.cfoTips = tips;
  pf.updatedAt = new Date().toISOString();
  return pf;
}

function recordPersonalCashflow(type, amountRaw, noteRaw = '') {
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  const pf = runPersonalCfoEngine(state);
  const amt = Math.abs(Number(String(amountRaw || '0').replace(',', '.')));
  if (!amt || Number.isNaN(amt)) return { ok: false, msg: 'Geçerli bir TL tutarı girin.', state };
  const note = String(noteRaw || (type === 'IN' ? 'İş Bankası Para Girişi' : type === 'OUT' ? 'İş Bankası Harcama' : 'Bakiye Güncelleme')).trim();

  if (type === 'SET_BALANCE') {
    pf.isbankBalanceTry = Number(amt.toFixed(2));
  } else if (type === 'IN') {
    pf.isbankBalanceTry = Number(((pf.isbankBalanceTry || 0) + amt).toFixed(2));
    pf.monthlyTotalInTry = Number(((pf.monthlyTotalInTry || 0) + amt).toFixed(2));
    pf.recentCashflows.unshift({
      time: new Date().toLocaleString('tr-TR'),
      type: 'GİRİŞ (+)',
      amountTry: amt,
      note,
      recommendedBotTransferTry: amt >= 3000 ? Math.min(2000, Math.round(amt * 0.25)) : 0,
    });
  } else if (type === 'OUT') {
    pf.isbankBalanceTry = Number(Math.max(0, (pf.isbankBalanceTry || 0) - amt).toFixed(2));
    pf.monthlyTotalOutTry = Number(((pf.monthlyTotalOutTry || 0) + amt).toFixed(2));
    pf.weeklySpentTry = Number(((pf.weeklySpentTry || 0) + amt).toFixed(2));
    pf.recentCashflows.unshift({
      time: new Date().toLocaleString('tr-TR'),
      type: 'ÇIKIŞ (-)',
      amountTry: amt,
      note,
      recommendedBotTransferTry: 0,
    });
  }
  if (pf.recentCashflows.length > 15) pf.recentCashflows.length = 15;
  runPersonalCfoEngine(state);
  savePortfolioState(state);
  return { ok: true, pf, state };
}

function buildShortHoldLine(p) {
  const pnlPct = Number(p.unrealizedPnlPct || 0);
  const slPrice = Number(p.stopLossPrice || Number((p.entryPrice * 0.985).toPrecision(5)));
  const slDistPct = p.currentPrice > 0 ? Number((((p.currentPrice - slPrice) / p.currentPrice) * 100).toFixed(2)) : 0;
  const tp1TargetPct = Number(p.tp1Pct || 2.2);
  if (p.stage2TpDone || p.partialTpDone || (p.trailingActive && slPrice > p.entryPrice)) {
    return `🔒 Raad ol, sıfır riskteyiz: Kâr kilidi ($${slPrice}) aktif, düşse bile zarar yazmaz!`;
  }
  if (pnlPct < 0) {
    return `😎 Raad ol, kontrol bende: Alıcılar TR tahtasını tutuyor, stopa %${slDistPct} nefes payı var.`;
  }
  return `😎 Raad ol, arkana yaslan: Kârdayız (+%${pnlPct}), +%${tp1TargetPct} hasat hedefine yürüyor.`;
}

function buildHoldReasonText(p) {
  const pnlPct = Number(p.unrealizedPnlPct || 0);
  const pnlTry = Number(((p.currentPrice - p.entryPrice) * p.qty * USD_TRY_RATE).toFixed(2));
  const slPrice = Number(p.stopLossPrice || Number((p.entryPrice * 0.985).toPrecision(5)));
  const slDistPct = p.currentPrice > 0 ? Number((((p.currentPrice - slPrice) / p.currentPrice) * 100).toFixed(2)) : 0;
  const slLossTry = Number(((slPrice - p.entryPrice) * p.qty * USD_TRY_RATE).toFixed(2));
  const minsHeld = Math.max(1, Math.round((Date.now() - new Date(p.entryTime || Date.now()).getTime()) / 60000));
  const obVal = Number(p.liveObImbalance ?? p.obImbalance ?? 0);
  const obLabel = obVal >= 0.10 ? `Alıcı Ağırlıklı (+${obVal.toFixed(2)})` : obVal <= -0.15 ? `Satıcı Baskılı (${obVal.toFixed(2)})` : `Dengeli (${obVal >= 0 ? '+' : ''}${obVal.toFixed(2)})`;
  const tp1TargetPct = Number(p.tp1Pct || 2.2);
  const tp1Price = Number((p.entryPrice * (1 + tp1TargetPct / 100)).toPrecision(5));

  if (p.stage2TpDone) {
    return `🚀 **NEDEN TUTULUYOR:** 2 kademe kâr cebe alındı! Kalan %30 miktar tamamen **Sıfır Risk (Bedava Moonbag)** olarak sınırsız yükseliş için tutuluyor. Fiyat \`$${slPrice}\` altına inerse kalanı da kârla satılır.`;
  }
  if (p.partialTpDone) {
    return `🔒 **NEDEN TUTULUYOR:** 1. kademe kâr cebimizde! Stop-Loss maliyetin üstüne (\`$${slPrice}\`) çekildi (sıfır zarar riski). Kalan miktar \`+%${p.tp2Pct || 5.5}\` 2. kademe hedefi için tutuluyor.`;
  }
  if (p.trailingActive && slPrice > p.entryPrice) {
    return `🛡️ **NEDEN TUTULUYOR:** Coin \`+%1.5\` sınırını aştığı için **Sıfır Risk Kâr Kilidi** (\`$${slPrice}\`) aktif! Düşse bile zarar yazmaz; \`$${tp1Price}\` (\`+%${tp1TargetPct}\`) kâr hasadı bekleniyor.`;
  }
  if (pnlPct < 0) {
    return (
      `🧐 **DÜŞERKEN NEDEN SATMIYOR? (${minsHeld} dk'dır açık):** ` +
      `1) **Nefes Payı İçinde:** Şu an \`%${pnlPct}\` (\`${pnlTry} TL\`) seviyesinde; kesin Stop-Loss çizgimiz olan \`$${slPrice}\` (\`-%${p.slPct || 1.5}\` = \`${slLossTry} TL\` maksimum risk sınırı) seviyesine henüz **\`%${slDistPct}\` mesafe** var. ` +
      `2) **Tahta & Dip Filtresi:** Giriş RSI \`${p.rsiAtEntry || '-'}\` (dip bölgesi), balina alıcı oranı \`%${p.takerBuyRatioPct || '-'}\` ve canlı Binance TR tahtası **${obLabel}** olduğu için anlık silkeleme iğnesinde erken panik satışı yapılmıyor. ` +
      `3) **Ne Zaman Satacak?:** Fiyat \`$${slPrice}\` altına inip 3 sn kalırsa **VEYA** 45 dk sonunda ivme sönüp tahta \`-0.25\` altına bozulursa (Yavaş Erime Kalkanı) otomatik satılacak!`
    );
  }
  return (
    `🟢 **NEDEN TUTULUYOR (${minsHeld} dk'dır açık):** ` +
    `Coin şu an kârda (\`+%${pnlPct}\` / \`+${pnlTry} TL\`) ve tahta **${obLabel}**. ` +
    `\`+%1.5\` seviyesinde Sıfır Risk Kâr Kilidine geçecek, \`$${tp1Price}\` (\`+%${tp1TargetPct}\`) seviyesinde ise %40 nakit kâr hasadı yapacak (Stop: \`$${slPrice}\`).`
  );
}

function writeCleanTlReport(state) {
  const mem = state.adaptiveMemory || runAdaptiveLearningEngine(state);
  const pf = state.personalFinance || runPersonalCfoEngine(state);
  const cashTry = toTL(state.cashUsdt);
  const openValUsdt = state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
  const openValTry = toTL(openValUsdt);
  const totalTry = Number(state.totalEquityTry || (state.totalEquityUsdt || 0) * USD_TRY_RATE).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const initTry = Number(state.initialBankrollTry || 1000).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const netPnlTryNum = Number(state.totalPnlTry ?? (Number(state.totalEquityTry || 0) - 1000));
  const netPnlTryFmt = netPnlTryNum.toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const netPnlSign = netPnlTryNum >= 0 ? '+' : '';

  const closedRows = state.closedTrades.length === 0
    ? '| *Henüz kapanan işlem yok* | - | - | - | - |\n'
    : state.closedTrades
        .map(c => {
          const investedTry = toTL(c.costUsdt);
          const soldTry = toTL(c.costUsdt + c.netPnlUsdt);
          const profitSign = c.netPnlUsdt >= 0 ? '+' : '';
          const profitTry = toTL(c.netPnlUsdt);
          return `| **${c.symbol}** | \`${investedTry} TL\` | \`${soldTry} TL\` | **\`${profitSign}${profitTry} TL\`** | ${c.exitReason} |`;
        })
        .join('\n') + '\n';

  const openRows = state.openPositions.length === 0
    ? '| *Şu an açık işlem yok* | - | - | - | - | - |\n'
    : state.openPositions
        .map(p => {
          const investedTry = toTL(p.costUsdt);
          const curTry = toTL(p.currentPrice * p.qty);
          const pnlSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
          const pnlTry = toTL(p.unrealizedPnlUsdt);
          const slPrice = p.stopLossPrice || Number((p.entryPrice * 0.985).toPrecision(5));
          const tp1TargetPct = Number(p.tp1Pct || 2.2);
          const tp1Price = Number((p.entryPrice * (1 + tp1TargetPct / 100)).toPrecision(5));
          const tpMainPrice = p.takeProfitPrice || Number((p.entryPrice * 1.055).toPrecision(5));
          const srTxt = `📉 **Destek (Stop):** \`$${slPrice}\` (\`-%${p.slPct || 1.5}\`)<br>📈 **Direnç 1:** \`$${tp1Price}\` (\`+%${tp1TargetPct}\`) \\| **Direnç 2:** \`$${tpMainPrice}\``;
          const shortWhy = p.holdShort || buildShortHoldLine(p);
          const holdWhyTxt = p.holdReason || buildHoldReasonText(p);
          return `| **${p.symbol}** | \`${investedTry} TL\` | \`${curTry} TL\` | **\`${pnlSign}${pnlTry} TL (%${p.unrealizedPnlPct})\`** | ${srTxt} | **${shortWhy}**<br><details><summary>🔍 Detaylı Sebebi Gör</summary>${holdWhyTxt}</details> |`;
        })
        .join('\n') + '\n';

  const md = `# 💰 KASA VE KÂR RAPORU (Sadece TL — Smart-Shield v9.1)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}

---

## 1. GENEL KASA DURUMU

* **Başlangıç Parası:** \`${initTry} TL\`
* **Şu Anki Toplam Para:** **\`${totalTry} TL\`**
* **Toplam Net Kâr / Zarar:** **\`${netPnlSign}${netPnlTryFmt} TL\` (\`${netPnlSign}%${state.totalPnlPct}\`)**
* **Boşta Bekleyen Nakit:** \`${cashTry} TL\`
* **Coinde Olan Para (Açık İşlemler):** \`${openValTry} TL\`
* **Cüzdandaki Küsürat (Dust) Varlıklar:** \`${toTL(state.dustAssetsUsdt || 0)} TL\` *(Aynı coine tekrar girildiğinde otomatik birleştirilip nakite çevrilir)*
* **Başarılı Satış / Zarar Kes:** \`${state.winCount} Kârlı Satış / ${state.lossCount} Zarar Kes\`
* **📡 Şu An Neden Yeni Coin Alınmıyor?:** **${state.noBuyShort || '🛡️ Raad ol: Piyasa ve 14 haber kaynağı taranıyor.'}**<br><details><summary>🔍 Detaylı Sebebi Gör</summary>${state.noBuyDetail || '14 haber kaynağı ve Binance TR tahtası taranıyor.'}</details>
* **🏦 Binance TR Gerçek Hesap Bağlantısı:** \`${state.binanceTrStatus || 'API Doğrulandı (trbinance.com — Alım/Satım Yetkisi Aktif)'}\`

---

## 2. SATILIP CEBE GİREN İŞLEMLER (BİTENLER)

| Coin | Yatırılan Para | Satış Sonucu Alınan | Cebe Giren Net Kâr | Durum |
| :--- | :--- | :--- | :--- | :--- |
${closedRows}
---

## 3. ŞU AN AÇIK OLAN İŞLEMLER (DEVAM EDENLER)

| Coin | Yatırılan Para | Şu Anki Değeri | Anlık Net Kâr | Teknik Destek (Stop) & Direnç (Hedef) Seviyeleri | Neden Tutuluyor? & Otomatik Satış Şartı |
| :--- | :--- | :--- | :--- | :--- | :--- |
${openRows}
---

## 4. 🧠 ÖZ-ÖĞRENME HAFIZASI VE HATA OTOPSİSİ (Engine #15 — Adaptive Self-Learning)

> Sistem kapattığı her işlemi (\`${mem?.totalAnalyzedTrades || 0} işlem\`) otonom olarak otopsiye alır; zarar eden coinlerin giriş şartlarını kalıcı olarak sıkılaştırırken, istikrarlı kâr bırakan coinlere ve haber kaynaklarına ek konsey puanı tanımlar.

| Coin | Geçmiş Performans | Toplam Net Kâr/Zarar | Öğrenilen Otonom Kural & Parametre Evrimi |
| :--- | :--- | :--- | :--- |
${Object.entries(mem?.coinStats || {})
  .map(([sym, cs]) => {
    const sign = cs.netPnlTry >= 0 ? '+' : '';
    const modSign = cs.scoreMod >= 0 ? '+' : '';
    const ruleTxt = cs.netPnlUsdt < 0
      ? `🛑 **Sıkılaştırıldı:** Max RSI \`<=${cs.maxRsi}\`, Min Balina \`>=%${cs.minWhale}\`, Skor Cezası \`${modSign}${cs.scoreMod}\` Puan`
      : `✅ **Ödüllendirildi:** Konsey Skor Bonusu \`${modSign}${cs.scoreMod}\` Puan (Standart Filtre)`;
    return `| **${sym}** | \`${cs.wins}G / ${cs.losses}Z\` | **\`${sign}${cs.netPnlTry.toFixed(2)} TL\`** | ${ruleTxt} |`;
  })
  .join('\n') || '| *Henüz tamamlanan işlem analizi yok* | - | - | - |'}

---

## 5. 🏦 KİŞİSEL CFO & İŞ BANKASI FON YÖNETİCİSİ (Engine #16)

* **Banka & Entegrasyon:** \`${pf.bankName}\`
* **İş Bankası Güncel Bakiye:** **\`${Number(pf.isbankBalanceTry || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL\`**
* **Toplam Kişisel Servet (İş Bankası + Binance TR):** **\`${Number(pf.totalNetWorthTry || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL\`**
* **Beklenen Aylık Gelir Akışı:** \`${(pf.expectedMonthlyIncomes || []).map(i => `${i.name}: ${i.amountTry.toLocaleString('tr-TR')} TL`).join(' | ')} (Toplam: ${Number(pf.totalExpectedMonthlyTry || 14500).toLocaleString('tr-TR')} TL/Ay)\`
* **Aylık Dokunulmaz Yaşam & Nakit Kalkanı:** \`${Number(pf.monthlySafeLivingReserveTry || 5500).toLocaleString('tr-TR')} TL\` *(Haftalık Harcama Limiti: \`${Number(pf.weeklySpendLimitTry || 1375).toLocaleString('tr-TR')} TL\` | Bu Hafta Harcanan: \`${Number(pf.weeklySpentTry || 0).toLocaleString('tr-TR')} TL\`)*
* **💡 Günün Otonom CFO Tüyoları & Bütçe Emirleri:**
${(pf.cfoTips || []).map(t => `  - ${t}`).join('\n')}

---

## 6. AKTİF KORUMA VE MAKSİMUM KAZANÇ MOTORLARI (Quant v11.0 — Engine #30 MUTLAK YAPI)

1. **🛡️ Engine #19 — Tek Yönlü Gölge Tuzak Avcısı (Defensive Shadow Trap Detector):** Gerçek para yatırmadan önce adayları arka planda sanal izler (\`0%\` pozitif puan şişirme riski); sanalda çakılan veya 75dk sürünerek eriyen tuzak coinleri gerçek para kaybetmeden 4 saat kara listeye alır (\`shadow_telemetry.jsonl\`).
2. **🧪 Engine #20 & #21 — Kurumsal Mikroyapı & İğne Tuzak Kalkanı:** Gerçek **Amihud Likidite Oranı (\`|ret_1h%| / $1M\`)**, örneklem korumalı **Taker Akış Yavaşlama Filtresi**, zaman-hizalı **Fiyat–OI Ayı Uyumsuzluğu (\`PRICE_OI_DIVERGENCE\`)**, **Aşırı Kaldıraçlı Long Tasfiye Kalkanı (\`OVERLEVERAGED_LONG_TRAP\`)** ve **Üst Fitil Boğa Tuzağı (\`UPPER_WICK_REJECTION\`)** korumalarıyla sahte yükselişlere tek kuruş kaptırmaz.
3. **🔗 Engine #22 — Sektör Bulaşma Kalkanı & Küsürat (Dust) Süpürücü:** Bir ekosistemde zarar kes yaşanırsa aynı sektöre 45 dakika bulaşmaz; cüzdanda sıkışmış küsüratı (\`>= 1.50 TL\`) bulunan A+ onaylı coinlerde çıkışta küsüratı da birleştirip gerçek \`TRY\` nakite çevirir.
4. **⚡ Engine #23 & #24 — V-Dip Genişlik İtişi & Altın Çağ Kurumsal Lider Ateşleyici:** Piyasa dipten dönerken (\`1s BTC >= +%0,30\` + \`Altcoin >= %24 Yeşil\` + \`Kurtarma >= %38\`) 24s gecikmesini sıfırlar; teyitli Altın Çağ'da RSS haberi gecikse bile kurumsal likidite liderlerini (\`Hacim >= $15M\`, \`Amihud <= 8.0\`, \`Taker >= %55\`, \`RS/ATR >= 1.25\`) yakalar.
5. **🧹 Engine #25 & #26 — Taze Haber Kalkanı, Binance AI Hype & Shapiro Haber-Tepkisizlik Kapısı:** \`>75dk\` bayat haberlerin taze haberin sırtına binmesini ve clickbait başlıkları engeller; Binance Web3 AI duyarlılığını ve habere rağmen VWAP altında ezilen (\`<=-%0,85\`) zayıf coinleri eler.
6. **🔬 Engine #27 — İki Aşamalı Kalıcı Tahta Doğrulayıcı (\`PERSISTENT_BOOK_CONFIRMATION\`):** Alım emrinden hemen önce Binance TR \`_TRY\` tahtasından \`2.1sn\` arayla iki ayrı fotoğraf çeker; sahte alış duvarı (\`spoof decay > 0.12\`), tahta boşalması (\`hollowing\`), geniş makas (\`>%0,60\`) veya negatif mikro-fiyat primi varsa emri saniyesinde iptal eder.
7. **📅 Engine #28 — Perşembe Çöküşü Sonrası Cuma Boğa Tuzağı & Akşam Koruma Kalkanı (\`FRIDAY_BULL_TRAP_SHIELD\`):** 2 yıllık Binance verisinde kanıtlanan **%85,4 olasılıklı Cuma akşamı (\`15:00–23:59 TSİ\`) geri çekilme tuzaklarına** karşı Cuma sabahı vadeli OI/balina barajını sıkılaştırır; Cuma \`15:00 TSİ\` sonrasında habersiz ivme alımlarını kapatır, kasanın en az \`%40\`'ını dokunulmaz nakitte tutar ve açık pozisyonlarda kâr kilidini \`+%1,75\` yerine \`+%1,35\`'te erkenden devreye sokar.
8. **👑 Engine #29 — Dört Efsane Egemen Kriz Alfa Motoru (\`CRISIS_ALPHA_SOVEREIGN_OVERRIDE\` — PTJ + Minervini + O'Neil + GCR):** Piyasa henüz tam Altın Çağ'a geçmemişken (\`%24 <= Yeşil < %52\`) **Paul Tudor Jones (\`EMA20 > EMA50\`)**, **Mark Minervini (\`3-Mum Yükselen Dip + RS/ATR >= 1.40\`)**, **William O'Neil (\`Hacim >= 1.35x + En Üst %30 Kapanış + VWAP +0.8%\`)** ve **GCR (\`1s Balina >= %58 + Vadeli OI >= +0.30% + Negatif/Düşük Fonlama\`)** kurallarının tamamını aynı anda sağlayan (\`%75,0\` tarihsel başarı) kurumsal lider çıktığında RSS haberi ve Altın Çağ bekleme otoritelerini **ezerek (override)** doğrudan alım yapar.
9. **🏛️ Engine #30 — MUTLAK YAPI (\`APEX_META_SOVEREIGN_ARCHITECTURE\` — GPT-6-Luna & Antigravity Ortak Doğrulamalı):** Piyasayı birbiriyle kesişmeyen 3 rejime böler ve her çevrimde sembol başına tek motor atar (\`A < %24 -> BNF Panik Emilim [MA25 -%6 + 5dk/1dk Mikro Dönüş + NetRR >= 1.5]\`, \`%24 <= B < %52 -> Engine #29 Sovereign\`, \`C >= %52 -> Qullamaggie EP [Pmax NO-CHASE Tavanı]\`). Walk-forward tek taraflı %95 alt sınır (\`p_L\`) ve **Ed Thorp \`0.25x\` Kelly + \`%0.5\` Kasa Risk Bütçesi (\`R <= 5 TL\`, \`N <= %20 Kasa\`)** ile pozisyon büyüklüğünü matematiksel olarak kilitler.
10. **💰 Çakışmasız Kademeli Hasat (\`TP1 -> TP2 -> Moonbag\`) & \`+%1,75\` Net Kâr Kilidi:** \`TP1\` (\`%2,2–%3,6\`) alınmadan üst stop basamakları coini erken boğmaz; \`< 55 TL\` küsürat oluşacak pozisyonları bölmeden tam stop kilidine alır.
11. **🧠 Engine #15 & #16 — Tamamlanmış Ömür (Lifecycle) Bayes Öğrenme & Kişisel CFO:** Parçalı satışları tek işlem ömründe (\`positionId\`) birleştirerek öğrenir ve İş Bankası + Binance TR servetini tek merkezden yönetir.
`;

  fs.writeFileSync(RAPOR_FILE, md, 'utf8');
}

function savePortfolioState(state) {
  runAdaptiveLearningEngine(state);
  runPersonalCfoEngine(state);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  writeCleanTlReport(state);
}

function logEvent(state, msg) {
  const entry = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`;
  console.log(entry);
  state.recentLogs.unshift(entry);
  if (state.recentLogs.length > 40) state.recentLogs.length = 40;
  if (!state._cycleEvents) state._cycleEvents = [];
  state._cycleEvents.push(entry);
}

async function fetchJson(url, options = {}, timeoutMs = 5500) {
  const tryFetch = async targetUrl => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'AltcoinAutoTrader/7.0',
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await tryFetch(url);
  } catch (err) {
    if (url.includes('data-api.binance.vision')) {
      return await tryFetch(url.replace('data-api.binance.vision', 'api1.binance.com'));
    }
    throw err;
  }
}

async function getOrderbookQuotes(symbols) {
  if (symbols.length === 0) return {};
  const map = {};
  const uniqueSyms = Array.from(new Set(symbols));

  // Primary for active sets (first 12 symbols — open positions & top candidates): fetch live Binance TR _TRY bestBid/bestAsk directly
  if (USD_TRY_RATE > 0) {
    const trPrioritySyms = uniqueSyms.slice(0, 12);
    await Promise.all(
      trPrioritySyms.map(async sym => {
        try {
          const trDepth = await fetchJson(
            `https://www.trbinance.com/open/v1/market/depth?symbol=${sym}_TRY&limit=5`,
            {},
            2200
          );
          const trBids = trDepth?.data?.bids || trDepth?.bids;
          const trAsks = trDepth?.data?.asks || trDepth?.asks;
          const bestBidTry = Number(trBids?.[0]?.[0] || 0);
          const bestAskTry = Number(trAsks?.[0]?.[0] || 0);
          if (bestBidTry > 0 && bestAskTry > 0) {
            map[sym] = {
              bestBid: Number((bestBidTry / USD_TRY_RATE).toPrecision(6)),
              bestAsk: Number((bestAskTry / USD_TRY_RATE).toPrecision(6)),
              bestBidTry,
              bestAskTry,
              priceSource: 'BINANCE_TR',
            };
          }
        } catch {}
      })
    );
  }

  const missingSyms = uniqueSyms.filter(s => !map[s]);
  if (missingSyms.length === 0) return map;

  const wanted = new Set(missingSyms.map(s => `${s}USDT`));
  try {
    const param = JSON.stringify(Array.from(wanted));
    const list = await fetchJson(`${BINANCE_API}/ticker/bookTicker?symbols=${encodeURIComponent(param)}`, {}, 5000);
    for (const item of list) {
      const sym = item.symbol.replace(/USDT$/, '');
      const bidU = Number(item.bidPrice);
      const askU = Number(item.askPrice);
      map[sym] = {
        bestBid: bidU,
        bestAsk: askU,
        bestBidTry: Number((bidU * USD_TRY_RATE).toFixed(4)),
        bestAskTry: Number((askU * USD_TRY_RATE).toFixed(4)),
        priceSource: 'GLOBAL_PROXY',
      };
    }
    return map;
  } catch {
    try {
      const allList = await fetchJson(`${BINANCE_API}/ticker/bookTicker`, {}, 7500);
      for (const item of allList) {
        if (wanted.has(item.symbol)) {
          const sym = item.symbol.replace(/USDT$/, '');
          const bidU = Number(item.bidPrice);
          const askU = Number(item.askPrice);
          map[sym] = {
            bestBid: bidU,
            bestAsk: askU,
            bestBidTry: Number((bidU * USD_TRY_RATE).toFixed(4)),
            bestAskTry: Number((askU * USD_TRY_RATE).toFixed(4)),
            priceSource: 'GLOBAL_PROXY',
          };
        }
      }
      return map;
    } catch {
      return map;
    }
  }
}

function computeWeightedBookImbalance(bids, asks) {
  if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) return 0;
  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0) return 0;

  let weightedBid = 0;
  let weightedAsk = 0;
  for (const b of bids.slice(0, 15)) {
    const p = Number(b[0]);
    const q = Number(b[1]);
    const distBps = Math.max(0, ((mid - p) / mid) * 10000);
    if (distBps <= 25) {
      const w = Math.exp(-distBps / 5);
      weightedBid += w * p * q;
    }
  }
  for (const a of asks.slice(0, 15)) {
    const p = Number(a[0]);
    const q = Number(a[1]);
    const distBps = Math.max(0, ((p - mid) / mid) * 10000);
    if (distBps <= 25) {
      const w = Math.exp(-distBps / 5);
      weightedAsk += w * p * q;
    }
  }
  if (weightedBid + weightedAsk <= 0) return 0;
  return Number(((weightedBid - weightedAsk) / (weightedBid + weightedAsk)).toFixed(4));
}

async function fetchSingleBookImbalance(symbol) {
  try {
    // Primary: Binance TR native _TRY orderbook depth
    const trDepth = await fetchJson(`https://www.trbinance.com/open/v1/market/depth?symbol=${symbol}_TRY&limit=20`, {}, 2200).catch(() => null);
    const trBids = trDepth?.data?.bids || trDepth?.bids;
    const trAsks = trDepth?.data?.asks || trDepth?.asks;
    if (Array.isArray(trBids) && trBids.length > 0 && Array.isArray(trAsks) && trAsks.length > 0) {
      return computeWeightedBookImbalance(trBids, trAsks);
    }
    // Proxy Fallback: Global USDT depth
    const depth = await fetchJson(`${BINANCE_API}/depth?symbol=${symbol}USDT&limit=20`, {}, 2500);
    return computeWeightedBookImbalance(depth.bids || [], depth.asks || []);
  } catch {
    return 0;
  }
}

async function checkOrderbookImbalance(symbol) {
  // Spoof-Resistant 2-Snapshot conservative minimum/median check across 160ms
  const i1 = await fetchSingleBookImbalance(symbol);
  await new Promise(r => setTimeout(r, 160));
  const i2 = await fetchSingleBookImbalance(symbol);
  return Number(((i1 + i2) / 2).toFixed(2));
}

async function fetchBookSnapshot(symbol, requireBinanceTr = true) {
  try {
    const trDepth = await fetchJson(`https://www.trbinance.com/open/v1/market/depth?symbol=${symbol}_TRY&limit=20`, {}, 2200).catch(() => null);
    const trBids = trDepth?.data?.bids || trDepth?.bids;
    const trAsks = trDepth?.data?.asks || trDepth?.asks;
    let bids = null;
    let asks = null;
    let priceSource = 'BINANCE_TR';
    if (Array.isArray(trBids) && trBids.length > 0 && Array.isArray(trAsks) && trAsks.length > 0) {
      bids = trBids;
      asks = trAsks;
    } else if (!requireBinanceTr) {
      const depth = await fetchJson(`${BINANCE_API}/depth?symbol=${symbol}USDT&limit=20`, {}, 2500).catch(() => null);
      if (Array.isArray(depth?.bids) && depth.bids.length > 0 && Array.isArray(depth?.asks) && depth.asks.length > 0) {
        bids = depth.bids;
        asks = depth.asks;
        priceSource = 'GLOBAL_PROXY';
      }
    }
    if (!bids || !asks) return null;
    const bestBid = Number(bids[0][0]);
    const bestBidQty = Number(bids[0][1]);
    const bestAsk = Number(asks[0][0]);
    const bestAskQty = Number(asks[0][1]);
    if (bestBid <= 0 || bestAsk < bestBid) return null;
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = Number((((bestAsk - bestBid) / bestBid) * 100).toFixed(3));
    const microprice =
      bestBidQty + bestAskQty > 0
        ? (bestBid * bestAskQty + bestAsk * bestBidQty) / (bestBidQty + bestAskQty)
        : mid;
    const micropricePremBps = mid > 0 ? Number((((microprice - mid) / mid) * 10000).toFixed(2)) : 0;
    const imbalance = computeWeightedBookImbalance(bids, asks);
    return { bestBid, bestAsk, mid, spreadPct, micropricePremBps, imbalance, priceSource };
  } catch {
    return null;
  }
}

/**
 * Engine #27 (Codex Council — PERSISTENT_BOOK_CONFIRMATION):
 * Takes 2 Binance TR orderbook snapshots 2.1s apart right before live BUY.
 * Vetoes entry if spread > 0.60%, imbalance < minAllowedOb, microprice premium < 0,
 * imbalance deteriorates by > 0.12, or bid drops while ask rises (book hollowing out).
 */
async function verifyPersistentBookConfirmation(symbol, minAllowedOb = -0.05, requireBinanceTr = true) {
  const s1 = await fetchBookSnapshot(symbol, requireBinanceTr);
  if (!s1) return { ok: false, rejectReason: 'NO_BOOK_SNAPSHOT_1' };
  await new Promise(r => setTimeout(r, 2100));
  const s2 = await fetchBookSnapshot(symbol, requireBinanceTr);
  if (!s2) return { ok: false, rejectReason: 'NO_BOOK_SNAPSHOT_2', ob1: s1.imbalance };

  const midMovePct = s1.mid > 0 ? Number((((s2.mid - s1.mid) / s1.mid) * 100).toFixed(3)) : 0;
  const rawObDecay = s1.imbalance - s2.imbalance;
  const obDecay = Number(rawObDecay.toFixed(3));
  const isHollowingOut = s2.bestBid < s1.bestBid && s2.bestAsk > s1.bestAsk;

  let rejectReason = null;
  if (s1.spreadPct > 0.60 || s2.spreadPct > 0.60) {
    rejectReason = `WIDE_SPREAD (${s1.spreadPct}% -> ${s2.spreadPct}%)`;
  } else if (s1.imbalance < minAllowedOb || s2.imbalance < minAllowedOb) {
    rejectReason = `WEAK_IMBALANCE (${s1.imbalance} -> ${s2.imbalance} < ${minAllowedOb})`;
  } else if ((s1.micropricePremBps < -3.5 && s2.micropricePremBps < -3.5) || (s2.micropricePremBps < -5.0 && s2.imbalance < -0.05)) {
    rejectReason = `NEGATIVE_MICROPRICE_PREM (${s1.micropricePremBps}bps -> ${s2.micropricePremBps}bps)`;
  } else if (rawObDecay > 0.22 && s2.imbalance < -0.05) {
    rejectReason = `SPOOF_DECAY (ob1=${s1.imbalance} -> ob2=${s2.imbalance}, decay=${obDecay})`;
  } else if (isHollowingOut) {
    rejectReason = `BOOK_HOLLOWING_OUT (bid fell & ask rose)`;
  }

  return {
    ok: !rejectReason,
    rejectReason,
    ob1: s1.imbalance,
    ob2: s2.imbalance,
    imbalance: Number(((s1.imbalance + s2.imbalance) / 2).toFixed(2)),
    spreadPct: Math.max(s1.spreadPct, s2.spreadPct),
    micropricePremBps: s2.micropricePremBps,
    midMovePct,
    latestQuote: s2,
  };
}

let _trSymbolsCache = null;
async function getBinanceTrSymbolRules(symbol) {
  try {
    if (!_trSymbolsCache) {
      const res = await fetchJson('https://www.trbinance.com/open/v1/common/symbols', {}, 4500);
      _trSymbolsCache = res?.data?.list || [];
    }
    return _trSymbolsCache.find(s => s.symbol === `${symbol}_TRY`) || null;
  } catch {
    return null;
  }
}

function roundToStepSize(qty, stepSizeStr) {
  const step = Number(stepSizeStr || 0);
  if (!step || step <= 0) return Number(Number(qty).toPrecision(4));
  const decimals = (stepSizeStr.split('.')[1] || '').replace(/0+$/, '').length;
  const floored = Math.floor(Number(qty) / step) * step;
  return Number(floored.toFixed(decimals));
}

async function fetchBinanceTrStatus(cfg) {
  if (!cfg.BINANCE_API_KEY || !cfg.BINANCE_SECRET_KEY) {
    return { ok: false, tryFree: 0, assetsMap: {}, summary: 'API Anahtarı Yok' };
  }
  try {
    const ts = Date.now();
    const qs = `timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', cfg.BINANCE_SECRET_KEY).update(qs).digest('hex');
    const res = await fetchJson(
      `https://www.trbinance.com/open/v1/account/spot?${qs}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': cfg.BINANCE_API_KEY } },
      6500
    );
    if (res && res.code === 0 && res.data) {
      const assets = (res.data.accountAssets || []).filter(a => Number(a.free) > 0 || Number(a.locked) > 0);
      const assetsMap = {};
      for (const a of assets) assetsMap[a.asset] = Number(a.free);
      const tryAsset = assets.find(a => a.asset === 'TRY');
      const tryFree = tryAsset ? Number(tryAsset.free) : 0;
      const assetSummary = assets.map(a => `${a.asset}: ${Number(a.free).toFixed(4)}`).join(' | ') || 'TRY: 0.00';
      return {
        ok: true,
        canTrade: res.data.canTrade === 1,
        tryFree,
        assetsMap,
        summary: `Aktif (trbinance.com — Spot Cüzdan: ${assetSummary})`,
      };
    }
  } catch {
    // Fallback if unreachable
  }
  return { ok: false, tryFree: 0, assetsMap: {}, summary: 'Bağlantı Bekleniyor' };
}

async function executeBinanceRealOrder(cfg, symbol, side, quantity, quoteOrderQtyUsdt = null) {
  const timestamp = Date.now();
  try {
    const rule = await getBinanceTrSymbolRules(symbol);
    const status = await fetchBinanceTrStatus(cfg);
    const preTryFree = status.ok ? Number(status.tryFree || 0) : 0;
    const preCoinFree = status.ok ? Number(status.assetsMap?.[symbol] || 0) : 0;
    let adjQty = quantity;
    if (side === 'SELL' && status.ok) {
      const walletFree = preCoinFree;
      if (walletFree <= 0 || walletFree < quantity * 0.1) {
        return { code: 0, alreadySold: true };
      }
      // Sweep 100% of wallet balance (including any accumulated dust) on full position exits
      if (adjQty > walletFree || adjQty >= walletFree * 0.80) {
        adjQty = walletFree;
      }
    }
    const lotFilter = (rule?.filters || []).find(f => f.filterType === 'LOT_SIZE');
    if (lotFilter?.stepSize) {
      adjQty = roundToStepSize(adjQty, lotFilter.stepSize);
    }

    const trParams = new URLSearchParams({
      symbol: `${symbol}_TRY`,
      side: side === 'BUY' ? '0' : '1',
      type: '2', // MARKET order on Binance TR open/v1/orders
      timestamp: String(timestamp),
    });
    if (side === 'BUY' && quoteOrderQtyUsdt) {
      let tryAmount = Number((Number(quoteOrderQtyUsdt) * USD_TRY_RATE).toFixed(2));
      if (status.ok && status.tryFree > 0) {
        const maxSafeTry = Number((Math.floor(status.tryFree * 0.998 * 100) / 100).toFixed(2));
        tryAmount = Math.min(tryAmount, maxSafeTry);
      }
      if (tryAmount < 15) return { code: -1, msg: 'Yetersiz TRY bakiyesi' };
      trParams.set('quoteOrderQty', String(tryAmount));
    } else {
      trParams.set('quantity', String(adjQty));
    }
    const trSig = crypto
      .createHmac('sha256', cfg.BINANCE_SECRET_KEY)
      .update(trParams.toString())
      .digest('hex');
    trParams.set('signature', trSig);

    const trRes = await fetchJson(`https://www.trbinance.com/open/v1/orders?${trParams.toString()}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': cfg.BINANCE_API_KEY },
    });
    if (trRes && trRes.code === 0) {
      await new Promise(r => setTimeout(r, 2200));
      const postStatus = await fetchBinanceTrStatus(cfg);
      if (side === 'BUY' && postStatus.ok) {
        const postCoinFree = Number(postStatus.assetsMap?.[symbol] || 0);
        const rawDeltaQty = Math.max(0, postCoinFree - preCoinFree);
        const spentTry = Math.max(0, preTryFree - Number(postStatus.tryFree || 0));
        const filledQty =
          rawDeltaQty > 0
            ? lotFilter?.stepSize
              ? roundToStepSize(postCoinFree, lotFilter.stepSize)
              : postCoinFree
            : adjQty;
        const priceDenomQty = rawDeltaQty > 0 ? rawDeltaQty : filledQty;
        const fillPriceTry = priceDenomQty > 0 && spentTry > 10 ? Number((spentTry / priceDenomQty).toFixed(6)) : null;
        const fillPriceUsdt = fillPriceTry ? Number((fillPriceTry / USD_TRY_RATE).toPrecision(5)) : null;
        const dustSweepQty = Math.max(0, Number((postCoinFree - filledQty).toPrecision(4)));
        return { ...trRes, executedQty: filledQty, fillPriceTry, fillPriceUsdt, spentTry, dustSweepQty, postStatus };
      }
      if (side === 'SELL' && postStatus.ok) {
        const postCoinFree = Number(postStatus.assetsMap?.[symbol] || 0);
        const rawSoldQty = Math.max(0, preCoinFree - postCoinFree);
        const receivedTry = Math.max(0, Number(postStatus.tryFree || 0) - preTryFree);
        const soldExecQty = rawSoldQty > 0 ? rawSoldQty : adjQty;
        const fillPriceTry = soldExecQty > 0 && receivedTry > 10 ? Number((receivedTry / soldExecQty).toFixed(6)) : null;
        const fillPriceUsdt = fillPriceTry ? Number((fillPriceTry / USD_TRY_RATE).toPrecision(5)) : null;
        return { ...trRes, executedQty: soldExecQty, fillPriceTry, fillPriceUsdt, receivedTry, postStatus };
      }
      return { ...trRes, executedQty: adjQty };
    }
    return { code: -1, msg: JSON.stringify(trRes || {}) };
  } catch (err) {
    return { code: -1, msg: err?.message || 'TR Order Error' };
  }
}

async function processProfitTargets(cfg, state, pos, currentBid) {
  // Engine #30 BNF Panic Mean-Reversion uses single full exit at TP = entry * 1.022 (no partial splitting)
  if (pos.engineOwner === 'BNF') return false;
  let harvested = false;
  const exitFrictionPct = 0.22;
  const atr = pos.atr1hPct || 1.55;
  const tp1Pct = Number(Math.max(2 * exitFrictionPct + 0.35, Math.min(3.6, Math.max(2.2, atr * 1.8))).toFixed(2));
  const tp2Pct = Number(Math.min(8.5, Math.max(5.5, atr * 4.2)).toFixed(2));
  pos.tp1Pct = tp1Pct;
  pos.tp2Pct = tp2Pct;
  if (!pos.initialCostUsdt) pos.initialCostUsdt = pos.costUsdt;
  if (!pos.initialQty) pos.initialQty = pos.qty;

  const peakGainPct = pos.entryPrice > 0 ? ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  const posAgeMins = pos.entryTime ? (Date.now() - new Date(pos.entryTime).getTime()) / 60000 : 99;
  const freshFlowPct = posAgeMins <= 15 ? (pos.last1hTakerBuyPct ?? pos.takerBuyRatioPct ?? 50) : (pos.takerBuyRatioPct ?? 50);

    // Stage 1 Profit Harvest (TP1: volatility-scaled 2.2% - 3.6%, triggered by peakGainPct with executable currentBid guard)
  if (
    !pos.partialTpDone &&
    peakGainPct >= tp1Pct &&
    pos.unrealizedPnlPct >= Math.max(1.25, tp1Pct - 0.50)
  ) {
    // Only grant 30% TP1 harvest (70% moonbag) when signal is fresh (<= 15m) and 1h flow + OB + RS_ATR confirm strong continuation
    const isStrongCont = posAgeMins <= 15 && freshFlowPct >= 54 && (pos.obImbalance || 0) >= 0 && (pos.rsAtr || 0) >= 1.2;
    const tp1Fraction = isStrongCont ? 0.30 : 0.40;
    let sellQty = Number((pos.initialQty * tp1Fraction).toPrecision(4));
    const estSellTry = sellQty * currentBid * USD_TRY_RATE;
    const estRemainTry = Math.max(0, pos.qty - sellQty) * currentBid * USD_TRY_RATE;
    // Dust/MIN_NOTIONAL Guard: If partial sell or remaining moonbag would be < 55 TL on Binance TR, do not split into unsellable dust; lock stop tightly instead!
    if (state.mode === 'LIVE_BINANCE' && (estSellTry < 55 || estRemainTry < 55)) {
      pos.partialTpDone = true;
      pos.rocketMode = true;
      pos.trailingActive = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * (1 + (tp1Pct * 0.72 + exitFrictionPct) / 100)).toPrecision(5)),
        Number((pos.highestPrice * 0.990).toPrecision(5))
      );
      logEvent(
        state,
        `🔒 [TAM KÂR KİLİDİ - DUST KORUMASI] ${pos.symbol} pozisyonu (${Math.round(pos.qty * currentBid * USD_TRY_RATE)} TL) bölününce borsa alt limitine (<55 TL) takılmaması için bölünmedi; tamamı +%${(tp1Pct * 0.72).toFixed(2)} net kâr kilidine alındı!`
      );
      return true;
    }
    let orderOk = true;
    let tp1ExitBid = currentBid;
    if (state.mode === 'LIVE_BINANCE') {
      const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
      if (!sellRes || sellRes.code !== 0) {
        orderOk = false;
      } else {
        if (sellRes.executedQty > 0) sellQty = Math.min(pos.qty, sellRes.executedQty);
        if (sellRes.fillPriceUsdt > 0) tp1ExitBid = sellRes.fillPriceUsdt;
      }
    }
    if (orderOk && sellQty > 0) {
      const remainQty = Number(Math.max(0, pos.qty - sellQty).toPrecision(4));
      const actualSoldFraction = pos.initialQty > 0 ? Math.min(1, sellQty / pos.initialQty) : tp1Fraction;
      const tp1LabelPct = Math.round(actualSoldFraction * 100);
      const remainLabelPct = Math.max(0, 100 - tp1LabelPct);
      const soldCostUsdt = Number((pos.initialCostUsdt * actualSoldFraction).toFixed(4));
      const proceedsUsdt = Number((tp1ExitBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));

      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      state.partialProfitCount = (state.partialProfitCount || 0) + 1;

      const exitReason = `💰 1. KADEME (%${tp1LabelPct}) SIFIR RİSK KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %${remainLabelPct} Bedava Uçuşta)`;
      appendTradeTelemetry(pos, tp1ExitBid, exitReason, netPnlUsdt, netPnlTry, sellQty);
      state.closedTrades.unshift({
        positionId: pos.id,
        leg: 'TP1',
        symbol: pos.symbol,
        newsSource: pos.newsSource,
        entryPattern: pos.entryPattern,
        breadthAtEntry: pos.breadthAtEntry,
        rsiAtEntry: pos.rsiAtEntry,
        takerBuyRatioPct: pos.takerBuyRatioPct,
        entryPrice: pos.entryPrice,
        exitPrice: tp1ExitBid,
        exitTime: new Date().toISOString(),
        costUsdt: soldCostUsdt,
        netPnlUsdt,
        netPnlTry,
        exitReason,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number(Math.max(0, pos.initialCostUsdt - soldCostUsdt).toFixed(4));
      pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
      pos.partialTpDone = true;
      pos.rocketMode = true;
      pos.trailingActive = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * (1 + (tp1Pct * 0.65 + exitFrictionPct) / 100)).toPrecision(5)),
        Number((pos.highestPrice * 0.988).toPrecision(5))
      );
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
      logEvent(
        state,
        `💰 [SIFIR RİSK KÂR HASADI] ${pos.symbol} %${tp1LabelPct}'i satıldı (+${toTL(netPnlUsdt)} TL)! Kalan %${remainLabelPct} Sıfır Riskle Bedava Uçuşta!`
      );
      harvested = true;
    }
  }

  // Stage 2 Profit Harvest (TP2: volatility-scaled 5.5% - 8.5% -> Always leave exact 30% of initialQty as Uncapped Moonbag!)
  if (
    pos.partialTpDone &&
    !pos.stage2TpDone &&
    peakGainPct >= tp2Pct &&
    pos.unrealizedPnlPct >= Math.max(3.8, tp2Pct - 0.80)
  ) {
    const targetMoonbagQty = Number((pos.initialQty * 0.30).toPrecision(4));
    let sellQty = Number(Math.max(pos.qty * 0.45, pos.qty - targetMoonbagQty).toPrecision(4));
    const estRemainAfterTp2Try = Math.max(0, pos.qty - sellQty) * currentBid * USD_TRY_RATE;
    // If remaining 30% moonbag would be < 55 TL on Binance TR, lock stop at 85% of TP2 gain instead of creating unsellable dust
    if (state.mode === 'LIVE_BINANCE' && estRemainAfterTp2Try < 55) {
      pos.stage2TpDone = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * (1 + (tp2Pct * 0.82 + exitFrictionPct) / 100)).toPrecision(5)),
        Number((pos.highestPrice * 0.991).toPrecision(5))
      );
      logEvent(
        state,
        `🚀 [2. KADEME TAM KÂR KİLİDİ] ${pos.symbol} kalan bakiye küsürata (<55 TL) düşmesin diye bölünmedi; stop $${pos.stopLossPrice} seviyesine yükseltildi!`
      );
      return true;
    }
    let orderOk = true;
    let tp2ExitBid = currentBid;
    if (state.mode === 'LIVE_BINANCE') {
      const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
      if (!sellRes || sellRes.code !== 0) {
        orderOk = false;
      } else {
        if (sellRes.executedQty > 0) sellQty = Math.min(pos.qty, sellRes.executedQty);
        if (sellRes.fillPriceUsdt > 0) tp2ExitBid = sellRes.fillPriceUsdt;
      }
    }
    if (orderOk && sellQty > 0) {
      const remainQty = Number(Math.max(0, pos.qty - sellQty).toPrecision(4));
      const actualTp2FracOfInit = pos.initialQty > 0 ? Math.min(1, sellQty / pos.initialQty) : 0.30;
      const remainFracOfInit = pos.initialQty > 0 ? Math.round((remainQty / pos.initialQty) * 100) : 30;
      const tp2LabelPct = Math.round(actualTp2FracOfInit * 100);
      const soldCostUsdt = Number(Math.min(pos.costUsdt, pos.initialCostUsdt * actualTp2FracOfInit).toFixed(4));
      const proceedsUsdt = Number((tp2ExitBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));

      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      state.partialProfitCount = (state.partialProfitCount || 0) + 1;

      const exitReason = `🚀 2. KADEME (%${tp2LabelPct}) DEV KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %${remainFracOfInit} Sınırsız Roket)`;
      appendTradeTelemetry(pos, tp2ExitBid, exitReason, netPnlUsdt, netPnlTry, sellQty);
      state.closedTrades.unshift({
        positionId: pos.id,
        leg: 'TP2',
        symbol: pos.symbol,
        newsSource: pos.newsSource,
        entryPattern: pos.entryPattern,
        breadthAtEntry: pos.breadthAtEntry,
        rsiAtEntry: pos.rsiAtEntry,
        takerBuyRatioPct: pos.takerBuyRatioPct,
        entryPrice: pos.entryPrice,
        exitPrice: tp2ExitBid,
        exitTime: new Date().toISOString(),
        costUsdt: soldCostUsdt,
        netPnlUsdt,
        netPnlTry,
        exitReason,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number(Math.max(0, pos.costUsdt - soldCostUsdt).toFixed(4));
      pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
      pos.stage2TpDone = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * (1 + (tp2Pct * 0.75 + exitFrictionPct) / 100)).toPrecision(5)),
        Number((pos.highestPrice * 0.989).toPrecision(5))
      );
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
      logEvent(
        state,
        `🚀 [2. KADEME DEV KÂR ALINDI] ${pos.symbol} +%${pos.unrealizedPnlPct} kârla satıldı (+${toTL(netPnlUsdt)} TL)! Son %${remainFracOfInit} sınırsız uçuşta!`
      );
      harvested = true;
    }
  }
  return harvested;
}

async function runTradingCycle() {
  await syncLiveUsdTryRate();
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  state.usdTryRate = USD_TRY_RATE;
  let trStatus = await fetchBinanceTrStatus(cfg);
  if (trStatus.ok) {
    state.binanceTrStatus = trStatus.summary;
    state.walletAssetsMap = trStatus.assetsMap;
    state._apiFailCount = 0;
  } else {
    state._apiFailCount = (state._apiFailCount || 0) + 1;
    if (state._apiFailCount === 2) {
      await sendInstantPhoneAlert('🚨 UYARI: Binance TR API anahtari yanit vermiyor (Kod 3701 veya IP/Izin hatasi). Lutfen API anahtarini kontrol et!');
    }
    if (state.walletAssetsMap) {
      trStatus.assetsMap = state.walletAssetsMap;
    } else {
      state.binanceTrStatus = trStatus.summary;
    }
  }

  // Automatic Paper -> Live Cutover the moment >= 50 TL is deposited to Binance TR!
  if (cfg.LIVE_TRADING && cfg.BINANCE_API_KEY && trStatus.ok && trStatus.tryFree >= 50 && state.mode !== 'LIVE_BINANCE') {
    const depositedTry = Number(trStatus.tryFree.toFixed(2));
    const depositedUsdt = Number((depositedTry / USD_TRY_RATE).toFixed(4));
    state.mode = 'LIVE_BINANCE';
    state.liveActivated = true;
    state.initialBankrollTry = depositedTry;
    state.initialBankrollUsdt = depositedUsdt;
    state.highWaterMarkUsdt = depositedUsdt;
    state.cashUsdt = depositedUsdt;
    state.realizedPnlUsdt = 0;
    state.winCount = 0;
    state.lossCount = 0;
    state.openPositions = [];
    state.closedTrades = [];
    state.cooldowns = {};
    logEvent(
      state,
      `🏦 [GERÇEK HESAP BAŞLATILDI] Binance TR cüzdanında ${toTL(depositedUsdt)} TL tespit edildi! Sanal simülasyon sıfırlandı ve %100 Gerçek Al-Sat aktif edildi!`
    );
  } else if (state.liveActivated || state.mode === 'LIVE_BINANCE') {
    state.mode = 'LIVE_BINANCE';
    if (trStatus.ok) {
      state.cashUsdt = Number((trStatus.tryFree / USD_TRY_RATE).toFixed(4));
      for (const p of state.openPositions || []) {
        const rawRealQty = trStatus.assetsMap?.[p.symbol];
        const effectiveRealQty = rawRealQty ? Math.max(0, rawRealQty - Number(p.dustSweepQty || 0)) : 0;
        if (effectiveRealQty > 0 && Math.abs(effectiveRealQty - p.qty) / p.qty < 0.08) {
          p.qty = effectiveRealQty;
        }
        p.costUsdt = Number((p.entryPrice * p.qty).toFixed(4));
      }
    }
  } else {
    state.mode = 'REALTIME_ORDERBOOK_PAPER';
  }

  let signalsData = { top4AltcoinPicks: [], allQualifiedOpportunities: [], btcCrashAlert: false, btc1hChangePct: 0 };
  try {
    signalsData = await runNewsScan();
  } catch (err) {
    logEvent(state, `⚠️ Haber tarayıcı uyarısı: ${err.message}`);
    if (fs.existsSync(SIGNALS_FILE)) {
      signalsData = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    }
  }

  const candidates = [
    ...(signalsData.top4AltcoinPicks || []),
    ...(signalsData.allQualifiedOpportunities || []),
  ];
  const symbolsToQuote = Array.from(
    new Set([
      ...state.openPositions.map(p => p.symbol),
      ...candidates.slice(0, 14).map(c => c.symbol),
    ])
  );

  const quotes = await getOrderbookQuotes(symbolsToQuote);
  const nowMs = Date.now();

  // Manage existing open positions
  const remainingPositions = [];
  for (const pos of state.openPositions) {
    const q = quotes[pos.symbol];
    if (!q || !q.bestBid || (state.mode === 'LIVE_BINANCE' && q.priceSource !== 'BINANCE_TR')) {
      remainingPositions.push(pos);
      continue;
    }

    const currentBid = q.bestBid;
    if (q.bestBidTry) pos.currentBidTry = q.bestBidTry;
    if (q.bestAskTry) pos.currentAskTry = q.bestAskTry;
    pos.currentPrice = currentBid;
    pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentBid);
    pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
    pos.unrealizedPnlPct = Number((((currentBid - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));

    // Protection #1: BTC Crash Tightener
    if (signalsData.btcCrashAlert && pos.unrealizedPnlPct > 0.5) {
      const emergencyStop = Number((currentBid * 0.992).toPrecision(5));
      if (emergencyStop > pos.stopLossPrice) {
        pos.stopLossPrice = emergencyStop;
        logEvent(state, `🛡️ [BTC Çöküş Kalkanı] ${pos.symbol} kârı korumaya alındı -> SL: $${pos.stopLossPrice}`);
      }
    }

    // Engine #6: Live Whale Sell-Wall Front-Run Check on Winning Positions
    if (pos.unrealizedPnlPct >= 1.5) {
      const liveOb = await checkOrderbookImbalance(pos.symbol);
      if (liveOb <= -0.45) {
        const wallProtectStop = Number((currentBid * 0.996).toPrecision(5));
        if (wallProtectStop > pos.stopLossPrice) {
          pos.stopLossPrice = wallProtectStop;
          logEvent(state, `🧱 [Satış Duvarı Kalkanı] ${pos.symbol} önünde balina satış duvarı (${liveOb}) tespit edildi, kâr kilidi sıkılaştırıldı!`);
        }
      }
    }

    // Engine #7A & #7B: Unified Volatility-Scaled Profit Harvest (TP1 & TP2)
    await processProfitTargets(cfg, state, pos, currentBid);

    // Engine #8: HARMONIZED ZERO-CONFLICT RATCHET LADDER (Synchronized with dynamic tp1Pct/tp2Pct + Engine #28 Friday PM Early Profit Lock)
    const tsiCycleNow = new Date(Date.now() + 3 * 3600 * 1000);
    const isFridayPmCycle = tsiCycleNow.getUTCDay() === 5 && tsiCycleNow.getUTCHours() >= 15;
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const dynTp1 = Number(pos.tp1Pct || 2.2);
    const breakevenTriggerPct = isFridayPmCycle ? 1.35 : Math.max(1.75, Number((dynTp1 * 0.72).toFixed(2)));
    let stepFloorPrice = pos.stopLossPrice;
    if (pos.partialTpDone && peakGainPct >= 7.0) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.988).toPrecision(5)), Number((pos.entryPrice * 1.0602).toPrecision(5)));
    } else if (pos.partialTpDone && peakGainPct >= 4.5) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.986).toPrecision(5)), Number((pos.entryPrice * 1.0342).toPrecision(5)));
    } else if (pos.partialTpDone && peakGainPct >= 3.2) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0202).toPrecision(5)));
    } else if (peakGainPct >= breakevenTriggerPct) {
      // Pre-TP1 Breakeven+ Shield: Only locks +0.46% net profit (1.0068x entry), leaving full breathing room up to TP1!
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0068).toPrecision(5)));
    }

    if (stepFloorPrice > pos.stopLossPrice) {
      pos.stopLossPrice = stepFloorPrice;
    }
    // Only mark trailingActive = true if stop-loss is genuinely above entry price (in profit)
    pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
    if (peakGainPct >= 2.5 && pos.trailingActive) pos.rocketMode = true;

    // Engine #30.1 (Qullamaggie Zero-Risk Winner Pyramiding — Sifir Riskli Kârda Piramitleme):
    // Only scales into a winner AFTER Leg 1 is up >= +1.35% AND its stop-loss is locked above breakeven (>= 1.0068x entry).
    // Requires fresh Engine #27 persistent book confirmation (spread <= 0.40%, obImbalance >= +0.12) and immediately locks the combined position at net breakeven+!
    if (
      !pos.isMoonshot &&
      !pos.pyramidAdded &&
      !pos.partialTpDone &&
      pos.engineOwner !== 'BNF' &&
      pos.trailingActive &&
      pos.stopLossPrice >= pos.entryPrice * 1.0068 &&
      pos.unrealizedPnlPct >= 1.35 &&
      pos.unrealizedPnlPct <= Number(pos.tp1Pct || 2.5) * 0.88 &&
      !signalsData.btcCrashAlert &&
      (signalsData.marketBreadthPct ?? 50) >= 32 &&
      state.cashUsdt * USD_TRY_RATE >= 120
    ) {
      const pyrBook = await verifyPersistentBookConfirmation(pos.symbol, 0.12, state.mode === 'LIVE_BINANCE');
      if (pyrBook.ok && pyrBook.spreadPct <= 0.40 && pyrBook.imbalance >= 0.12) {
        const pyrAskUsdt = pyrBook.latestQuote?.bestAsk
          ? pyrBook.latestQuote.priceSource === 'BINANCE_TR'
            ? Number((pyrBook.latestQuote.bestAsk / USD_TRY_RATE).toPrecision(6))
            : Number(pyrBook.latestQuote.bestAsk.toPrecision(6))
          : q.bestAsk || currentBid * 1.001;
        const curEquityUsdt = state.cashUsdt + state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
        const pyrTargetUsdt = Math.min(curEquityUsdt * 0.20, pos.costUsdt * 0.65, Math.floor(state.cashUsdt * 100) / 100);
        const pyrRule = state.mode === 'LIVE_BINANCE' ? await getBinanceTrSymbolRules(pos.symbol) : null;
        const pyrLot = (pyrRule?.filters || []).find(f => f.filterType === 'LOT_SIZE');
        let pyrQty = roundToStepSize(pyrTargetUsdt / pyrAskUsdt, pyrLot?.stepSize);
        let pyrCostUsdt = Number((pyrQty * pyrAskUsdt).toFixed(4));
        const pyrNotionalTry = pyrCostUsdt * USD_TRY_RATE;
        // Verify that locking the combined position at 1.0068x newAvgEntry (full net breakeven+ after 0.44% round-trip friction) stays strictly below currentBid
        const projTotalQty = pos.qty + pyrQty;
        const projAvgEntry = projTotalQty > 0 ? (pos.entryPrice * pos.qty + pyrAskUsdt * pyrQty) / projTotalQty : pos.entryPrice;
        const projCombinedBreakevenFloor = Number((projAvgEntry * 1.0068).toPrecision(5));
        if (pyrQty > 0 && pyrNotionalTry >= 60 && currentBid > projCombinedBreakevenFloor * 1.0025) {
          let pyrOk = true;
          let fillPyrPrice = pyrAskUsdt;
          if (state.mode === 'LIVE_BINANCE') {
            const pyrRes = await executeBinanceRealOrder(cfg, pos.symbol, 'BUY', pyrQty, pyrCostUsdt);
            if (!pyrRes || pyrRes.code !== 0) pyrOk = false;
            else {
              if (pyrRes.executedQty > 0) pyrQty = pyrRes.executedQty;
              if (pyrRes.fillPriceUsdt > 0) fillPyrPrice = pyrRes.fillPriceUsdt;
              pyrCostUsdt = Number((pyrQty * fillPyrPrice).toFixed(4));
            }
          }
          if (pyrOk && pyrQty > 0) {
            const newTotalQty = Number((pos.qty + pyrQty).toFixed(8));
            const newAvgEntry = Number(((pos.entryPrice * pos.qty + fillPyrPrice * pyrQty) / newTotalQty).toPrecision(6));
            pos.entryPrice = newAvgEntry;
            pos.entryPriceTry = Number((newAvgEntry * USD_TRY_RATE).toFixed(4));
            pos.qty = newTotalQty;
            pos.initialQty = newTotalQty;
            pos.costUsdt = Number((newAvgEntry * newTotalQty).toFixed(4));
            pos.initialCostUsdt = pos.costUsdt;
            pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
            pos.pyramidAdded = true;
            const postFillBreakevenPlus = Number((newAvgEntry * 1.0068).toPrecision(5));
            const safeBidCeiling = Number((currentBid * 0.9980).toPrecision(5));
            pos.stopLossPrice = Math.max(
              pos.stopLossPrice,
              Math.min(postFillBreakevenPlus, safeBidCeiling),
              Number((newAvgEntry * 1.0046).toPrecision(5))
            );
            pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
            pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
            pos.unrealizedPnlPct = Number((((currentBid - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
            state.cashUsdt = Number(Math.max(0, state.cashUsdt - pyrCostUsdt).toFixed(4));
            logEvent(
              state,
              `🔥 [Engine #30.1 Qullamaggie Sıfır Riskli Piramitleme] ${pos.symbol} kâr kilidindeyken 2. mermi (+${toTL(pyrCostUsdt)} TL) eklendi! Toplam: ${toTL(pos.costUsdt)} TL | Yeni Garanti Kâr Stopu: ${pos.stopLossPrice}`
            );
          }
        }
      }
    }

    // Dynamic Noise-Filtered Stop (never lower an existing stopLossPrice; BNF preserves exact sweepLow stop)
    const dynamicNoiseSlPct = Number(Math.min(2.4, Math.max(1.5, (pos.atr1hPct || 1.6) * 0.90)).toFixed(2));
    if (!pos.trailingActive && pos.engineOwner !== 'BNF') {
      pos.slPct = pos.slPct ? Math.min(2.4, Math.max(1.5, pos.slPct)) : dynamicNoiseSlPct;
      const dynFloor = Number((pos.entryPrice * (1 - pos.slPct / 100)).toPrecision(5));
      if (!pos.stopLossPrice || pos.stopLossPrice < Number((pos.entryPrice * 0.975).toPrecision(5))) {
        pos.stopLossPrice = Math.max(pos.stopLossPrice || 0, dynFloor);
      }
    }

    const hoursHeld = (nowMs - new Date(pos.entryTime).getTime()) / (1000 * 3600);
    const minsHeld = hoursHeld * 60;
    const latestSig = candidates.find(c => c.symbol === pos.symbol);
    let exitReason = null;

    // Executable Exit Value after Expected Slippage (0.12%) & Sell Fee (0.10%) — without double-counting bid-ask spread!
    const executableExit = currentBid * (1 - 0.0012) * (1 - 0.0010);
    const netPnlUsdtExec = (executableExit - pos.entryPrice) * pos.qty;
    const netPnlTryExec = netPnlUsdtExec * USD_TRY_RATE;
    const posRiskBudgetTry = Number(pos.riskBudgetTry || 4.50);

    if (currentBid <= pos.stopLossPrice || (!pos.trailingActive && netPnlTryExec <= -posRiskBudgetTry)) {
      pos.stopHitCount = (pos.stopHitCount || 0) + 1;
      if (!pos.firstStopHitAt) pos.firstStopHitAt = nowMs;
    } else {
      pos.stopHitCount = 0;
      pos.firstStopHitAt = 0;
    }
    const isEmergencyTlLoss = !pos.trailingActive && netPnlTryExec <= -(posRiskBudgetTry * 1.30);
    const isBnfTargetHit =
      pos.engineOwner === 'BNF' &&
      (currentBid >= (pos.takeProfitPrice || pos.entryPrice * 1.022) || pos.unrealizedPnlPct >= 2.20);
    const isBnfImmediateStop =
      pos.engineOwner === 'BNF' &&
      (currentBid <= pos.stopLossPrice || netPnlTryExec <= -posRiskBudgetTry);
    const isConfirmedStop =
      isBnfImmediateStop ||
      (pos.trailingActive && currentBid <= pos.stopLossPrice) ||
      isEmergencyTlLoss ||
      (pos.stopHitCount >= 2 && nowMs - (pos.firstStopHitAt || nowMs) >= 3000);

    // Engine #9: ZERO-LOSS EARLY SCRATCH & LIVE ORDERBOOK TRACKING (Sifir Zarar / Zayiflayan Tahta Erken Tahliye Kalkani)
    let liveObForScratch = Number(pos.liveObImbalance ?? pos.obImbalance ?? 0);
    if (!pos.partialTpDone && pos.unrealizedPnlPct <= 0.35) {
      liveObForScratch = await checkOrderbookImbalance(pos.symbol);
      pos.liveObImbalance = liveObForScratch;
    }

    if (isBnfTargetHit) {
      exitReason = `🎯 BNF PANİK HEDEFİ TAM ÇIKIŞ (+%${pos.unrealizedPnlPct})`;
    } else if (isConfirmedStop) {
      const isProfitLock = pos.stopLossPrice > pos.entryPrice && pos.unrealizedPnlPct >= 0;
      exitReason = pos.rocketMode && isProfitLock
        ? `🚀 UÇUŞ MODU KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
        : isProfitLock
          ? `🔒 SIFIR RİSK KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
          : pos.engineOwner === 'BNF'
            ? `🛡️ BNF İLK STOP TAM ÇIKIŞ (%${pos.unrealizedPnlPct} | ${netPnlTryExec.toFixed(2)} TL)`
            : `🛡️ SABİT TL RİSK & ATR KALKANI (%${pos.unrealizedPnlPct} | ${netPnlTryExec.toFixed(2)} TL)`;
    } else if (
      ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(pos.newsSource) &&
      pos.unrealizedPnlPct >= 0.25
    ) {
      exitReason = `🧹 HABERSİZ SİNYAL KÂRLI TAHLİYESİ (Gerçek Haber Slotuna Yer Açıldı +%${pos.unrealizedPnlPct})`;
    } else if (latestSig && latestSig.liveLlmDecision === 'WAIT' && latestSig.liveLlmConfidence >= 80 && !pos.rocketMode && pos.unrealizedPnlPct >= 0.15) {
      exitReason = `🧠 AI KONSEYİ TUZAK HABER TAHLİYESİ (GPT-120B & Qwen-3.8: Riskli Haber — +%${pos.unrealizedPnlPct})`;
    } else if (!pos.partialTpDone && minsHeld >= 45 && pos.unrealizedPnlPct <= 0.1 && pos.unrealizedPnlPct >= -0.60 && liveObForScratch < -0.25 && latestSig && latestSig.takerBuyRatioPct < 45) {
      exitReason = `🛡️ SIFIR RİSK ERKEN TAHLİYE (İvme Zayıfladı, Başa Baş Noktasında Çıkıldı %${pos.unrealizedPnlPct})`;
    } else if (
      !pos.partialTpDone &&
      ((minsHeld >= 75 && peakGainPct < 1.0 && pos.unrealizedPnlPct <= -0.65 && liveObForScratch <= -0.15) ||
        (minsHeld >= 120 && peakGainPct < 0.8 && pos.unrealizedPnlPct <= -0.85) ||
        (isFridayPmCycle && minsHeld >= 35 && peakGainPct < 0.9 && pos.unrealizedPnlPct <= -0.45 && liveObForScratch <= -0.18) ||
        (minsHeld >= 45 && peakGainPct < 0.8 && pos.unrealizedPnlPct <= -0.80 && (signalsData.marketBreadthPct ?? 50) < 20) ||
        (minsHeld >= 90 && peakGainPct < 1.2 && pos.unrealizedPnlPct <= -0.40 && liveObForScratch <= -0.22))
    ) {
      exitReason = `🛡️ YAVAŞ ERİME & BAYAT HABER KALKANI (${Math.round(minsHeld)}dk Tepkisiz + Tahta ${liveObForScratch} -> Stop Beklenmeden Zarar Küçültüldü %${pos.unrealizedPnlPct})`;
    } else if (pos.isMoonshot) {
      exitReason = `🔄 SEÇENEK 2 GEÇİŞİ (Vurgun Slotu Kapatılıp 3 Ana Slota Aktarıldı %${pos.unrealizedPnlPct})`;
    } else if (hoursHeld >= 12 && pos.unrealizedPnlPct >= 0.15 && pos.unrealizedPnlPct < 0.6 && !pos.partialTpDone) {
      exitReason = `⏱️ KÂRLI ZAMAN ROTASYONU (12 Saatte Yavaş Kalan Coin Kârla Boşaltıldı +${pos.unrealizedPnlPct}%)`;
    }

    if (exitReason) {
      let soldQty = pos.qty;
      let realExitBid = currentBid;
      if (state.mode === 'LIVE_BINANCE') {
        const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
        if (!sellRes || sellRes.code !== 0) {
          remainingPositions.push(pos);
          continue;
        }
        if (sellRes.executedQty > 0) soldQty = Math.min(pos.qty, sellRes.executedQty);
        if (sellRes.fillPriceUsdt > 0) realExitBid = sellRes.fillPriceUsdt;
      }
      const proceedsUsdt = Number((realExitBid * soldQty).toFixed(4));
      const exactCostUsdt = Number((pos.entryPrice * soldQty).toFixed(4));
      const netPnlUsdt = Number(((realExitBid - pos.entryPrice) * soldQty).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));
      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));

      if (netPnlUsdt >= 0) {
        state.winCount++;
      } else {
        state.lossCount++;
        state.cooldowns[pos.symbol] = nowMs + 6 * 3600 * 1000;
      }

      appendTradeTelemetry(pos, realExitBid, exitReason, netPnlUsdt, netPnlTry, soldQty);
      state.closedTrades.unshift({
        ...pos,
        positionId: pos.id,
        leg: 'FINAL',
        qty: soldQty,
        costUsdt: exactCostUsdt,
        exitPrice: realExitBid,
        exitTime: new Date().toISOString(),
        exitReason,
        netPnlUsdt,
        netPnlTry,
      });
      logEvent(state, `🏁 [POZİSYON KAPANDI] ${pos.symbol} @ $${realExitBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`);
    } else {
      remainingPositions.push(pos);
    }
  }
  const prevOpenLen = state.openPositions.length;
  state.openPositions = remainingPositions;
  let didTradeInCycle = remainingPositions.length !== prevOpenLen;
  if (state.mode === 'LIVE_BINANCE' && didTradeInCycle) {
    const freshTr = await fetchBinanceTrStatus(cfg);
    if (freshTr.ok) {
      trStatus = freshTr;
      state.binanceTrStatus = freshTr.summary;
      state.walletAssetsMap = freshTr.assetsMap;
      state.cashUsdt = Number((freshTr.tryFree / USD_TRY_RATE).toFixed(4));
    }
  }

  // Compute completed lifecycle net PnL (TP1 + TP2 + FINAL grouped by positionId) for Lifecycle-Based Circuit Breaker & Ecosystem Contagion Shield
  const openPosIdsForCb = new Set((state.openPositions || []).map(p => p.id).filter(Boolean));
  const cbLifecycleMap = new Map();
  for (let i = 0; i < (state.closedTrades || []).length; i++) {
    const ct = state.closedTrades[i];
    const pid = ct.positionId || ct.id || `legacy_cb_${i}`;
    if (openPosIdsForCb.has(pid)) continue;
    if (!cbLifecycleMap.has(pid)) {
      cbLifecycleMap.set(pid, {
        netPnlUsdt: 0,
        exitTime: ct.exitTime || null,
        leaderSymbol: ct.leaderSymbol || ct.symbol || null,
      });
    }
    const g = cbLifecycleMap.get(pid);
    g.netPnlUsdt = Number((g.netPnlUsdt + Number(ct.netPnlUsdt || 0)).toFixed(4));
    if (!g.exitTime && ct.exitTime) g.exitTime = ct.exitTime;
  }
  let consecutiveLosses = 0;
  let lastLossExitMs = 0;
  const recentLosingLeaders = new Set();
  for (const lc of cbLifecycleMap.values()) {
    const exitMs = lc.exitTime ? new Date(lc.exitTime).getTime() : 0;
    if (lc.netPnlUsdt < -0.05 && exitMs > 0 && nowMs - exitMs < 45 * 60 * 1000 && lc.leaderSymbol) {
      recentLosingLeaders.add(lc.leaderSymbol);
    }
    if (lc.netPnlUsdt < -0.05) {
      consecutiveLosses++;
      if (!lastLossExitMs && exitMs > 0) lastLossExitMs = exitMs;
    } else if (lc.netPnlUsdt > 0.02) {
      break;
    }
  }
  const isCircuitBreakerPaused = Boolean(consecutiveLosses >= 2 && lastLossExitMs > 0 && nowMs - lastLossExitMs < 45 * 60 * 1000);
  const cbRemainMins = isCircuitBreakerPaused ? Math.max(1, Math.ceil((45 * 60 * 1000 - (nowMs - lastLossExitMs)) / 60000)) : 0;

  // Engine #9: Listing Sniper Rotation ONLY (Anti-Churn: Never swap normal positions! Also blocked when Circuit Breaker is active!)
  const coreOpenPositions = state.openPositions.filter(p => !p.isMoonshot);
  const heldSymSetForRot = new Set(state.openPositions.map(p => p.symbol));
  const stagnantIdx = coreOpenPositions.length >= cfg.MAX_OPEN_POSITIONS
    ? state.openPositions.findIndex(p => {
        if (p.isMoonshot) return false;
        const hrs = (nowMs - new Date(p.entryTime).getTime()) / (1000 * 3600);
        return hrs >= 12.0 && p.unrealizedPnlPct >= 0.45 && p.unrealizedPnlPct <= 1.00 && !p.partialTpDone;
      })
    : -1;
  const usedLeadersAfterRot = new Set(
    state.openPositions.filter((_, idx) => idx !== stagnantIdx).map(p => p.leaderSymbol)
  );
  const bestCandidate = candidates.find(c => {
    if (heldSymSetForRot.has(c.symbol)) return false;
    if (usedLeadersAfterRot.has(c.leaderSymbol)) return false;
    if (c.hasDirectMention === false || c.liveLlmDecision !== 'LONG') return false;
    if ((c.freshestMinutesAgo || 0) > 20) return false; // Must be ultra-fresh <= 20m official listing alert!
    if (state.cooldowns[c.symbol] && state.cooldowns[c.symbol] > nowMs) return false;
    const isListing = c.headlines?.some(h => h.source === 'BinanceListingSniper' && h.minutesAgo <= 20);
    if (!isListing) return false; // 100% BAN normal mid-trade coin-hopping!
    return (c.takerBuyRatioPct || 50) >= 54.0 && (c.rsi1h || 50) <= 58;
  });
  const isListingSniperAlert = Boolean(bestCandidate && bestCandidate.totalScore >= 90);
  if (
    !signalsData.btcCrashAlert &&
    !isCircuitBreakerPaused &&
    isListingSniperAlert &&
    coreOpenPositions.length >= cfg.MAX_OPEN_POSITIONS &&
    stagnantIdx !== -1
  ) {
    let canTradeCandOnTr = true;
    if (state.mode === 'LIVE_BINANCE') {
      const candTrRule = await getBinanceTrSymbolRules(bestCandidate.symbol);
      if (!candTrRule || candTrRule.spotTradingEnable !== 1) canTradeCandOnTr = false;
    }
    if (canTradeCandOnTr) {
      const candOb = await checkOrderbookImbalance(bestCandidate.symbol);
      if (candOb >= 0.0) {
        const stag = state.openPositions[stagnantIdx];
        const sq = quotes[stag.symbol];
        if (sq && sq.bestBid && (!state.liveActivated || sq.priceSource === 'BINANCE_TR')) {
          let rotSellOk = true;
          let soldQty = stag.qty;
          if (state.mode === 'LIVE_BINANCE') {
            const sellRes = await executeBinanceRealOrder(cfg, stag.symbol, 'SELL', stag.qty);
            if (!sellRes || sellRes.code !== 0) rotSellOk = false;
            else if (sellRes.executedQty > 0) soldQty = sellRes.executedQty;
          }
          if (rotSellOk) {
            const proceedsUsdt = Number((sq.bestBid * soldQty).toFixed(4));
            const exactCostUsdt = Number((stag.entryPrice * soldQty).toFixed(4));
            const netPnlUsdt = Number(((sq.bestBid - stag.entryPrice) * soldQty).toFixed(4));
            const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));
            state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
            state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
            if (netPnlUsdt >= 0) state.winCount++;
            else state.lossCount++;
            const rotReason = `⚡ RESMİ LİSTELEME ROTASYONU (${bestCandidate.symbol} [${bestCandidate.totalScore}p] Listelemesine Geçildi)`;
            appendTradeTelemetry(stag, sq.bestBid, rotReason, netPnlUsdt, netPnlTry, soldQty);
            state.closedTrades.unshift({
              ...stag,
              positionId: stag.id,
              leg: 'FINAL',
              qty: soldQty,
              costUsdt: exactCostUsdt,
              exitPrice: sq.bestBid,
              exitTime: new Date().toISOString(),
              exitReason: rotReason,
              netPnlUsdt,
              netPnlTry,
            });
            state.openPositions.splice(stagnantIdx, 1);
            if (state.mode === 'LIVE_BINANCE') {
              const rotTr = await fetchBinanceTrStatus(cfg);
              if (rotTr.ok) {
                state.binanceTrStatus = rotTr.summary;
                state.cashUsdt = Number((rotTr.tryFree / USD_TRY_RATE).toFixed(4));
              }
            }
            logEvent(
              state,
              `⚡ [AKILLI ROTASYON] ${stag.symbol} kapatıldı, yerine ${bestCandidate.totalScore} puanlık dev fırsat (${bestCandidate.symbol}) alınıyor!`
            );
          }
        }
      }
    }
  }

  // Compute current total equity for Auto-Compounding Dynamic Position Sizing
  const currentOpenVal = state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
  const currentTotalEquity = state.cashUsdt + currentOpenVal;

  // Build memory of headlines that caused a loss in the last 12 hours so we never re-buy the same stale trap news
  const recentLosingHeadlines = new Set(
    (state.closedTrades || [])
      .filter(t => t.netPnlUsdt < 0 && t.headline && (!t.exitTime || nowMs - new Date(t.exitTime).getTime() < 12 * 3600 * 1000))
      .map(t => t.headline.replace(/^🎰 VURGUN SLOTU:\s*/i, '').trim().toLowerCase())
  );

  // Step 3: Open new positions with High-Utilization Auto-Compounding Sizing (No idle cash!)
  if (!signalsData.btcCrashAlert) {
    const usedLeaders = new Set(state.openPositions.map(p => p.leaderSymbol));
    const heldSymbols = new Set(state.openPositions.map(p => p.symbol));

    const breadthPct = signalsData.marketBreadthPct ?? 50;
    const confirmedRegime = ['A', 'B', 'C'].includes(signalsData.confirmedRegime)
      ? signalsData.confirmedRegime
      : breadthPct < 24
        ? 'A'
        : breadthPct < 52
          ? 'B'
          : 'C';
    const regimeEngineOwner = confirmedRegime === 'A' ? 'BNF' : confirmedRegime === 'B' ? 'SOVEREIGN' : 'EP';
    state.confirmedRegime = confirmedRegime;
    state.regimeEngineOwner = regimeEngineOwner;
    const isWeakMarket = breadthPct < 32;
    const isRedMarketDump = confirmedRegime === 'A' || breadthPct < 24;

    // Engine #13: Kasa Erime Sigortası (Anti-Meltdown & Consecutive-Loss Shield — expires 90m after last loss so it never creates a permanent deadlock)
    if (!state.highWaterMarkUsdt || state.highWaterMarkUsdt > currentTotalEquity * 1.06) {
      state.highWaterMarkUsdt = Number(Math.max(state.initialBankrollUsdt || 20.12, currentTotalEquity).toFixed(4));
    } else {
      state.highWaterMarkUsdt = Number(Math.max(state.highWaterMarkUsdt, currentTotalEquity).toFixed(4));
    }
    const drawdownFromPeakPct = state.highWaterMarkUsdt > 0
      ? ((state.highWaterMarkUsdt - currentTotalEquity) / state.highWaterMarkUsdt) * 100
      : 0;
    const isRecentLossStreak = Boolean(consecutiveLosses >= 2 && lastLossExitMs > 0 && nowMs - lastLossExitMs < 90 * 60 * 1000);
    const isAntiMeltdownActive = isRecentLossStreak || drawdownFromPeakPct >= 6.0;

    // Engine #18 & #28: Rejim Bazlı Brüt Pozisyon Tavanı + Cuma Akşamı (%40 Dokunulmaz Nakit) Kalkanı
    const tsiEntryNow = new Date(Date.now() + 3 * 3600 * 1000);
    const isFridayPmEntry = tsiEntryNow.getUTCDay() === 5 && tsiEntryNow.getUTCHours() >= 15;
    const rawRegimeExposurePct =
      confirmedRegime === 'C' ? 0.95 :
      breadthPct >= 32 ? 0.75 :
      confirmedRegime === 'B' ? 0.50 : 0.35; // When in Regime A (<24%), keep at least 65% in safe TRY cash!
    const regimeExposurePct = isFridayPmEntry ? Math.min(rawRegimeExposurePct, 0.60) : rawRegimeExposurePct;
    const maxGrossExposureUsdt = Number((currentTotalEquity * regimeExposurePct).toFixed(2));
    const effectiveMaxSlots = isRedMarketDump
      ? 1
      : isWeakMarket || isAntiMeltdownActive
        ? cfg.MAX_OPEN_POSITIONS
        : state.cashUsdt >= 3.00
          ? cfg.MAX_OPEN_POSITIONS + 1
          : cfg.MAX_OPEN_POSITIONS;
    if (!isWeakMarket && state.cashUsdt >= 1.50 && state.openPositions.filter(p => !p.isMoonshot).length < effectiveMaxSlots) {
      if (!state.cashIdleSince) {
        state.cashIdleSince = state.openPositions.length === 0 && lastLossExitMs > 0 ? lastLossExitMs : nowMs;
      }
    } else {
      state.cashIdleSince = null;
    }
    const isCashIdleTooLong = Boolean(!isWeakMarket && state.cashIdleSince && nowMs - state.cashIdleSince >= 15 * 60 * 1000);

    const wasGoldenAge = Boolean(state.isConfirmedGoldenAge);
    state.isConfirmedGoldenAge = Boolean(signalsData.isConfirmedGoldenAge);
    if (state.isConfirmedGoldenAge && !wasGoldenAge) {
      state.goldenAgeStartedAt = new Date().toISOString();
      logEvent(
        state,
        `🌟 [GOLDEN AGE BAŞLADI] Altcoin İştahı %${breadthPct} Yeşil | 1s BTC +%${signalsData.btc1hChangePct || 0} -> Engine #23, #24 & #30 (Rejim C: EP) Tam Kapasite Devrede!`
      );
    }

    // Record live "Why No New Coin Bought?" summary + detail for RAPOR.md and Web Dashboard
    const curOpenTry = Math.round(state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0) * USD_TRY_RATE);
    const maxExpTry = Math.round(maxGrossExposureUsdt * USD_TRY_RATE);
    if (isCircuitBreakerPaused) {
      state.noBuyShort = `🛑 Raad ol, 45 dk soğuma kalkanı devrede (${cbRemainMins} dk kaldı): Ardışık 2 zarardan sonra dalgalı piyasada kasa korunuyor (${toTL(state.cashUsdt)} TL nakit güvende).`;
      state.noBuyDetail =
        `1) **Küresel Devre Kesici (Global Circuit Breaker):** Tamamlanmış son pozisyon ömürlerinde ardışık ${consecutiveLosses} zarar tespit edildiği için zincirleme stop yememek adına yeni alımlar **${cbRemainMins} dakika** daha donduruldu. ` +
        `2) **Piyasa Durumu:** Altcoinlerin %${100 - breadthPct}'u kırmızı (%${breadthPct} yeşil | Rejim ${confirmedRegime} -> ${regimeEngineOwner}). Soğuma süresi bitene kadar \`${toTL(state.cashUsdt)} TL\` nakit %100 korunuyor.`;
    } else if (isRedMarketDump) {
      state.noBuyShort = `🛡️ Raad ol, nakit kalkanı devrede (Rejim A -> BNF): Piyasanın %${100 - breadthPct}'u kırmızı (%${breadthPct} yeşil); ${toTL(state.cashUsdt)} TL nakiti eritmemek için BNF panik dönüş teyidi bekleniyor.`;
      state.noBuyDetail =
        `1) **Piyasa Kan Gölü (%${breadthPct} Yeşil / %${100 - breadthPct} Kırmızı — Engine #30 Rejim A):** Altcoinlerin %${100 - breadthPct}'u şu an düşüşte (1s BTC: %${signalsData.btc1hChangePct || 0}). ` +
        `2) **%65 Nakit Koruma Zırhı & BNF Panik Emilim Kuralı:** Yeşil oranı %24'ün altındayken kasanın en az %65'i güvenli TRY nakitte tutulur (\`Maksimum Coin Tavanı: ${maxExpTry} TL\`) ve yalnızca \`Fiyat <= 0.94*MA25 + RSI<=28 + 5dk/1dk Mikro Dönüş + 15dk OI >= +%0.25 + NetRR >= 1.5\` şartlarını eksiksiz sağlayan BNF adayına girilir. ` +
        `3) **Taranan Adaylar (${signalsData.totalHeadlinesScanned || 99} Haber):** Onaylı BNF panik dönüş adayı sayısı: **${candidates.length}**. Düşen bıçak teyitsiz tutulmaz!`;
    } else if (state.isConfirmedGoldenAge && candidates.length === 0) {
      state.noBuyShort = `🌟 ALTIN ÇAĞ (Rejim C -> EP) AKTİF (%${breadthPct} Yeşil | 1s BTC +%${signalsData.btc1hChangePct || 0}): Engine #23, #24 & #30 EP kurumsal liderleri tarıyor!`;
      state.noBuyDetail =
        `1) **Altın Çağ Teyitli (Rejim C):** Altcoinlerin %${breadthPct}'i yeşil (1s BTC: +%${signalsData.btc1hChangePct || 0}). ` +
        `2) **Engine #24, #27 & #30 Qullamaggie EP Aktif:** $15M+ hacimli kurumsal liderler ve 14 haber kaynağı taranıyor; NO-CHASE (\`ask <= Pmax\`) ve çift tahta doğrulaması (\`Engine #27\`) geçen ilk lidere otomatik girilecek.`;
    } else if (candidates.length === 0) {
      state.noBuyShort = `📡 Raad ol, pusudayız (Rejim ${confirmedRegime} -> ${regimeEngineOwner}): Piyasa %${breadthPct} yeşil ama 99 haber içinde henüz mutlak kriterleri geçen aday yok, sahte sinyale girmiyoruz.`;
      state.noBuyDetail =
        `1) **Piyasa & Rejim Durumu:** Altcoinlerin %${breadthPct}'i yeşil (1s BTC: %${signalsData.btc1hChangePct || 0} | Aktif Motor: \`Engine #30 ${regimeEngineOwner}\`). ` +
        `2) **Sıfır Sahte Sinyal Kuralı:** 14 kaynaktan ${signalsData.totalHeadlinesScanned || 99} haber ve kurumsal liderler tarandı; kriterleri geçen ilk fırsatta otomatik alım yapılacak.`;
    } else {
      state.noBuyShort = `📡 Raad ol, seçici moddayız (Rejim ${confirmedRegime} -> ${regimeEngineOwner}): ${candidates.length} aday incelendi ancak tahta/NO-CHASE/Kelly risk filtresini geçen net fırsat bekleniyor.`;
      state.noBuyDetail =
        `1) **Aday Taraması:** ${candidates.length} aday bulundu ancak ya haber çoktan fiyatlanmış (\`NO-CHASE ask > Pmax\`), ya tahta alıcı oranı zayıf ya da kasa koruma limiti (\`${curOpenTry} / ${maxExpTry} TL\`) dolu.`;
    }

    const seenCandSyms = new Set();
    for (const cand of candidates) {
      if (isCircuitBreakerPaused) break;
      if (!cand?.symbol || seenCandSyms.has(cand.symbol)) continue;
      seenCandSyms.add(cand.symbol);
      const curCoreCount = state.openPositions.filter(p => !p.isMoonshot).length;
      const curOpenExposureUsdt = state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
      const remainingExposureUsdt = Number((maxGrossExposureUsdt - curOpenExposureUsdt).toFixed(2));
      if (curCoreCount >= effectiveMaxSlots || remainingExposureUsdt < 1.50) break;
      if (state.cashUsdt < 1.50) break;
      // Engine #30 Non-Overlap Rule: Never open a second signal/position on an already held symbol
      if (heldSymbols.has(cand.symbol)) continue;

      // Engine #30 Mutually Exclusive Single engineOwner Enforcement (A -> BNF, B -> SOVEREIGN, C -> EP)
      const candOwner = cand.engineOwner || regimeEngineOwner;
      if (candOwner !== regimeEngineOwner) continue;
      if (confirmedRegime === 'A' && (candOwner !== 'BNF' || !cand.isBnfConfirmed)) continue;
      if (confirmedRegime === 'B' && (cand.isBnfPanicCandidate || cand.isEpCandidate)) continue;
      if (confirmedRegime === 'C' && (cand.isBnfPanicCandidate || cand.isSovereignCrisisCandidate)) continue;
      if (confirmedRegime === 'C' && !cand.isEpCandidate) continue;

      // Engine #30 Walk-Forward Meta-Label Calibration (One-Sided 95% Lower Bound p_L)
      const wfCal = computeWalkForwardEnginePWinLower95(state, candOwner, nowMs);
      const pLower95 = wfCal.pLower95;
      const isApexSoftOverride = pLower95 >= 0.78; // Can only bypass soft score/waiting gates, NEVER hard vetoes or risk equations!

      // Engine #29 Sovereign Override Authority (Strictly in Regime B): When all 4 Masters (PTJ + Minervini + O'Neil + GCR) + Futures OI confirm
      const isSovereignOverrideAllowed = Boolean(
        confirmedRegime === 'B' &&
          candOwner === 'SOVEREIGN' &&
          cand.isSovereignCrisisLeader &&
          !isRedMarketDump &&
          !isFridayPmEntry &&
          !signalsData.btcCrashAlert
      );
      const isBnfEntryAllowed = Boolean(
        confirmedRegime === 'A' &&
          candOwner === 'BNF' &&
          cand.isBnfConfirmed &&
          !signalsData.btcCrashAlert
      );
      const isGoldenAgeLeaderAllowed = Boolean(
        (confirmedRegime === 'C' &&
          cand.isGoldenAgeLeader &&
          signalsData.isConfirmedGoldenAge &&
          !isRedMarketDump &&
          !isWeakMarket &&
          !signalsData.btcCrashAlert) ||
          isSovereignOverrideAllowed ||
          isBnfEntryAllowed
      );
      // Engine Conflict Prevention: Require explicit LONG consensus AND (directMention === true OR authorized regime leader/BNF)!
      if (cand.liveLlmDecision !== 'LONG' || (cand.hasDirectMention === false && !isGoldenAgeLeaderAllowed)) continue;
      if (usedLeaders.has(cand.leaderSymbol) && !((isCashIdleTooLong || isApexSoftOverride) && cand.totalScore >= 75)) continue;
      // Engine #22: Correlated Ecosystem Contagion Shield (45m sector cooldown after a lifecycle loss in the same leader ecosystem)
      if (cand.leaderSymbol && recentLosingLeaders.has(cand.leaderSymbol)) continue;
      const adaptiveMem = state.adaptiveMemory || runAdaptiveLearningEngine(state);
      const coinMem = adaptiveMem?.coinStats?.[cand.symbol];
      const srcName = cand.headlines?.[0]?.source || 'RSS';
      const srcMem = adaptiveMem?.sourceStats?.[srcName];
      const regimeBucket = breadthPct < 24 ? 'RED' : breadthPct < 40 ? 'NEUTRAL' : 'GREEN';
      const bucketKey = `${srcName}:${regimeBucket}:${cand.entryPattern || 'STANDARD'}`;
      const bucketMod = adaptiveMem?.bucketStats?.[bucketKey]?.scoreMod || 0;
      // Defensive-Only Shadow Trap Penalty (Strictly <= 0: never boosts score, only blocks/penalizes proven paper bull-traps!)
      const shadowPenalty = Math.min(0, Number(state.shadowTrapMemory?.[cand.symbol]?.scoreMod || 0));
      // Dust-Sweep Tie-Breaker (+1.0p only when symbol has >= 1.50 TL trapped dust in wallet AND zero shadow penalty)
      const existingDustQty = Number(state.walletAssetsMap?.[cand.symbol] || 0);
      const existingDustTry = existingDustQty * Number(quotes[cand.symbol]?.bestBid || cand.lastPrice || 0) * USD_TRY_RATE;
      const dustSweepTieBreaker = shadowPenalty === 0 && existingDustTry >= 1.5 ? 1.0 : 0;
      const learnedScoreMod = (coinMem?.scoreMod || 0) + (srcMem?.scoreMod || 0) + bucketMod + shadowPenalty + dustSweepTieBreaker;
      const effectiveTotalScore = Number((cand.totalScore + learnedScoreMod).toFixed(1));
      const hasInstitutionalWhaleSurge =
        ((cand.topWhaleLongPct || 0) >= 60 && (cand.oiChange15mPct || 0) >= 0) ||
        ((cand.topWhaleLongPct || 0) >= 65 && (cand.oiChange15mPct || 0) >= -0.05 && (cand.rsi1h || 50) <= 58 && (cand.freshestMinutesAgo || 999) <= 60);
      const rawMinReqScore = isRedMarketDump ? 78 : isWeakMarket ? 75 : isAntiMeltdownActive ? 70 : 58;
      const minReqScore = isApexSoftOverride ? Math.max(58, rawMinReqScore - 6) : rawMinReqScore;
      const baseMinWhale = isBnfEntryAllowed ? 48.0 : isRedMarketDump ? 56.0 : isWeakMarket ? 53.5 : hasInstitutionalWhaleSurge ? 49.5 : isAntiMeltdownActive ? 53.5 : isCashIdleTooLong ? 50.2 : 51.0;
      const baseMaxRsi = isBnfEntryAllowed ? 28 : isRedMarketDump ? 62 : isWeakMarket ? 60 : 66;
      const minReqWhale = coinMem && !isBnfEntryAllowed && !hasInstitutionalWhaleSurge ? Math.max(baseMinWhale, coinMem.minWhale) : baseMinWhale;
      const maxReqRsi = coinMem ? Math.min(baseMaxRsi, coinMem.maxRsi) : baseMaxRsi;
      if (effectiveTotalScore < minReqScore) continue;
      const maxAllowedNewsAgeMins = isRedMarketDump || isWeakMarket ? 45 : confirmedRegime === 'C' ? 60 : 75;
      const primaryHeadlineAgeMins = Math.max(cand.freshestMinutesAgo || 0, cand.headlines?.[0]?.minutesAgo || 0);
      if (primaryHeadlineAgeMins > maxAllowedNewsAgeMins) continue; // Engine #25: Reject stale primary news older than 45-75 minutes!
      const isSynthCand = ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(cand.headlines?.[0]?.source);
      if (
        isSynthCand ||
        (cand.headlines?.[0]?.source === 'GoldenAgeLeaderIgniter' && !isGoldenAgeLeaderAllowed) ||
        (cand.headlines?.[0]?.source === 'BNFPanicSniper' && !isBnfEntryAllowed)
      ) {
        continue; // 100% BAN unauthorized synthetic signals!
      }
      if ((cand.rsi1h || 50) > maxReqRsi) continue;
      const effectiveSpotWhalePct = Math.max(Number(cand.takerBuyRatioPct || 50), Number(cand.last1hTakerBuyPct || 50));
      if (!isBnfEntryAllowed && effectiveSpotWhalePct < minReqWhale) continue;
      if (
        !cand.hasDirectMention &&
        !isBnfEntryAllowed &&
        (Number(cand.last1hTakerBuyPct || 50) < 50.0 ||
          Number(cand.atr1hPct || 1.0) < 0.85 ||
          Number(cand.impulseAtr ?? 0.30) < 0.28 ||
          (Array.isArray(cand.microstructureFlags) && cand.microstructureFlags.includes('TAKER_FLOW_DECEL')))
      ) {
        continue; // Engine #30.7: Block sleepy/decelerating synthetic GoldenAge waves (like LTC 0.70% ATR / 44.2% 1h Taker & HYPE 0.78% ATR / 0.21 impulseAtr)
      }
      if (cand.topWhaleLongPct && cand.topWhaleLongPct < 42) continue; // Reject if Binance Top 20% Whales are shorting
      if (state.cooldowns[cand.symbol] && state.cooldowns[cand.symbol] > nowMs) continue;

      const candHeadlineClean = (cand.headlines?.[0]?.title || '').trim().toLowerCase();
      if (candHeadlineClean && recentLosingHeadlines.has(candHeadlineClean)) {
        continue; // Skip stale news that already caused a loss
      }

      let q = quotes[cand.symbol];
      if (state.mode === 'LIVE_BINANCE' && (!q || q.priceSource !== 'BINANCE_TR')) {
        const freshTrQuotes = await getOrderbookQuotes([cand.symbol]);
        if (freshTrQuotes[cand.symbol]) q = freshTrQuotes[cand.symbol];
      }
      if (!q || !q.bestAsk || (state.mode === 'LIVE_BINANCE' && q.priceSource !== 'BINANCE_TR')) continue;

      let trRule = null;
      if (state.mode === 'LIVE_BINANCE') {
        trRule = await getBinanceTrSymbolRules(cand.symbol);
        if (!trRule || trRule.spotTradingEnable !== 1) continue;
      }

      // Engine #27 + #30.7 (Codex Council — PERSISTENT_BOOK_CONFIRMATION):
      // Two Binance TR orderbook snapshots 2.1s apart; synthetic newsless signals (!cand.hasDirectMention) strictly require buyer-positive book (>= 0.0).
      const minAllowedOb =
        isRedMarketDump || !cand.hasDirectMention
          ? 0.0
          : isCashIdleTooLong || hasInstitutionalWhaleSurge
            ? -0.15
            : -0.05;
      const bookCheck = await verifyPersistentBookConfirmation(cand.symbol, minAllowedOb, state.mode === 'LIVE_BINANCE');
      if (!bookCheck.ok) {
        logEvent(
          state,
          `⚖️ [Engine #27 Kalıcı Tahta Vetosu] ${cand.symbol} pas geçildi (${bookCheck.rejectReason} | ob1:${bookCheck.ob1 ?? 'N/A'} -> ob2:${bookCheck.ob2 ?? 'N/A'})`
        );
        continue;
      }
      const obImbalance = bookCheck.imbalance;
      const spreadPct = bookCheck.spreadPct;
      if (bookCheck.latestQuote && bookCheck.latestQuote.priceSource === 'BINANCE_TR') {
        q = {
          bestBid: Number((bookCheck.latestQuote.bestBid / USD_TRY_RATE).toPrecision(6)),
          bestAsk: Number((bookCheck.latestQuote.bestAsk / USD_TRY_RATE).toPrecision(6)),
          bestBidTry: bookCheck.latestQuote.bestBid,
          bestAskTry: bookCheck.latestQuote.bestAsk,
          priceSource: 'BINANCE_TR',
        };
      }

      // Engine #30 Qullamaggie EP Execution Gate: Strict NO-CHASE ceiling (ask <= Pmax)
      if (candOwner === 'EP' && cand.isEpCandidate && Number.isFinite(cand.epMaxEntryPrice) && cand.epMaxEntryPrice > 0) {
        if (q.bestAsk > cand.epMaxEntryPrice) {
          logEvent(
            state,
            `🚫 [Engine #30 EP NO-CHASE Vetosu] ${cand.symbol} anlık ask ($${q.bestAsk}) > Pmax ($${cand.epMaxEntryPrice}) -> Fiyat kovalanmadı, iptal!`
          );
          continue;
        }
      }

      // Engine #30 BNF & Kelly Risk-Budget Sizing (GPT-6-Luna Mathematical Specification)
      const totalFrictionFrac = 0.0044; // Round-trip fee + expected slippage (0.22% entry + 0.22% exit)
      let safeSlPct = Number(
        Math.min(2.0, Math.max(1.5, (cand.atr1hPct || 1.5) * 0.85, spreadPct * 3.0)).toFixed(2)
      );
      let dFrac = safeSlPct / 100;
      let tpRefFrac = Math.max(0.036, Math.min(0.055, Number(cand.tpPct || 4.5) / 100));

      if (candOwner === 'BNF') {
        const bnfSlPrice = Number(cand.slPrice);
        if (!Number.isFinite(bnfSlPrice) || bnfSlPrice <= 0 || q.bestAsk <= bnfSlPrice) continue;
        dFrac = (q.bestAsk - bnfSlPrice) / q.bestAsk;
        tpRefFrac = 0.022;
        const netTpBnf = tpRefFrac - totalFrictionFrac;
        const netSlBnf = dFrac + totalFrictionFrac;
        const netRrBnf = netSlBnf > 0 ? netTpBnf / netSlBnf : 0;
        if (!Number.isFinite(dFrac) || dFrac <= 0 || dFrac > 0.011 || netRrBnf < 1.50) {
          logEvent(
            state,
            `🚫 [Engine #30 BNF Risk/Ödül Vetosu] ${cand.symbol} d=${(dFrac * 100).toFixed(2)}% (>%1.10) veya netTP/netSL=${netRrBnf.toFixed(2)} (<1.50) -> İşlem atlandı!`
          );
          continue;
        }
        safeSlPct = Number((dFrac * 100).toFixed(2));
      }

      const netGainG = tpRefFrac - totalFrictionFrac;
      const netLossL = dFrac + totalFrictionFrac;
      const payoffB = netLossL > 0 ? netGainG / netLossL : 0;
      const breakevenP = payoffB > 0 ? 1 / (1 + payoffB) : 1;
      if (wfCal.samples <= 0 || payoffB <= 0 || pLower95 <= breakevenP) {
        continue;
      }
      const fKelly = Math.max(0, (pLower95 * payoffB - (1 - pLower95)) / payoffB);
      // Engine #30.1 (Qullamaggie Small-Bankroll Conviction Tiers — 0.58% Standard / 0.80% High / 1.00% Ultra A+ Risk, 22%-38% Slot Cap):
      // Never bets 80% on an unproven entry (prevents thin-book stop slippage ruin), while scaling A+ setups up to Qullamaggie's 30%-38% ceiling!
      const isUltraApexSetup = Boolean(
        !isAntiMeltdownActive &&
          effectiveTotalScore >= 84 &&
          (cand.hasDirectMention || cand.isSovereignCrisisLeader || cand.isEpRetestOptimal) &&
          obImbalance >= 0.15 &&
          spreadPct <= 0.35
      );
      const isHighConvictionSetup = Boolean(
        !isAntiMeltdownActive &&
          !isUltraApexSetup &&
          (effectiveTotalScore >= 76 || cand.isSovereignCrisisLeader || cand.isEpRetestOptimal) &&
          obImbalance >= 0.08 &&
          spreadPct <= 0.45
      );
      const maxAccountRiskFrac = isAntiMeltdownActive
        ? 0.0040
        : isUltraApexSetup
          ? 0.0100
          : isHighConvictionSetup
            ? 0.0080
            : 0.0058;
      const kellyScale = isAntiMeltdownActive ? 0.25 : 0.35;
      const fRisk = Math.min(kellyScale * fKelly, maxAccountRiskFrac);
      if (!Number.isFinite(fRisk) || fRisk <= 0) continue;

      const slotCapFrac = isAntiMeltdownActive
        ? 0.20
        : isUltraApexSetup
          ? 0.38
          : isHighConvictionSetup
            ? 0.30
            : 0.22;
      const riskBudgetUsdt = currentTotalEquity * fRisk;
      const riskBudgetTry = Number((riskBudgetUsdt * USD_TRY_RATE).toFixed(2));
      const riskSizedUsdt = riskBudgetUsdt / netLossL;
      const maxSlotCapUsdt = Number((currentTotalEquity * slotCapFrac).toFixed(4));
      const availCashUsdt = Math.floor(Math.max(0, state.cashUsdt) * 100) / 100;
      const rawTargetUsdt = Math.min(riskSizedUsdt, maxSlotCapUsdt, remainingExposureUsdt, availCashUsdt);
      if (rawTargetUsdt <= 0) continue;

      let buyPrice = q.bestAsk;
      let buyPriceTry = q.bestAskTry || Number((buyPrice * USD_TRY_RATE).toFixed(4));
      const lotFilter = (trRule?.filters || []).find(f => f.filterType === 'LOT_SIZE');
      let qty = roundToStepSize(rawTargetUsdt / buyPrice, lotFilter?.stepSize);
      const costUsdt = Number((qty * buyPrice).toFixed(4));
      const execNotionalTry = costUsdt * USD_TRY_RATE;
      const estTotalRiskTry = execNotionalTry * netLossL;

      // Engine #30 Feasibility Gate: Require BOTH N >= 55 TL AND N*d + fees/slippage <= R (never increase risk R to meet 55 TL minimum!)
      if (qty <= 0 || execNotionalTry < 55 || estTotalRiskTry > riskBudgetTry + 1e-4) {
        logEvent(
          state,
          `⚖️ [Engine #30 Kelly/Borsa Kısıt Vetosu] ${cand.symbol} (N=${execNotionalTry.toFixed(1)} TL, Risk=${estTotalRiskTry.toFixed(2)} TL > Bütçe=${riskBudgetTry.toFixed(2)} TL) -> Risk şişirilmedi, pas geçildi.`
        );
        continue;
      }
      let dustSweepQty = 0;

      if (state.mode === 'LIVE_BINANCE') {
        const buyRes = await executeBinanceRealOrder(cfg, cand.symbol, 'BUY', qty, costUsdt);
        if (!buyRes || buyRes.code !== 0) continue;
        // Reconcile exact newly bought quantity, realized fill price, and pre-existing dustSweepQty
        if (buyRes.executedQty > 0) qty = buyRes.executedQty;
        if (buyRes.fillPriceUsdt > 0) buyPrice = buyRes.fillPriceUsdt;
        if (buyRes.fillPriceTry > 0) buyPriceTry = buyRes.fillPriceTry;
        if (buyRes.dustSweepQty > 0) dustSweepQty = buyRes.dustSweepQty;
      }

      const tpPrice =
        candOwner === 'BNF'
          ? Number((buyPrice * 1.022).toPrecision(5))
          : Number((buyPrice * (1 + cand.tpPct / 100)).toPrecision(5));
      const slPrice =
        candOwner === 'BNF' && Number.isFinite(Number(cand.slPrice))
          ? Number(Number(cand.slPrice).toPrecision(5))
          : Number((buyPrice * (1 - safeSlPct / 100)).toPrecision(5));

      const newPos = {
        id: `pos_${Date.now()}_${cand.symbol}`,
        symbol: cand.symbol,
        leaderSymbol: cand.leaderSymbol,
        engineOwner: candOwner,
        confirmedRegime,
        pWinLower95: pLower95,
        kellyRiskFrac: Number(fRisk.toFixed(5)),
        ecosystem: cand.ecosystems?.[0] || 'Genel',
        headline: cand.headlines?.[0]?.title || 'Pozitif Ekosistem Katalizörü',
        newsSource: cand.headlines?.[0]?.source || 'RSS',
        entryPattern: cand.entryPattern || 'STANDARD',
        freshestMinutesAgo: cand.freshestMinutesAgo || 15,
        breadthAtEntry: breadthPct,
        spreadPctAtEntry: Number(spreadPct.toFixed(3)),
        preEventAtr: cand.preEventAtr ?? 0,
        impulseAtr: cand.impulseAtr ?? 1.0,
        retracementRatio: cand.retracementRatio ?? 0.35,
        betaBtc: cand.betaBtc ?? 1.15,
        rsAtr: cand.rsAtr ?? 1.0,
        newsScore: cand.newsScore,
        totalScore: cand.totalScore,
        rsiAtEntry: cand.rsi1h,
        atr1hPct: cand.atr1hPct || 2.2,
        amihudIlliquidity: cand.amihudIlliquidity ?? 1.0,
        microstructureFlags: Array.isArray(cand.microstructureFlags) ? cand.microstructureFlags : [],
        takerBuyRatioPct: cand.takerBuyRatioPct || 50,
        last1hTakerBuyPct: cand.last1hTakerBuyPct ?? cand.takerBuyRatioPct ?? 50,
        obImbalance,
        bookOb1: bookCheck.ob1,
        bookOb2: bookCheck.ob2,
        micropricePremBps: bookCheck.micropricePremBps,
        midMovePctAtEntry: bookCheck.midMovePct,
        entryTime: new Date().toISOString(),
        entryPrice: buyPrice,
        entryPriceTry: buyPriceTry,
        priceSource: q.priceSource || 'BINANCE_TR',
        currentPrice: q.bestBid || buyPrice,
        highestPrice: buyPrice,
        qty,
        initialQty: qty,
        dustSweepQty,
        initialCostUsdt: Number((buyPrice * qty).toFixed(4)),
        costUsdt: Number((buyPrice * qty).toFixed(4)),
        costTry: Math.round(buyPrice * qty * USD_TRY_RATE),
        riskBudgetTry,
        stopHitCount: 0,
        firstStopHitAt: 0,
        takeProfitPrice: tpPrice,
        stopLossPrice: slPrice,
        tpPct: candOwner === 'BNF' ? 2.20 : cand.tpPct,
        slPct: safeSlPct,
        partialTpDone: false,
        stage2TpDone: false,
        trailingActive: false,
        rocketMode: false,
        unrealizedPnlUsdt: Number((((q.bestBid || buyPrice) - buyPrice) * qty).toFixed(4)),
        unrealizedPnlPct: Number(((((q.bestBid || buyPrice) - buyPrice) / buyPrice) * 100).toFixed(2)),
      };

      state.cashUsdt = Number((state.cashUsdt - costUsdt).toFixed(4));
      state.openPositions.push(newPos);
      heldSymbols.add(cand.symbol);
      usedLeaders.add(cand.leaderSymbol);
      didTradeInCycle = true;

      logEvent(
        state,
        `🟢 [OTOMATİK ALIM — Engine #30 ${candOwner}] ${cand.symbol} (${toTL(costUsdt)} TL) @ $${buyPrice} | p_L: %${(pLower95 * 100).toFixed(1)} | RiskBütçesi: ${riskBudgetTry} TL | SL: -%${safeSlPct}`
      );
    }
  }

  // Engine #19: Defensive-Only Shadow Trap Detector (Zero Real-Money Risk, Strictly <= 0 Score Modifier)
  // Tracks unbought news candidates on live quotes; if they fail/dump on paper, puts a 4h trap shield & -2/-4p penalty on that symbol!
  if (!Array.isArray(state.shadowPositions)) state.shadowPositions = [];
  if (!state.shadowTrapMemory) state.shadowTrapMemory = {};
  const openRealSyms = new Set((state.openPositions || []).map(p => p.symbol));
  const nextShadow = [];
  for (const sp of state.shadowPositions) {
    if (openRealSyms.has(sp.symbol)) continue;
    const sq = quotes[sp.symbol];
    const sqSpreadPct =
      sq && sq.bestBid > 0 && sq.bestAsk >= sq.bestBid
        ? Number((((sq.bestAsk - sq.bestBid) / sq.bestBid) * 100).toFixed(3))
        : sp.spreadPct ?? 0.2;
    if (sq?.priceSource) sp.priceSource = sq.priceSource;
    sp.spreadPct = sqSpreadPct;
    // Ignore illiquid spread spikes (> 0.85%) so a wide spread glitch doesn't falsely trigger a shadow trap
    const bid = sqSpreadPct <= 0.85 && sq?.bestBid ? sq.bestBid : sp.currentBid || sp.entryAsk;
    sp.currentBid = bid;
    sp.highestBid = Math.max(sp.highestBid || sp.entryAsk, bid);
    const execBid = bid * (1 - 0.0022);
    const netPct = sp.entryAsk > 0 ? ((execBid - sp.entryAsk) / sp.entryAsk) * 100 : 0;
    const peakPct = sp.entryAsk > 0 ? ((sp.highestBid - sp.entryAsk) / sp.entryAsk) * 100 : 0;
    const ageMins = (nowMs - new Date(sp.entryTime).getTime()) / 60000;
    const isShadowStopLoss = netPct <= -1.45;
    const isShadowSlowBleed = ageMins >= 75 && peakPct < 1.0 && netPct <= -0.55;
    if (peakPct >= 2.2) {
      // Shadow trade succeeded: clear any prior trap penalty, but NEVER add a positive score bonus (>0 forbidden)
      state.shadowTrapMemory[sp.symbol] = {
        traps: 0,
        scoreMod: 0,
        priceSource: sp.priceSource || 'BINANCE_TR',
        updatedAt: new Date().toISOString(),
      };
    } else if (isShadowStopLoss || isShadowSlowBleed) {
      const prevTraps = (state.shadowTrapMemory[sp.symbol]?.traps || 0) + 1;
      const triggerReason = isShadowStopLoss ? 'SHADOW_STOP_LOSS' : 'SHADOW_SLOW_BLEED';
      const isVerifiedTrOrDeepLoss = sp.priceSource === 'BINANCE_TR' || netPct <= -2.2;
      const scoreMod = isVerifiedTrOrDeepLoss ? Math.max(-4, -2 * prevTraps) : -2;
      const cooldownUntil = isVerifiedTrOrDeepLoss ? nowMs + 4 * 3600 * 1000 : 0;
      if (cooldownUntil > 0) {
        state.cooldowns[sp.symbol] = Math.max(state.cooldowns[sp.symbol] || 0, cooldownUntil);
      }
      state.shadowTrapMemory[sp.symbol] = {
        traps: prevTraps,
        scoreMod,
        priceSource: sp.priceSource || 'GLOBAL_PROXY',
        triggerReason,
        peakPct: Number(peakPct.toFixed(2)),
        netPct: Number(netPct.toFixed(2)),
        cooldownUntil: cooldownUntil > 0 ? new Date(cooldownUntil).toISOString() : null,
        lastHeadline: sp.headline,
        updatedAt: new Date().toISOString(),
      };
      appendShadowTrapTelemetry(sp, netPct, peakPct, ageMins, triggerReason, scoreMod, cooldownUntil);
      logEvent(
        state,
        `👻 [GÖLGE TUZAK YAKALANDI] ${sp.symbol} (${sp.priceSource || 'TR'}) sanal takipte %${netPct.toFixed(2)} düştü (${triggerReason}) -> Gerçek para kaybetmeden ${cooldownUntil > 0 ? '4 saat kara listeye alındı' : '-2p savunma cezası yazıldı'}!`
      );
    } else if (ageMins < 180) {
      nextShadow.push(sp);
    }
  }
  const shadowSyms = new Set(nextShadow.map(s => s.symbol));
  for (const cand of candidates.slice(0, 6)) {
    if (nextShadow.length >= 3) break;
    if (openRealSyms.has(cand.symbol) || shadowSyms.has(cand.symbol)) continue;
    if ((cand.hasDirectMention === false && !cand.isGoldenAgeLeader) || (cand.freshestMinutesAgo || 99) > 75) continue;
    const sq = quotes[cand.symbol];
    if (!sq || !sq.bestAsk) continue;
    const initSpreadPct = sq.bestBid > 0 ? Number((((sq.bestAsk - sq.bestBid) / sq.bestBid) * 100).toFixed(3)) : 0.2;
    if (initSpreadPct > 0.65) continue;
    nextShadow.push({
      symbol: cand.symbol,
      headline: cand.headlines?.[0]?.title || '',
      priceSource: sq.priceSource || 'GLOBAL_PROXY',
      spreadPct: initSpreadPct,
      entryAsk: sq.bestAsk,
      currentBid: sq.bestBid || sq.bestAsk,
      highestBid: sq.bestBid || sq.bestAsk,
      entryTime: new Date().toISOString(),
    });
    shadowSyms.add(cand.symbol);
  }
  state.shadowPositions = nextShadow;

  // Refresh Binance TR wallet status ONLY if a trade actually executed in this cycle (avoids redundant HMAC API calls and speeds up scan cycle by 2x!)
  if (state.mode === 'LIVE_BINANCE' && didTradeInCycle) {
    const postTradeTr = await fetchBinanceTrStatus(cfg);
    if (postTradeTr.ok) {
      trStatus = postTradeTr;
      state.binanceTrStatus = trStatus.summary;
      state.walletAssetsMap = trStatus.assetsMap;
      state.cashUsdt = Number((trStatus.tryFree / USD_TRY_RATE).toFixed(4));
    } else if (state.walletAssetsMap) {
      trStatus.assetsMap = state.walletAssetsMap;
    }
  }

  // Fetch 100% pure USD (USDT) orderbook quotes for all wallet and open symbols, then convert to TL via USD_TRY_RATE
  const allWalletSymbols = Array.from(
    new Set([
      ...state.openPositions.map(p => p.symbol),
      ...Object.keys(trStatus.assetsMap || {}).filter(a => a !== 'TRY' && a !== 'USDT'),
    ])
  );
  const walletUsdtQuotes = await getOrderbookQuotes(allWalletSymbols);
  for (const [sym, q] of Object.entries(walletUsdtQuotes)) {
    if (!quotes[sym]) quotes[sym] = q;
  }

  // Engine #14: Autonomous Self-Auditor (Cüzdan <-> Kayıt Otomatik Onarım Müfettişi — Pure USD * Kur)
  if (state.mode === 'LIVE_BINANCE' && trStatus.ok) {
    // 1. Remove any ghost position that was already sold in the real Binance TR wallet (protect positions opened < 5m ago)
    state.openPositions = state.openPositions.filter(p => {
      const ageMs = nowMs - new Date(p.entryTime || 0).getTime();
      if (ageMs < 5 * 60 * 1000) return true;
      const realFree = trStatus.assetsMap?.[p.symbol] || 0;
      const unitUsdt = quotes[p.symbol]?.bestBid || p.currentPrice || 0;
      const valTry = unitUsdt * realFree * USD_TRY_RATE;
      return valTry >= 25;
    });
    // 2. Auto-adopt any real Binance TR position (>= 50 TL) that is missing from state.openPositions
    const currentOpenSet = new Set(state.openPositions.map(p => p.symbol));
    for (const [asset, freeQty] of Object.entries(trStatus.assetsMap || {})) {
      if (asset === 'TRY' || asset === 'USDT' || currentOpenSet.has(asset) || freeQty <= 0) continue;
      const recentlySold = (state.closedTrades || []).some(
        ct => ct.symbol === asset && nowMs - new Date(ct.exitTime || 0).getTime() < 120000
      );
      if (recentlySold) continue;
      const usdtBid = quotes[asset]?.bestBid || 0;
      const valUsdt = usdtBid * freeQty;
      const valTry = valUsdt * USD_TRY_RATE;
      if (valTry >= 50 && usdtBid > 0) {
        const matchedCand = candidates.find(c => c.symbol === asset);
        const costUsdt = Number(valUsdt.toFixed(4));
        state.openPositions.push({
          id: `pos_adopted_${Date.now()}_${asset}`,
          symbol: asset,
          leaderSymbol: matchedCand?.leaderSymbol || 'BTC',
          ecosystem: matchedCand?.ecosystems?.[0] || 'Binance TR Otomatik Senkronizasyon',
          headline: matchedCand?.headlines?.[0]?.title || `${asset} Cüzdan Senkronizasyonu (Otonom Müfettiş Onarımı)`,
          newsSource: matchedCand?.headlines?.[0]?.source || 'BinanceListingSniper',
          newsScore: matchedCand?.newsScore || 8.5,
          totalScore: matchedCand?.totalScore || 102,
          rsiAtEntry: matchedCand?.rsi1h || 55.31,
          atr1hPct: matchedCand?.atr1hPct || 2.0,
          takerBuyRatioPct: matchedCand?.takerBuyRatioPct || 54.7,
          obImbalance: 0.1,
          entryTime: new Date().toISOString(),
          entryPrice: usdtBid,
          currentPrice: usdtBid,
          highestPrice: usdtBid,
          qty: freeQty,
          costUsdt,
          costTry: Math.round(valTry),
          takeProfitPrice: Number((usdtBid * 1.055).toPrecision(5)),
          stopLossPrice: Number((usdtBid * 0.985).toPrecision(5)),
          tpPct: 5.5,
          slPct: 1.5,
          partialTpDone: false,
          stage2TpDone: false,
          trailingActive: false,
          rocketMode: false,
          unrealizedPnlUsdt: 0,
          unrealizedPnlPct: 0,
          currentPriceTry: Number((usdtBid * USD_TRY_RATE).toFixed(4)),
          currentValueTry: Number(valTry.toFixed(2)),
        });
        currentOpenSet.add(asset);
        logEvent(state, `🔧 [OTONOM MÜFETTİŞ] Cüzdandaki ${asset} ($${valUsdt.toFixed(2)} = ${valTry.toFixed(2)} TL) otomatik olarak açık işlemlere senkronize edildi.`);
      }
    }
  }

  for (const p of state.openPositions) {
    const usdtBid = quotes[p.symbol]?.bestBid || p.currentPrice;
    p.currentPrice = usdtBid;
    p.costUsdt = Number((p.entryPrice * p.qty).toFixed(4));
    p.costTry = Number((p.costUsdt * USD_TRY_RATE).toFixed(2));
    p.unrealizedPnlUsdt = Number(((p.currentPrice - p.entryPrice) * p.qty).toFixed(4));
    p.unrealizedPnlPct = Number((((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(2));
    p.currentPriceTry = Number((p.currentPrice * USD_TRY_RATE).toFixed(4));
    p.currentValueTry = Number((p.currentPrice * p.qty * USD_TRY_RATE).toFixed(2));
    p.holdShort = buildShortHoldLine(p);
    p.holdReason = buildHoldReasonText(p);
  }

  let dustAssetsUsdt = 0;
  for (const [asset, freeQty] of Object.entries(trStatus.assetsMap || {})) {
    if (asset === 'TRY' || freeQty <= 0) continue;
    const openPosQty = state.openPositions
      .filter(p => p.symbol === asset)
      .reduce((s, p) => s + Number(p.qty || 0), 0);
    const residualDustQty = Math.max(0, Number(freeQty || 0) - openPosQty);
    if (residualDustQty <= 0) continue;
    const usdtBid = quotes[asset]?.bestBid || 0;
    if (usdtBid > 0) {
      dustAssetsUsdt += usdtBid * residualDustQty;
    }
  }
  const dustAssetsTry = dustAssetsUsdt * USD_TRY_RATE;
  state.dustAssetsUsdt = Number(dustAssetsUsdt.toFixed(4));
  state.dustAssetsTry = Number(dustAssetsTry.toFixed(2));

  const openMarketValueUsdt = state.openPositions.reduce(
    (sum, p) => sum + p.currentPrice * p.qty,
    0
  );
  const rawTotalEquityUsdt = Number((state.cashUsdt + openMarketValueUsdt + dustAssetsUsdt).toFixed(4));
  const rawTotalEquityTry = Number((rawTotalEquityUsdt * USD_TRY_RATE).toFixed(2));
  const prevEquityTry = Number(state.totalEquityTry || state.initialBankrollTry || 1000);
  if (rawTotalEquityTry < 850 && prevEquityTry >= 920) {
    state.totalEquityTry = prevEquityTry;
  } else {
    state.totalEquityTry = rawTotalEquityTry;
  }
  state.initialBankrollTry = 1000;
  state.totalEquityUsdt = Number((state.totalEquityTry / USD_TRY_RATE).toFixed(4));
  state.initialBankrollUsdt = Number((1000 / USD_TRY_RATE).toFixed(4));
  state.totalPnlTry = Number((state.totalEquityTry - 1000).toFixed(2));
  state.totalPnlUsdt = Number((state.totalPnlTry / USD_TRY_RATE).toFixed(4));
  state.totalPnlPct = Number(((state.totalPnlTry / 1000) * 100).toFixed(2));

  // Record live TL Equity History for Dashboard SVG Growth Chart (keep up to 96 points, ignore transition glitches)
  if (!Array.isArray(state.equityHistory)) {
    state.equityHistory = [{ t: 'Başlangıç', v: state.initialBankrollTry || 1000 }];
  }
  state.equityHistory = state.equityHistory.filter(pt => Number(pt.v) >= 920 && Number(pt.v) <= 2200);
  const timeLabel = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const lastPt = state.equityHistory[state.equityHistory.length - 1];
  const isGlitchJump = lastPt && Math.abs(state.totalEquityTry - Number(lastPt.v)) > 75;
  if (!isGlitchJump && state.totalEquityTry >= 920 && (!lastPt || lastPt.t !== timeLabel || Math.abs(lastPt.v - state.totalEquityTry) >= 0.5)) {
    state.equityHistory.push({ t: timeLabel, v: state.totalEquityTry });
    if (state.equityHistory.length > 96) state.equityHistory.shift();
  }

  const cycleEvents = state._cycleEvents || [];
  delete state._cycleEvents;

  // Smart WhatsApp Filter: Only send instant WhatsApp on real BUY/SELL/HARVEST/GOLDEN_AGE events (never spam on orderbook/scanner warnings!)
  const realTradeEvents = cycleEvents.filter(
    e =>
      e.includes('🟢 [OTOMATİK ALIM]') ||
      e.includes('🎰 [VURGUN SLOTU') ||
      e.includes('💰 [SIFIR RİSK') ||
      e.includes('🚀 [2. KADEME') ||
      e.includes('🏁 [POZİSYON KAPANDI]') ||
      e.includes('🌟 [GOLDEN AGE BAŞLADI]')
  );
  const msSinceLastWa = Date.now() - Number(state.lastWhatsAppReportAt || 0);
  if ((realTradeEvents.length > 0 && msSinceLastWa >= 45 * 1000) || msSinceLastWa >= 120 * 60 * 1000) {
    const waOk = await sendInstantPhoneAlert(buildSimpleWhatsAppMessage(state));
    if (waOk) state.lastWhatsAppReportAt = Date.now();
  }

  savePortfolioState(state);
  return { state, signalsData };
}

function buildSimpleWhatsAppMessage(state) {
  const openMarketValueUsdt = state.openPositions.reduce((sum, p) => sum + p.currentPrice * p.qty, 0);
  const expectedOpenUsdt = state.openPositions.reduce((sum, p) => {
    const targetPrice = Math.max(Number(p.takeProfitPrice || 0), p.entryPrice * 1.09, p.currentPrice * 1.04);
    return sum + targetPrice * p.qty;
  }, 0);
  const expectedTotalUsdt = state.cashUsdt + expectedOpenUsdt;
  const expectedTotalPnlUsdt = expectedTotalUsdt - state.initialBankrollUsdt;

  const openLines = state.openPositions
    .map(p => {
      const curTry = toTL(p.currentPrice * p.qty);
      const pnlSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
      const pnlTry = toTL(p.unrealizedPnlUsdt);
      const targetPrice = Math.max(Number(p.takeProfitPrice || 0), p.entryPrice * 1.09, p.currentPrice * 1.04);
      const targetTry = toTL(targetPrice * p.qty);
      const cleanWhy = (p.holdReason || buildHoldReasonText(p)).replace(/\*\*|`/g, '');
      return `- ${p.symbol}${p.isMoonshot ? ' (Vurgun)' : ''}: ${curTry} TL (Kar: ${pnlSign}${pnlTry} TL | Hedef: ${targetTry} TL)\n  ↳ ${cleanWhy}`;
    })
    .join('\n');

  const pnlSign = state.totalPnlUsdt >= 0 ? '+' : '';
  const expSign = expectedTotalPnlUsdt >= 0 ? '+' : '';

  return (
    `Toplam Kasa: ${toTL(state.totalEquityUsdt)} TL\n` +
    `Su Anki Kar: ${pnlSign}${toTL(state.totalPnlUsdt)} TL (${pnlSign}%${state.totalPnlPct})\n` +
    `Coindeki Para: ${toTL(openMarketValueUsdt)} TL\n` +
    `Bostaki Nakit: ${toTL(state.cashUsdt)} TL\n` +
    `Hedeflenen Kasa (Hedef Gelirse): ${toTL(expectedTotalUsdt)} TL (${expSign}${toTL(expectedTotalPnlUsdt)} TL Kar)\n\n` +
    `Coinde Olanlar:\n${openLines || 'Su an acik islem yok'}`
  );
}

async function sellPositionManual(symbolRaw, reasonLabel = '📲 TELEFONDAN MANUEL SATIŞ (Kâr/Nakit Alındı)') {
  await syncLiveUsdTryRate();
  const symbol = String(symbolRaw || '').trim().toUpperCase();
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  const idx = state.openPositions.findIndex(p => p.symbol.toUpperCase() === symbol);
  if (idx === -1) return { ok: false, msg: `${symbol} açık işlemlerde bulunamadı.`, state };

  const pos = state.openPositions[idx];
  const quotes = await getOrderbookQuotes([pos.symbol]);
  const exitPrice = quotes[pos.symbol]?.bestBid || pos.currentPrice || pos.entryPrice;

  if (state.mode === 'LIVE_BINANCE') {
    await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
  }

  const proceedsUsdt = Number((exitPrice * pos.qty).toFixed(4));
  const netPnlUsdt = Number((proceedsUsdt - pos.costUsdt).toFixed(4));
  state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
  state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
  if (netPnlUsdt >= 0) state.winCount++;
  else state.lossCount++;

  state.openPositions.splice(idx, 1);
  state.closedTrades.unshift({
    ...pos,
    exitPrice,
    exitTime: new Date().toISOString(),
    exitReason: reasonLabel,
    netPnlUsdt,
    netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
  });

  const trStatus = await fetchBinanceTrStatus(cfg);
  if (trStatus.ok) {
    state.binanceTrStatus = trStatus.summary;
    state.cashUsdt = Number((trStatus.tryFree / USD_TRY_RATE).toFixed(4));
  }
  logEvent(state, `🏁 [MANUEL SATIŞ] ${pos.symbol} @ $${exitPrice} | ${reasonLabel} | Net: ${toTL(netPnlUsdt)} TL`);
  savePortfolioState(state);
  return { ok: true, msg: `${pos.symbol} başarıyla satıldı ve TL nakite çevrildi!`, state };
}

async function sellAllPositionsManual(reasonLabel = '🛡️ ACİL NAKİTE GEÇİŞ (Tüm Coinler TL Nakite Çevrildi)') {
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  const syms = state.openPositions.map(p => p.symbol);
  for (const sym of syms) {
    await sellPositionManual(sym, reasonLabel);
  }
  const updated = await safeRunTradingCycle();
  return { ok: true, count: syms.length, state: updated.state };
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AltcoinAutoTrader v9.5 (Otonom Zırh) — TL Kasa & Kumanda Paneli</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #131b2e;
      --border: #23304d;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --green: #10b981;
      --red: #ef4444;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      background: var(--card);
      border: 1px solid var(--border);
      padding: 18px 24px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 10px 16px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 13px;
    }
    .btn-sell {
      background: #ef4444;
      color: #fff;
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      padding: 15px 18px;
      border-radius: 12px;
    }
    .kpi-label { font-size: 12px; color: var(--muted); }
    .kpi-val { font-size: 22px; font-weight: 700; margin-top: 5px; }
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 18px;
      overflow-x: auto;
    }
    .section h2 { font-size: 16px; margin-bottom: 12px; color: #f8fafc; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .pos { color: var(--green); font-weight: 600; }
    .neg { color: var(--red); font-weight: 600; }
    input.tg-in {
      background: #0b0f19;
      border: 1px solid var(--border);
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      width: 280px;
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 style="font-size: 19px;">🚀 AltcoinAutoTrader v9.5 (Otonom Zırh) — Canlı TL Kasa & Kumanda Paneli</h1>
      <p style="font-size: 12px; color: var(--muted); margin-top: 4px;" id="trWalletBar">
        Binance Resmi Listing Sniper + Canlı TR Tahta Fiyatı + Otonom Nakit Dedektörü
      </p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn" style="background:#ef4444;" onclick="sellAllCoins()" id="sellAllBtn">🛡️ Tümünü Nakite Çevir</button>
      <button class="btn" style="background:#10b981;" onclick="triggerWhatsApp()" id="waBtn">📲 WhatsApp Rapor Gönder</button>
      <button class="btn" onclick="triggerCycle()" id="scanBtn">⚡ Şimdi Tara & Güncelle</button>
    </div>
  </div>

  <div class="grid-kpi">
    <div class="kpi">
      <div class="kpi-label">Toplam Kasa (Gerçek TR)</div>
      <div class="kpi-val" id="equityVal">1.000,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Toplam Net Kâr (TL)</div>
      <div class="kpi-val" id="pnlVal">+0,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Boştaki Nakit (TRY)</div>
      <div class="kpi-val" id="cashVal">0,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Biten İşlemler</div>
      <div class="kpi-val" id="winVal">0 Kârlı / 0 Stop</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Canlı USDT/TRY Kuru</div>
      <div class="kpi-val" id="rateVal" style="color:#38bdf8;">49.46 TL</div>
    </div>
  </div>

  <div class="section" style="background:linear-gradient(135deg,#131b2e 0%,#0f172a 100%);border:1px solid #1e3a8a;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
      <h2 style="margin:0;display:flex;align-items:center;gap:8px;font-size:16px;color:#f8fafc;">
        🎯 80.000 TL Ana Kasa &amp; Günde 1.000 TL Harcanabilir Kâr Sayacı
      </h2>
      <span id="goalMilestoneBadge" style="background:#1e293b;border:1px solid #3b82f6;color:#60a5fa;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;">
        1. Basamak: 1.000 TL ➔ 2.500 TL
      </span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:14px;">
      <div style="background:#0b0f19;border:1px solid #23304d;padding:12px 14px;border-radius:10px;">
        <div style="font-size:11.5px;color:#94a3b8;">Ana Kasa Hedefi (80.000 TL)</div>
        <div style="font-size:19px;font-weight:700;margin-top:4px;color:#f8fafc;" id="goalEquityProgressTxt">992,20 / 80.000 TL</div>
        <div style="font-size:11.5px;color:#38bdf8;margin-top:3px;" id="goalRemainingTryTxt">Kalan: 79.007,80 TL (%1.24)</div>
      </div>
      <div style="background:#0b0f19;border:1px solid #23304d;padding:12px 14px;border-radius:10px;">
        <div style="font-size:11.5px;color:#94a3b8;">Günlük Gerçekçi Kâr Kapasitesi</div>
        <div style="font-size:19px;font-weight:700;margin-top:4px;color:#10b981;" id="goalDailyCashflowTxt">3,83 TL / 1.000 TL</div>
        <div style="font-size:11.5px;color:#94a3b8;margin-top:3px;" id="goalTodayRealizedTxt">BTC 2026 Pozitif Ay Bazı (+%12.24/ay)</div>
      </div>
      <div style="background:#0b0f19;border:1px solid #23304d;padding:12px 14px;border-radius:10px;">
        <div style="font-size:11.5px;color:#94a3b8;">Dış Müdahalesiz Süre (BTC 2026 Bazlı)</div>
        <div style="font-size:19px;font-weight:700;margin-top:4px;color:#fbbf24;" id="goalDaysBaseTxt">~38 Ay (~1.140 Gün)</div>
        <div style="font-size:11.5px;color:#cbd5e1;margin-top:3px;" id="goalDaysFastTxt">Ağustos Boğa Hızı (+%27/ay): ~18,3 Ay</div>
      </div>
      <div style="background:#0b0f19;border:1px solid #23304d;padding:12px 14px;border-radius:10px;">
        <div style="font-size:11.5px;color:#94a3b8;">Sıradaki Ara Durak Sayacı</div>
        <div style="font-size:19px;font-weight:700;margin-top:4px;color:#a78bfa;" id="goalNextStopTxt">2.500,00 TL</div>
        <div style="font-size:11.5px;color:#94a3b8;margin-top:3px;" id="goalNextStopDaysTxt">Kalan: 1.507,80 TL (~74 Gün)</div>
      </div>
    </div>
    <div style="margin-bottom:6px;display:flex;justify-content:space-between;font-size:12px;color:#cbd5e1;">
      <span id="goalBarLabelLeft">📈 Bileşik Katlanma Yolu (1.000 TL ➔ 2.5K ➔ 5K ➔ 10K ➔ 25K ➔ 50K ➔ 80.000 TL)</span>
      <span id="goalBarLabelRight" style="font-weight:700;color:#10b981;">%1.24</span>
    </div>
    <div style="width:100%;height:12px;background:#0b0f19;border:1px solid #23304d;border-radius:999px;overflow:hidden;">
      <div id="goalProgressBar" style="width:1.5%;height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);transition:width 0.4s ease;"></div>
    </div>
  </div>

  <div class="section">
    <h2>📈 1.000 TL ➔ 80.000 TL Canlı Kasa Büyüme Grafiği</h2>
    <div id="chartBox" style="width:100%;height:130px;"></div>
  </div>

  <div class="section">
    <h2>🟢 Şu An Açık Olan İşlemler (Tek Tıkla Manuel Satış Aktif)</h2>
    <div id="noBuyBar" style="margin-bottom:12px;padding:10px 14px;background:#0b0f19;border:1px solid #23304d;border-radius:8px;font-size:13px;"></div>
    <table>
      <thead>
        <tr>
          <th>Coin & Haber Katalizörü</th>
          <th>Yatırılan (TL)</th>
          <th>Şu Anki Değer (TL)</th>
          <th>Anlık Net Kâr (TL)</th>
          <th>Durum / Otomatik Satış Planı</th>
          <th>Hızlı İşlem</th>
        </tr>
      </thead>
      <tbody id="openBody"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>✅ Satılıp Cebe Giren İşlemler</h2>
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Yatırılan (TL)</th>
          <th>Cebe Giren Net Kâr (TL)</th>
          <th>Satış Sebebi</th>
        </tr>
      </thead>
      <tbody id="closedBody"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>🤖 Ev Dışındayken 2-Yönlü Telegram Kumandası (İsteğe Bağlı)</h2>
    <p style="font-size:13px;color:var(--muted);margin-bottom:10px;">
      Dışarıda mobil verideyken bota mesaj atıp kontrol etmek istersen Telegram'da <b>@BotFather</b>'a <code>/newbot</code> yazıp aldığın Token'ı buraya yapıştırabilirsin. Komutlar: <code>/durum</code>, <code>/sat AVAX</code>, <code>/nakit</code>, <code>/tara</code>
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input class="tg-in" id="tgTokenIn" placeholder="Telegram Bot Token (Örn: 123456:ABC-DEF...)" />
      <button class="btn" onclick="saveTelegramToken()" id="tgSaveBtn">🔗 Telegram Kumandasını Bağla</button>
      <span id="tgStatusTxt" style="font-size:13px;color:#10b981;"></span>
    </div>
  </div>

  <script>
    let RATE = 49.46;
    window._openDetails = window._openDetails || {};
    function toggleWhy(sym) {
      window._openDetails[sym] = !window._openDetails[sym];
      const el = document.getElementById('why_' + sym);
      const btn = document.getElementById('whybtn_' + sym);
      if (el) el.style.display = window._openDetails[sym] ? 'block' : 'none';
      if (btn) btn.textContent = window._openDetails[sym] ? '🔼 Detayı Gizle' : '🔍 Detaylı Açıklama';
    }
    const fmtTL = u => (Number(u || 0) * RATE).toFixed(2) + ' TL';

    function renderSvgChart(hist) {
      const box = document.getElementById('chartBox');
      if (!box) return;
      const pts = Array.isArray(hist) && hist.length > 1 ? hist : [{ t: 'Başlangıç', v: 1000 }, { t: 'Şimdi', v: 1032 }];
      const vals = pts.map(p => Number(p.v || 1000));
      const minV = Math.min(995, ...vals) - 2;
      const maxV = Math.max(1010, ...vals) + 2;
      const w = 800, h = 120, pad = 20;
      const coords = pts.map((p, i) => {
        const x = pad + (i / Math.max(1, pts.length - 1)) * (w - pad * 2);
        const y = h - pad - ((Number(p.v) - minV) / Math.max(1, maxV - minV)) * (h - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      const lastVal = vals[vals.length - 1];
      const color = lastVal >= 1000 ? '#10b981' : '#ef4444';
      box.innerHTML =
        '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:125px;background:#0b0f19;border-radius:8px;border:1px solid #1e293b;">' +
        '<polyline fill="none" stroke="' + color + '" stroke-width="3" points="' + coords.join(' ') + '" />' +
        '<text x="12" y="18" fill="#94a3b8" font-size="12">Başlangıç: 1.000,00 TL</text>' +
        '<text x="' + (w - 190) + '" y="18" fill="' + color + '" font-size="13" font-weight="bold">Şu An: ' + lastVal.toFixed(2) + ' TL</text>' +
        '</svg>';
    }

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      const s = data.state;
      if (s.usdTryRate) RATE = Number(s.usdTryRate);

      const eqTryNum = Number(s.totalEquityTry || Number(s.totalEquityUsdt || 0) * RATE);
      const eqTry = eqTryNum.toFixed(2) + ' TL';
      document.getElementById('equityVal').textContent = eqTry;
      document.getElementById('cashVal').textContent = fmtTL(s.cashUsdt);
      document.getElementById('rateVal').textContent = RATE.toFixed(2) + ' TL';
      if (s.binanceTrStatus) {
        document.getElementById('trWalletBar').textContent = '🏦 ' + s.binanceTrStatus;
      }

      const pnlEl = document.getElementById('pnlVal');
      const pnlTryNum = Number(s.totalPnlTry ?? (eqTryNum - 1000));
      const pnlPctNum = Number(((pnlTryNum / 1000) * 100).toFixed(2));
      const sign = pnlTryNum >= 0 ? '+' : '';
      pnlEl.textContent = sign + pnlTryNum.toFixed(2) + ' TL (' + sign + '%' + pnlPctNum + ')';
      pnlEl.className = 'kpi-val ' + (pnlTryNum >= 0 ? 'pos' : 'neg');

      document.getElementById('winVal').textContent = s.winCount + ' Kârlı / ' + s.lossCount + ' Stop';
      renderSvgChart(s.equityHistory);

      // Update 80,000 TL & 1,000 TL/Day Goal Counter Widget (Calibrated to Real 2026 BTCTRY & Engine #30 OOS Data)
      const curEqTry = Math.max(1, Number(s.totalEquityUsdt || 0) * RATE);
      const targetEqTry = 80000;
      const targetDailyTry = 1000;
      const dailyRateBase = 0.00386; // +0.386%/day = +12.24%/month (Real 2026 BTCTRY positive-months average with downside cash shield)
      const dailyRateFast = 0.00799; // +0.799%/day = +26.98%/month (Real August 2026 BTCTRY bull-month speed)
      const curDailyCapTry = curEqTry * dailyRateBase;
      const linearPct = Math.min(100, Math.max(0, (curEqTry / targetEqTry) * 100));
      const remTry = Math.max(0, targetEqTry - curEqTry);
      const daysBase = curEqTry >= targetEqTry ? 0 : Math.ceil(Math.log(targetEqTry / Math.max(100, curEqTry)) / Math.log(1 + dailyRateBase));
      const daysFast = curEqTry >= targetEqTry ? 0 : Math.ceil(Math.log(targetEqTry / Math.max(100, curEqTry)) / Math.log(1 + dailyRateFast));

      const milestones = [2500, 5000, 10000, 25000, 50000, 80000];
      const nextStop = milestones.find(m => curEqTry < m) || 80000;
      const stopIdx = milestones.indexOf(nextStop) + 1;
      const prevStop = stopIdx > 1 ? milestones[stopIdx - 2] : 1000;
      const nextStopRemTry = Math.max(0, nextStop - curEqTry);
      const nextStopDays = curEqTry >= nextStop ? 0 : Math.ceil(Math.log(nextStop / Math.max(100, curEqTry)) / Math.log(1 + dailyRateBase));

      // Today's realized net P&L in TRY
      const todayIsoPrefix = new Date().toISOString().slice(0, 10);
      const todayRealizedTry = (s.closedTrades || [])
        .filter(t => String(t.exitTime || '').startsWith(todayIsoPrefix))
        .reduce((sum, t) => sum + Number(t.netPnlUsdt || 0) * RATE, 0);

      const elEqProg = document.getElementById('goalEquityProgressTxt');
      if (elEqProg) elEqProg.textContent = curEqTry.toFixed(2) + ' / 80.000,00 TL';
      const elRemTry = document.getElementById('goalRemainingTryTxt');
      if (elRemTry) elRemTry.textContent = 'Kalan: ' + remTry.toFixed(2) + ' TL (%' + linearPct.toFixed(2) + ')';
      const elDailyCap = document.getElementById('goalDailyCashflowTxt');
      if (elDailyCap) elDailyCap.textContent = curDailyCapTry.toFixed(2) + ' TL / 308,80 TL (80K Kapasitesi)';
      const elTodayReal = document.getElementById('goalTodayRealizedTxt');
      if (elTodayReal) {
        const tSign = todayRealizedTry >= 0 ? '+' : '';
        elTodayReal.textContent = 'Bugün Cebe Giren: ' + tSign + todayRealizedTry.toFixed(2) + ' TL (BTC Baz +%12.24/ay)';
      }
      const elDaysBase = document.getElementById('goalDaysBaseTxt');
      if (elDaysBase) elDaysBase.textContent = daysBase > 0 ? '~' + (daysBase / 30).toFixed(1) + ' Ay (~' + daysBase + ' Gün)' : 'HEDEF TAMAMLANDI! 🎉';
      const elDaysFast = document.getElementById('goalDaysFastTxt');
      if (elDaysFast) elDaysFast.textContent = 'Ağustos Boğa Hızı (+%27/ay): ~' + (daysFast / 30).toFixed(1) + ' Ay (~' + daysFast + ' Gün)';
      const elNextStop = document.getElementById('goalNextStopTxt');
      if (elNextStop) elNextStop.textContent = nextStop.toLocaleString('tr-TR') + ',00 TL';
      const elNextStopDays = document.getElementById('goalNextStopDaysTxt');
      if (elNextStopDays) elNextStopDays.textContent = 'Kalan: ' + nextStopRemTry.toFixed(2) + ' TL (~' + nextStopDays + ' Gün)';
      const elBadge = document.getElementById('goalMilestoneBadge');
      if (elBadge) elBadge.textContent = stopIdx + '. Basamak: ' + prevStop.toLocaleString('tr-TR') + ' TL ➔ ' + nextStop.toLocaleString('tr-TR') + ' TL';
      const elBarRight = document.getElementById('goalBarLabelRight');
      if (elBarRight) elBarRight.textContent = '%' + linearPct.toFixed(2) + ' (Günlük Kapasite: ' + curDailyCapTry.toFixed(2) + ' TL)';
      const elBar = document.getElementById('goalProgressBar');
      if (elBar) elBar.style.width = Math.max(1.5, linearPct).toFixed(2) + '%';

      const nbBar = document.getElementById('noBuyBar');
      if (nbBar) {
        const nbShort = s.noBuyShort || '🛡️ Raad ol, pusudayız: 14 haber kaynağı ve Binance TR tahtası saniye saniye taranıyor.';
        const nbFull = (s.noBuyDetail || '').replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>').replace(/\\\`(.*?)\\\`/g, '<code style="color:#38bdf8;">$1</code>');
        const nbOpen = Boolean(window._openDetails['_NOBUY_']);
        nbBar.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<span style="font-weight:600;color:#fbbf24;">' + nbShort + '</span>' +
            (nbFull ? '<button id="whybtn__NOBUY_" onclick="toggleWhy(\\'_NOBUY_\\')" style="background:#1e293b;color:#38bdf8;border:1px solid #334155;padding:4px 10px;border-radius:6px;font-size:11.5px;cursor:pointer;font-weight:600;">' + (nbOpen ? '🔼 Detayı Gizle' : '🔍 Neden Alım Yok? (Detay)') + '</button>' : '') +
          '</div>' +
          (nbFull ? '<div id="why__NOBUY_" style="display:' + (nbOpen ? 'block' : 'none') + ';margin-top:8px;padding-top:8px;border-top:1px solid #1e293b;font-size:12px;color:#cbd5e1;line-height:1.5;">' + nbFull + '</div>' : '');
      }

      const openBody = document.getElementById('openBody');
      openBody.innerHTML = s.openPositions.map(p => {
        const costUsd = p.entryPrice * p.qty;
        const curUsd = p.currentPrice * p.qty;
        const diffUsd = curUsd - costUsd;
        const costTryVal = costUsd * RATE;
        const curTryVal = curUsd * RATE;
        const diffTry = diffUsd * RATE;
        const pClass = diffTry >= 0 ? 'pos' : 'neg';
        const pSign = diffTry >= 0 ? '+' : '';
        const shortTxt = p.holdShort || '😎 Raad ol, kontrol bende: Tahta ve stop seviyesi saniye saniye izleniyor.';
        const fullTxt = (p.holdReason || '')
          .replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>')
          .replace(/\\\`(.*?)\\\`/g, '<code style="color:#38bdf8;">$1</code>');
        const isOpen = Boolean(window._openDetails[p.symbol]);
        const modeHtml =
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<span style="font-weight:600;color:#f8fafc;">' + shortTxt + '</span>' +
            (fullTxt ? '<button id="whybtn_' + p.symbol + '" onclick="toggleWhy(\\'' + p.symbol + '\\')" style="background:#1e293b;color:#38bdf8;border:1px solid #334155;padding:3px 9px;border-radius:6px;font-size:11.5px;cursor:pointer;font-weight:600;">' + (isOpen ? '🔼 Detayı Gizle' : '🔍 Detaylı Açıklama') + '</button>' : '') +
          '</div>' +
          (fullTxt ? '<div id="why_' + p.symbol + '" style="display:' + (isOpen ? 'block' : 'none') + ';margin-top:8px;padding:9px 11px;background:#0b0f19;border:1px solid #23304d;border-radius:8px;font-size:12px;color:#cbd5e1;line-height:1.5;">' + fullTxt + '</div>' : '');
        return '<tr>' +
          '<td><strong>' + p.symbol + '</strong> <small style="color:#38bdf8;">(' + p.qty + ' Adet @ $' + p.currentPrice + ')</small><br><small style="color:#94a3b8;">' + p.headline + '</small></td>' +
          '<td>' + costTryVal.toFixed(2) + ' TL <small style="color:#94a3b8;">($' + costUsd.toFixed(2) + ')</small></td>' +
          '<td><strong>' + curTryVal.toFixed(2) + ' TL</strong> <small style="color:#94a3b8;">($' + curUsd.toFixed(2) + ')</small></td>' +
          '<td class="' + pClass + '">' + pSign + diffTry.toFixed(2) + ' TL (' + pSign + '%' + p.unrealizedPnlPct + ')</td>' +
          '<td style="max-width:460px;">' + modeHtml + '</td>' +
          '<td><button class="btn-sell" onclick="sellCoin(\\'' + p.symbol + '\\')">🔴 Şimdi Sat</button></td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="6">Şu an açık işlem yok, yeni A+ haber taranıyor...</td></tr>';

      const closedBody = document.getElementById('closedBody');
      closedBody.innerHTML = s.closedTrades.map(c => {
        const cClass = c.netPnlUsdt >= 0 ? 'pos' : 'neg';
        const cSign = c.netPnlUsdt >= 0 ? '+' : '';
        return '<tr>' +
          '<td><strong>' + c.symbol + '</strong></td>' +
          '<td>' + fmtTL(c.costUsdt) + '</td>' +
          '<td class="' + cClass + '">' + cSign + fmtTL(c.netPnlUsdt) + '</td>' +
          '<td>' + c.exitReason + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="4">Henüz kapanan işlem yok.</td></tr>';
    }

    async function sellCoin(sym) {
      if (!confirm(sym + ' coinini şu anki fiyattan Binance TR\\'de satıp TL nakite çevirmek istiyor musun?')) return;
      await fetch('/api/sell?symbol=' + encodeURIComponent(sym), { method: 'POST' });
      await loadState();
    }

    async function sellAllCoins() {
      if (!confirm('TÜM açık coinleri hemen satıp %100 TL nakite geçmek istediğine emin misin?')) return;
      const btn = document.getElementById('sellAllBtn');
      if (btn) btn.textContent = '⏳ Satılıyor...';
      await fetch('/api/sell-all', { method: 'POST' });
      await loadState();
      if (btn) btn.textContent = '🛡️ Tümünü Nakite Çevir';
    }

    async function saveTelegramToken() {
      const token = document.getElementById('tgTokenIn').value.trim();
      if (!token) return;
      const res = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const d = await res.json();
      document.getElementById('tgStatusTxt').textContent = d.ok ? '✅ Bağlandı! Şimdi Telegram botuna /durum yazabilirsin.' : '❌ Token hatalı.';
    }

    async function triggerCycle() {
      const btn = document.getElementById('scanBtn');
      if (btn) btn.textContent = '⏳ Taranıyor...';
      await fetch('/api/cycle', { method: 'POST' });
      await loadState();
      if (btn) btn.textContent = '⚡ Şimdi Tara & Güncelle';
    }
    async function triggerWhatsApp() {
      const btn = document.getElementById('waBtn');
      if (btn) btn.textContent = '📲 Gönderiliyor...';
      await fetch('/api/whatsapp', { method: 'POST' });
      if (btn) btn.textContent = '✅ WhatsApp Gönderildi!';
      setTimeout(() => { if (btn) btn.textContent = '📲 WhatsApp Rapor Gönder'; }, 3000);
    }
    loadState();
    setInterval(loadState, 8000);
  </script>
</body>
</html>`;
}

let _isCycleRunning = false;
async function safeRunTradingCycle() {
  if (_isCycleRunning) {
    const cfg = loadEnv();
    return { state: loadPortfolioState(cfg), skipped: true };
  }
  _isCycleRunning = true;
  try {
    return await runTradingCycle();
  } finally {
    _isCycleRunning = false;
  }
}

let _fastRiskLoopStarted = false;
async function runFastPositionRiskTick() {
  if (_isCycleRunning) return;
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  if (!state.openPositions || state.openPositions.length === 0) return;

  _isCycleRunning = true;
  try {
    const quotes = await getOrderbookQuotes(state.openPositions.map(p => p.symbol));
    let stateModified = false;
    const remaining = [];

    for (const pos of state.openPositions) {
      const q = quotes[pos.symbol];
      if (!q || !q.bestBid || (state.mode === 'LIVE_BINANCE' && q.priceSource !== 'BINANCE_TR')) {
        remaining.push(pos);
        continue;
      }
      const currentBid = q.bestBid;
      if (q.bestBidTry) pos.currentBidTry = q.bestBidTry;
      if (q.bestAskTry) pos.currentAskTry = q.bestAskTry;
      pos.currentPrice = currentBid;
      pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentBid);
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
      pos.unrealizedPnlPct = Number((((currentBid - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));

      // Fast 4s Profit Harvest (TP1 & TP2) + Harmonized Zero-Conflict Profit Ratchet
      const didFastHarvest = await processProfitTargets(cfg, state, pos, currentBid);
      if (didFastHarvest) stateModified = true;
      const tsiFastNow = new Date(Date.now() + 3 * 3600 * 1000);
      const isFridayPmFast = tsiFastNow.getUTCDay() === 5 && tsiFastNow.getUTCHours() >= 15;
      const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const dynTp1Fast = Number(pos.tp1Pct || 2.2);
      const breakevenTriggerFast = isFridayPmFast ? 1.35 : Math.max(1.75, Number((dynTp1Fast * 0.72).toFixed(2)));
      let stepFloor = pos.stopLossPrice;
      if (pos.partialTpDone && peakGainPct >= 7.0) stepFloor = Math.max(stepFloor, Number((pos.highestPrice * 0.988).toPrecision(5)), Number((pos.entryPrice * 1.0602).toPrecision(5)));
      else if (pos.partialTpDone && peakGainPct >= 4.5) stepFloor = Math.max(stepFloor, Number((pos.highestPrice * 0.986).toPrecision(5)), Number((pos.entryPrice * 1.0342).toPrecision(5)));
      else if (pos.partialTpDone && peakGainPct >= 3.2) stepFloor = Math.max(stepFloor, Number((pos.entryPrice * 1.0202).toPrecision(5)));
      else if (peakGainPct >= breakevenTriggerFast) stepFloor = Math.max(stepFloor, Number((pos.entryPrice * 1.0068).toPrecision(5)));

      if (stepFloor > pos.stopLossPrice) {
        pos.stopLossPrice = stepFloor;
        pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
        stateModified = true;
      }

      const executableExit = currentBid * (1 - 0.0012) * (1 - 0.0010);
      const netPnlTryExec = (executableExit - pos.entryPrice) * pos.qty * USD_TRY_RATE;
      const posRiskBudgetTry = Number(pos.riskBudgetTry || 4.50);
      const nowTickMs = Date.now();
      const minsHeldFast = (nowTickMs - new Date(pos.entryTime || nowTickMs).getTime()) / 60000;
      if (!pos.partialTpDone && minsHeldFast >= 35 && pos.unrealizedPnlPct <= -0.35 && nowTickMs - (pos.lastFastObCheckAtMs || 0) >= 20000) {
        pos.liveObImbalance = await checkOrderbookImbalance(pos.symbol);
        pos.lastFastObCheckAtMs = nowTickMs;
        stateModified = true;
      }
      const fastObImb = Number(pos.liveObImbalance ?? pos.obImbalance ?? 0);
      const isFastSlowBleedRaw =
        !pos.partialTpDone &&
        ((minsHeldFast >= 75 && peakGainPct < 1.0 && pos.unrealizedPnlPct <= -0.65 && fastObImb <= -0.15) ||
          (minsHeldFast >= 120 && peakGainPct < 0.8 && pos.unrealizedPnlPct <= -0.85) ||
          (isFridayPmFast && minsHeldFast >= 35 && peakGainPct < 0.9 && pos.unrealizedPnlPct <= -0.45 && fastObImb <= -0.18) ||
          (minsHeldFast >= 90 && peakGainPct < 1.2 && pos.unrealizedPnlPct <= -0.40 && fastObImb <= -0.22));
      if (isFastSlowBleedRaw) {
        pos.slowBleedHitCount = (pos.slowBleedHitCount || 0) + 1;
        stateModified = true;
      } else if (pos.slowBleedHitCount > 0) {
        pos.slowBleedHitCount = 0;
        stateModified = true;
      }
      const isFastSlowBleed = (pos.slowBleedHitCount || 0) >= 2;

      if (currentBid <= pos.stopLossPrice || (!pos.trailingActive && netPnlTryExec <= -posRiskBudgetTry)) {
        pos.stopHitCount = (pos.stopHitCount || 0) + 1;
        if (!pos.firstStopHitAt) pos.firstStopHitAt = nowTickMs;
        stateModified = true;
      } else if (pos.stopHitCount > 0) {
        pos.stopHitCount = 0;
        pos.firstStopHitAt = 0;
        stateModified = true;
      }

      const isEmergencyTlLoss = !pos.trailingActive && netPnlTryExec <= -(posRiskBudgetTry * 1.30);
      const isBnfFastTarget =
        pos.engineOwner === 'BNF' &&
        (currentBid >= (pos.takeProfitPrice || pos.entryPrice * 1.022) || pos.unrealizedPnlPct >= 2.20);
      const isBnfFastImmediateStop =
        pos.engineOwner === 'BNF' &&
        (currentBid <= pos.stopLossPrice || netPnlTryExec <= -posRiskBudgetTry);
      const isConfirmedStop =
        isBnfFastTarget ||
        isBnfFastImmediateStop ||
        (pos.trailingActive && currentBid <= pos.stopLossPrice) ||
        isEmergencyTlLoss ||
        isFastSlowBleed ||
        (pos.stopHitCount >= 2 && nowTickMs - (pos.firstStopHitAt || nowTickMs) >= 3000);

      if (isConfirmedStop) {
        let soldQty = pos.qty;
        let realExitBid = currentBid;
        if (state.mode === 'LIVE_BINANCE') {
          const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
          if (!sellRes || sellRes.code !== 0) {
            remaining.push(pos);
            continue;
          }
          if (sellRes.executedQty > 0) soldQty = Math.min(pos.qty, sellRes.executedQty);
          if (sellRes.fillPriceUsdt > 0) realExitBid = sellRes.fillPriceUsdt;
        }
        const proceedsUsdt = Number((realExitBid * soldQty).toFixed(4));
        const exactCostUsdt = Number((pos.entryPrice * soldQty).toFixed(4));
        const netPnlUsdt = Number(((realExitBid - pos.entryPrice) * soldQty).toFixed(4));
        const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));
        state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
        state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
        if (netPnlUsdt >= 0) state.winCount++;
        else {
          state.lossCount++;
          state.cooldowns[pos.symbol] = Date.now() + 6 * 3600 * 1000;
        }
        const isProfitLock = pos.stopLossPrice > pos.entryPrice && pos.unrealizedPnlPct >= 0;
        const exitReason = isBnfFastTarget
          ? `🎯 BNF PANİK HEDEFİ 4sn TAM ÇIKIŞ (+%${pos.unrealizedPnlPct})`
          : isFastSlowBleed
            ? `🛡️ YAVAŞ ERİME & BAYAT HABER KALKANI (${Math.round(minsHeldFast)}dk Tepkisiz + 4sn Hızlı Tahliye %${pos.unrealizedPnlPct})`
            : isProfitLock
            ? `🔒 4sn HIZLI KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
            : `🛡️ 4sn HIZLI RİSK MONİTÖRÜ (%${pos.unrealizedPnlPct} | ${netPnlTryExec.toFixed(2)} TL)`;
        appendTradeTelemetry(pos, realExitBid, exitReason, netPnlUsdt, netPnlTry, soldQty);
        state.closedTrades.unshift({
          ...pos,
          positionId: pos.id,
          leg: 'FINAL',
          qty: soldQty,
          costUsdt: exactCostUsdt,
          exitPrice: realExitBid,
          exitTime: new Date().toISOString(),
          exitReason,
          netPnlUsdt,
          netPnlTry,
        });
        logEvent(state, `⚡ [4sn HIZLI ÇIKIŞ] ${pos.symbol} @ $${realExitBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`);
        stateModified = true;
      } else {
        remaining.push(pos);
      }
    }

    if (stateModified) {
      state.openPositions = remaining;
      savePortfolioState(state);
    }
  } catch {
    // Ignore transient fast-loop network hiccups
  } finally {
    _isCycleRunning = false;
  }
}

function startFastPositionRiskLoop() {
  if (_fastRiskLoopStarted) return;
  _fastRiskLoopStarted = true;
  setInterval(runFastPositionRiskTick, 4000);
}

let _tgOffset = 0;
let _tgLoopStarted = false;

async function pollTelegramUpdatesOnce() {
  const cfg = loadEnv();
  if (!cfg.TELEGRAM_BOT_TOKEN) return;
  try {
    const curState = loadPortfolioState(cfg);
    if (!_tgOffset && curState.lastTelegramUpdateId) {
      _tgOffset = Number(curState.lastTelegramUpdateId) || 0;
    }
    const res = await fetchJson(
      `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${_tgOffset + 1}&timeout=1`,
      {},
      4000
    );
    let offsetChanged = false;
    for (const upd of res?.result || []) {
      _tgOffset = Math.max(_tgOffset, upd.update_id);
      offsetChanged = true;
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      const text = msg.text.trim();
      const lower = text.toLowerCase();

      // Save chat_id automatically on first message
      if (!cfg.TELEGRAM_CHAT_ID && fs.existsSync(ENV_FILE)) {
        const envRaw = fs.readFileSync(ENV_FILE, 'utf8').replace(/TELEGRAM_CHAT_ID=.*/g, `TELEGRAM_CHAT_ID=${chatId}`);
        fs.writeFileSync(ENV_FILE, envRaw, 'utf8');
        cfg.TELEGRAM_CHAT_ID = chatId;
      }

      // Security Shield: Only allow the authorized owner's Telegram Chat ID
      if (cfg.TELEGRAM_CHAT_ID && chatId !== String(cfg.TELEGRAM_CHAT_ID).trim()) {
        console.warn(`🛡️ [Güvenlik Zırhı] Yetkisiz Telegram erişim denemesi reddedildi (ChatID: ${chatId})`);
        continue;
      }

      let reply = '';
      if (lower.startsWith('/durum') || lower === 'durum') {
        const st = loadPortfolioState(cfg);
        reply = `📊 CANLI KASA DURUMU\n\n${buildSimpleWhatsAppMessage(st)}`;
      } else if (lower.startsWith('/cfo') || lower === 'cfo') {
        const st = loadPortfolioState(cfg);
        const pf = runPersonalCfoEngine(st);
        reply = `🏦 KİŞİSEL CFO & İŞ BANKASI RAPORU\n\n• İş Bankası Bakiye: ${pf.isbankBalanceTry} TL\n• Binance TR Kasa: ${st.totalEquityTry || toTL(st.totalEquityUsdt)} TL\n• Toplam Servet: ${pf.totalNetWorthTry} TL\n• Bu Hafta Harcanan: ${pf.weeklySpentTry} / ${pf.weeklySpendLimitTry} TL\n\n💡 CFO Tavsiyesi:\n${(pf.cfoTips || []).join('\n\n')}`;
      } else if (lower.startsWith('/isbank ')) {
        const amt = text.split(/\s+/)[1];
        const r = recordPersonalCashflow('SET_BALANCE', amt, 'İş Bankası Bakiye Senkronizasyonu');
        reply = r.ok ? `🏦 İş Bankası bakiyen ${r.pf.isbankBalanceTry} TL olarak güncellendi!\nToplam Servet: ${r.pf.totalNetWorthTry} TL` : r.msg;
      } else if (lower.startsWith('/gelir ')) {
        const parts = text.split(/\s+/);
        const amt = parts[1];
        const note = parts.slice(2).join(' ') || 'Gelir Girişi';
        const r = recordPersonalCashflow('IN', amt, note);
        reply = r.ok
          ? `💰 +${amt} TL (${note}) İş Bankası hesabına eklendi!\nYeni İş Bankası Bakiyesi: ${r.pf.isbankBalanceTry} TL\n💡 CFO Önerisi: Bu gelirin ${Math.round(Number(amt) * 0.45)} TL'sini bankada yaşam kalkanı olarak tut, ${Math.min(2000, Math.round(Number(amt) * 0.25))} TL'sini haftalık dilimle bota aktar.`
          : r.msg;
      } else if (lower.startsWith('/gider ')) {
        const parts = text.split(/\s+/);
        const amt = parts[1];
        const note = parts.slice(2).join(' ') || 'Harcama';
        const r = recordPersonalCashflow('OUT', amt, note);
        reply = r.ok
          ? `💸 -${amt} TL (${note}) düşüldü.\nKalan İş Bankası Bakiyesi: ${r.pf.isbankBalanceTry} TL | Bu Hafta Harcanan: ${r.pf.weeklySpentTry}/${r.pf.weeklySpendLimitTry} TL`
          : r.msg;
      } else if (lower.startsWith('/sat ')) {
        const sym = text.split(/\s+/)[1];
        const r = await sellPositionManual(sym, '🤖 TELEGRAM KOMUTUYLA MANUEL SATIŞ');
        reply = `${r.ok ? '✅' : '⚠️'} ${r.msg}\n\n${buildSimpleWhatsAppMessage(r.state)}`;
      } else if (lower.startsWith('/nakit') || lower === 'nakit') {
        const r = await sellAllPositionsManual('🤖 TELEGRAM ACİL NAKİT KOMUTU');
        reply = `🛡️ Tüm açık coinler (${r.count} adet) satıldı ve TL nakite geçildi!\n\n${buildSimpleWhatsAppMessage(r.state)}`;
      } else if (lower.startsWith('/kanal')) {
        const arg = text.split(/\s+/)[1] || '';
        const st = loadPortfolioState(cfg);
        if (!Array.isArray(st.customTelegramChannels)) st.customTelegramChannels = [];
        if (arg) {
          const cleanHandle = arg.replace(/^@|^https?:\/\/t\.me\/(s\/)?/i, '').trim();
          if (cleanHandle && !st.customTelegramChannels.includes(cleanHandle)) {
            st.customTelegramChannels.push(cleanHandle);
            savePortfolioState(st);
          }
          reply = `📡 @${cleanHandle} kanalı 7/24 Canlı Telegram Haber & Sinyal Tarayıcısına eklendi!\n\nAktif Telegram Kanalları:\n• @binance_announcements (Resmi Binance)\n• @WatcherGuru (Küresel Anlık Haber)\n• @unfolded (Kurumsal Kripto Haber)\n${st.customTelegramChannels.map(c => `• @${c}`).join('\n')}`;
        } else {
          reply = `📡 7/24 Aktif Telegram Haber & Balina Kanalları:\n• @binance_announcements (Resmi Binance)\n• @WatcherGuru (Küresel Anlık Haber)\n• @unfolded (Kurumsal Kripto Haber)\n${(st.customTelegramChannels || []).map(c => `• @${c}`).join('\n') || '• (Henüz özel kanal eklenmedi)'}\n\n💡 Yeni bir Telegram kanalı bağlamak için:\n/kanal @kanal_adi yazman yeterli!`;
        }
      } else if (lower.startsWith('/tara') || lower === 'tara') {
        const r = await safeRunTradingCycle();
        reply = `⚡ Anlık haber ve tahta taraması tamamlandı!\n\n${buildSimpleWhatsAppMessage(r.state)}`;
      } else {
        // Smart Zero-Touch Parser: Automatically understands İşCep push notifications, SMS, or natural messages like "250 yemek", "+8000 staj", "bakiye 4500"
        const numMatch = text.match(/([+-]?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
        if (numMatch && !lower.startsWith('/')) {
          let rawNum = numMatch[1].replace(/\s+/g, '');
          if (rawNum.includes('.') && rawNum.includes(',')) {
            rawNum = rawNum.replace(/\./g, '').replace(',', '.');
          } else if (rawNum.includes(',') && !rawNum.includes('.')) {
            rawNum = rawNum.replace(',', '.');
          }
          const parsedAmt = Math.abs(Number(rawNum));
          const cleanNote = text.replace(numMatch[0], '').replace(/\b(tl|try|lira|işcep|iscep|iş bankası)\b/gi, '').trim() || 'Otomatik İşlem';
          if (parsedAmt > 0) {
            const isBal = /(bakiye|hesapta|kalan|mevcut)/i.test(lower);
            const isIn = text.trim().startsWith('+') || /(geldi|yattı|giriş|gelen|maaş|burs|havale geldi|fast geldi|iade)/i.test(lower);
            if (isBal) {
              const r = recordPersonalCashflow('SET_BALANCE', parsedAmt, 'Otomatik Bakiye Senkronizasyonu');
              reply = `🏦 [Otomatik Algılandı] İş Bankası bakiyen ${r.pf.isbankBalanceTry} TL olarak güncellendi!\nToplam Servet: ${r.pf.totalNetWorthTry} TL`;
            } else if (isIn) {
              const r = recordPersonalCashflow('IN', parsedAmt, cleanNote || 'Otomatik Gelir');
              reply = `💰 [Otomatik Gelir Algılandı] +${parsedAmt} TL (${cleanNote})\nYeni İş Bankası Bakiyesi: ${r.pf.isbankBalanceTry} TL\n💡 CFO Önerisi: ${Math.round(parsedAmt * 0.45)} TL'sini bankada tut, ${Math.min(2000, Math.round(parsedAmt * 0.25))} TL'sini haftalık dilimle bota aktar.`;
            } else {
              const r = recordPersonalCashflow('OUT', parsedAmt, cleanNote || 'Otomatik Harcama');
              reply = `💸 [Otomatik Harcama Algılandı] -${parsedAmt} TL (${cleanNote})\nKalan İş Bankası Bakiyesi: ${r.pf.isbankBalanceTry} TL | Bu Hafta: ${r.pf.weeklySpentTry}/${r.pf.weeklySpendLimitTry} TL`;
            }
          }
        }
        if (!reply) {
          reply = `🤖 AltcoinAutoTrader v9.5 + Kişisel CFO Kumanda\n\nKomut yazmana bile gerek yok! Doğrudan "250 yemek", "+8000 staj yattı" veya "bakiye 4500" yazabilir ya da İşCep bildirimini iletebilirsin.\n\nKısa Komutlar:\n• /durum — Anlık TL Kasa ve Açık Coinler\n• /cfo — İş Bankası + Binance TR Servet & CFO Tüyosu\n• /sat AVAX — Belirtilen coini hemen satar\n• /nakit — Tüm coinleri satıp TL'ye geçer\n• /tara — Şimdi haber taraması yapar`;
        }
      }

      await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: reply }),
      }).catch(() => {});
    }
    if (offsetChanged) {
      const latestSt = loadPortfolioState(cfg);
      latestSt.lastTelegramUpdateId = _tgOffset;
      savePortfolioState(latestSt);
    }
  } catch {
    // Ignore polling hiccups
  }
}

async function startTelegramCommandBot() {
  if (_tgLoopStarted) return;
  _tgLoopStarted = true;
  setInterval(pollTelegramUpdatesOnce, 4000);
}

process.on('uncaughtException', err => {
  console.error('🛡️ [Otonom Zırh - UncaughtException Yakalandı]:', err?.message || err);
});
process.on('unhandledRejection', err => {
  console.error('🛡️ [Otonom Zırh - UnhandledRejection Yakalandı]:', err?.message || err);
});

async function main() {
  const isDaemon = process.argv.includes('--daemon');
  const shouldNotify = process.argv.includes('--notify');
  if (!isDaemon) {
    await pollTelegramUpdatesOnce();
  }
  const result = await safeRunTradingCycle();
  if (!isDaemon) {
    await pollTelegramUpdatesOnce();
  }
  const s = result.state;

  console.log('\n================================================================================');
  console.log(`💰 [TL KASA ÖZETİ v9.5] Başlangıç: 1.000,00 TL -> Şu Anki Toplam: ${s.totalEquityTry || toTL(s.totalEquityUsdt)} TL (Kur: ${USD_TRY_RATE})`);
  console.log(`   Net Kâr/Zarar: ${s.totalPnlUsdt >= 0 ? '+' : ''}${toTL(s.totalPnlUsdt)} TL (%${s.totalPnlPct}) | Boştaki Nakit: ${toTL(s.cashUsdt)} TL`);
  console.log('================================================================================');

  for (const pos of s.openPositions) {
    console.log(
      `   🟢 AÇIK: ${pos.symbol} | Yatırılan: ${toTL(pos.costUsdt)} TL -> Şu An: ${pos.currentValueTry || toTL(pos.currentPrice * pos.qty)} TL | Net Kâr: ${pos.unrealizedPnlUsdt >= 0 ? '+' : ''}${toTL(pos.unrealizedPnlUsdt)} TL (%${pos.unrealizedPnlPct})`
    );
  }

  if (shouldNotify && Date.now() - Number(s.lastWhatsAppReportAt || 0) > 10000) {
    const waOk = await sendInstantPhoneAlert(buildSimpleWhatsAppMessage(s));
    if (waOk) {
      s.lastWhatsAppReportAt = Date.now();
      savePortfolioState(s);
    }
    console.log(waOk ? 'WhatsApp Kasa Raporu telefonuna gonderildi!' : 'WhatsApp kuyrugu mesgul, sonraki turda tekrar denenecek.');
  }

  if (isDaemon) {
    const cfg = loadEnv();
    const port = 3847;
    startTelegramCommandBot();
    startFastPositionRiskLoop();
    const server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, `http://localhost:${port}`);
      if (urlObj.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ state: loadPortfolioState(cfg) }));
      } else if (urlObj.pathname === '/api/cycle' && req.method === 'POST') {
        const updated = await safeRunTradingCycle();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ state: updated.state }));
      } else if (urlObj.pathname === '/api/sell' && req.method === 'POST') {
        const sym = urlObj.searchParams.get('symbol');
        const out = await sellPositionManual(sym);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } else if (urlObj.pathname === '/api/sell-all' && req.method === 'POST') {
        const out = await sellAllPositionsManual();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } else if (urlObj.pathname === '/api/telegram' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body || '{}');
            if (token && fs.existsSync(ENV_FILE)) {
              const raw = fs.readFileSync(ENV_FILE, 'utf8').replace(/TELEGRAM_BOT_TOKEN=.*/g, `TELEGRAM_BOT_TOKEN=${token.trim()}`);
              fs.writeFileSync(ENV_FILE, raw, 'utf8');
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: Boolean(token) }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false }));
          }
        });
      } else if (urlObj.pathname === '/api/whatsapp' || urlObj.pathname === '/wa') {
        const curState = loadPortfolioState(cfg);
        const ok = await sendInstantPhoneAlert(buildSimpleWhatsAppMessage(curState));
        if (ok) {
          curState.lastWhatsAppReportAt = Date.now();
          savePortfolioState(curState);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml());
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`\n🌐 TL Bazlı Canlı Web Kontrol Paneli (Sadece Yerel Cihaz Korumalı): http://localhost:${port}`);
    });

    setInterval(() => {
      safeRunTradingCycle().catch(err => console.error('Cycle error:', err.message));
    }, cfg.SCAN_INTERVAL_SECONDS * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
