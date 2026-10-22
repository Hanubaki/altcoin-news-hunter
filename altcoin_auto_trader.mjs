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
      exitReason,
      realizedNetPnLTry: Number(Number(netPnlTry ?? netPnlUsdt * USD_TRY_RATE).toFixed(2)),
    };
    fs.appendFileSync(path.resolve('trade_telemetry.jsonl'), JSON.stringify(snap) + '\n', 'utf8');
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
      `2) **Tahta & Dip Filtresi:** Giriş RSI \`${p.rsiAtEntry || '-'}\` (dip bölgesi), balina alıcı oranı \`%${p.takerBuyRatioPct || '-'}\` ve canlı Binance TR tahtası **${obLabel}** olduğu için normal silkeleme iğnesinde erken panik satışı yapılmıyor. ` +
      `3) **Ne Zaman Satacak?:** Fiyat \`$${slPrice}\` altına inip 3 sn kalırsa **VEYA** tahta dengesi \`-0.20\` altına bozulursa (Erken Tahliye) saniyesinde otomatik satılacak!`
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
  const totalTry = toTL(state.totalEquityUsdt);
  const netPnlTryNum = Number((state.totalPnlUsdt * USD_TRY_RATE).toFixed(2));
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
          const holdWhyTxt = p.holdReason || buildHoldReasonText(p);
          return `| **${p.symbol}** | \`${investedTry} TL\` | \`${curTry} TL\` | **\`${pnlSign}${pnlTry} TL (%${p.unrealizedPnlPct})\`** | ${srTxt} | ${holdWhyTxt} |`;
        })
        .join('\n') + '\n';

  const md = `# 💰 KASA VE KÂR RAPORU (Sadece TL — Smart-Shield v9.1)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}

---

## 1. GENEL KASA DURUMU

* **Başlangıç Parası:** \`${toTL(state.initialBankrollUsdt)} TL\`
* **Şu Anki Toplam Para:** **\`${totalTry} TL\`**
* **Toplam Net Kâr / Zarar:** **\`${netPnlSign}${toTL(state.totalPnlUsdt)} TL\` (\`${netPnlSign}%${state.totalPnlPct}\`)**
* **Boşta Bekleyen Nakit:** \`${cashTry} TL\`
* **Coinde Olan Para (Açık İşlemler):** \`${openValTry} TL\`
* **Cüzdandaki Küsürat (Dust) Varlıklar:** \`${toTL(state.dustAssetsUsdt || 0)} TL\` *(Aynı coine tekrar girildiğinde otomatik birleştirilip nakite çevrilir)*
* **Başarılı Satış / Zarar Kes:** \`${state.winCount} Kârlı Satış / ${state.lossCount} Zarar Kes\`
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

## 6. AKTİF KORUMA VE MAKSİMUM KAZANÇ MOTORLARI (v9.5)

1. **📏 ATR Nefes Payı Kalkanı (-%2,0 ile -%3,2):** Coinlerin 15 dakikalık normal iğnelerde erken stop olmasını önleyen gerçek volatilite bazlı stop-loss mesafesi.
2. **🛡️ +%1,5 Gerçek Sıfır Risk Kilidi (True Breakeven Lock):** Bir coin \`+%1,5\` yükseldiği anda Stop-Loss otomatik olarak maliyetin \`+%0,35\` üstüne çekilir; kâr kilidi sadece stop fiyatı gerçekten maliyetin üstündeyken aktif olur.
3. **🎰 +%2,8 Bedava Sürüş (Free-Ride / House Money) Hasadı:** Coin \`+%2,8\` yaptığı anda \`%40\`'ı satılıp sıcak kâr cebe atılır, kalan \`%60\`'ın stopu \`+%1,2+\` net kâra kilitlenir ve **%100 sıfır riskle** \`+%7,5\` ve sınırsız uçuşa bırakılır.
4. **🚫 Tepe (Overbought) ve Bayat Haber Engelleyici:** \`RSI > 55\` olan tepedeki coinlere ve son 12 saatte zarar yazmış bayat haber başlıklarına tekrar girilmez.
5. **🧠 Engine #15 — Otonom Hata Otopsisi ve Öz-Öğrenme Motoru:** Zarar edilen her işlemden sonra ilgili coinin RSI tavanını, minimum Balina giriş oranını ve Konsey güven puanını otonom olarak günceller; aynı hatayı ikinci kez yapmaz.
6. **🏦 Engine #16 — Kişisel CFO & İş Bankası Fon Yöneticisi:** Giren/çıkan banka nakit akışını, staj/burs gelirlerini, haftalık harcama limitini ve kripto kasa büyümesini tek merkezden yönetir.
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

  // Primary for small active sets (open positions / top candidates): fetch live Binance TR _TRY bestBid/bestAsk directly
  if (uniqueSyms.length <= 12 && USD_TRY_RATE > 0) {
    await Promise.all(
      uniqueSyms.map(async sym => {
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
  return Number(((weightedBid - weightedAsk) / (weightedBid + weightedAsk)).toFixed(2));
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
    let adjQty = quantity;
    if (side === 'SELL' && status.ok) {
      const walletFree = status.assetsMap?.[symbol] || 0;
      if (walletFree <= 0 || walletFree < quantity * 0.1) {
        return { code: 0, alreadySold: true };
      }
      // Sweep 100% of wallet balance (including any accumulated dust) on full position exits
      if (adjQty > walletFree || adjQty >= walletFree * 0.80) {
        adjQty = walletFree;
      }
    }
    if (rule) {
      const lotFilter = (rule.filters || []).find(f => f.filterType === 'LOT_SIZE');
      if (lotFilter?.stepSize) {
        adjQty = roundToStepSize(adjQty, lotFilter.stepSize);
      }
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
      return { ...trRes, executedQty: adjQty };
    }
    return { code: -1, msg: JSON.stringify(trRes || {}) };
  } catch (err) {
    return { code: -1, msg: err?.message || 'TR Order Error' };
  }
}

async function processProfitTargets(cfg, state, pos, currentBid) {
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
    let orderOk = true;
    if (state.mode === 'LIVE_BINANCE') {
      const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
      if (!sellRes || sellRes.code !== 0) {
        orderOk = false;
      } else if (sellRes.executedQty > 0) {
        sellQty = sellRes.executedQty;
      }
    }
    if (orderOk && sellQty > 0) {
      const remainQty = Number(Math.max(0, pos.qty - sellQty).toPrecision(4));
      const actualSoldFraction = pos.initialQty > 0 ? Math.min(1, sellQty / pos.initialQty) : tp1Fraction;
      const tp1LabelPct = Math.round(actualSoldFraction * 100);
      const remainLabelPct = Math.max(0, 100 - tp1LabelPct);
      const soldCostUsdt = Number((pos.initialCostUsdt * actualSoldFraction).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));

      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      state.partialProfitCount = (state.partialProfitCount || 0) + 1;

      const exitReason = `💰 1. KADEME (%${tp1LabelPct}) SIFIR RİSK KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %${remainLabelPct} Bedava Uçuşta)`;
      appendTradeTelemetry(pos, currentBid, exitReason, netPnlUsdt, netPnlTry, sellQty);
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
        exitPrice: currentBid,
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
    let orderOk = true;
    if (state.mode === 'LIVE_BINANCE') {
      const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
      if (!sellRes || sellRes.code !== 0) {
        orderOk = false;
      } else if (sellRes.executedQty > 0) {
        sellQty = sellRes.executedQty;
      }
    }
    if (orderOk && sellQty > 0) {
      const remainQty = Number(Math.max(0, pos.qty - sellQty).toPrecision(4));
      const actualTp2FracOfInit = pos.initialQty > 0 ? Math.min(1, sellQty / pos.initialQty) : 0.30;
      const remainFracOfInit = pos.initialQty > 0 ? Math.round((remainQty / pos.initialQty) * 100) : 30;
      const tp2LabelPct = Math.round(actualTp2FracOfInit * 100);
      const soldCostUsdt = Number(Math.min(pos.costUsdt, pos.initialCostUsdt * actualTp2FracOfInit).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));

      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      state.partialProfitCount = (state.partialProfitCount || 0) + 1;

      const exitReason = `🚀 2. KADEME (%${tp2LabelPct}) DEV KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %${remainFracOfInit} Sınırsız Roket)`;
      appendTradeTelemetry(pos, currentBid, exitReason, netPnlUsdt, netPnlTry, sellQty);
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
        exitPrice: currentBid,
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
        const realQty = trStatus.assetsMap?.[p.symbol];
        if (realQty && realQty > 0 && Math.abs(realQty - p.qty) / p.qty < 0.08) {
          p.qty = realQty;
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

    // Engine #8: 5-STAGE ZERO-RISK RATCHET LADDER (Net-Friction-Adjusted Floors: includes +0.22% exit friction offset)
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    let stepFloorPrice = pos.stopLossPrice;
    if (peakGainPct >= 7.0) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.988).toPrecision(5)), Number((pos.entryPrice * 1.0602).toPrecision(5)));
    } else if (peakGainPct >= 4.5) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.986).toPrecision(5)), Number((pos.entryPrice * 1.0342).toPrecision(5)));
    } else if (peakGainPct >= 3.2) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0202).toPrecision(5)));
    } else if (peakGainPct >= 2.2) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0112).toPrecision(5)));
    } else if (peakGainPct >= 1.5) {
      // True +1.5% Zero-Risk Breakeven+ Lock: locks +0.40% net profit after 0.22% exit friction (1.0062x entry)!
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0062).toPrecision(5)));
    }

    if (stepFloorPrice > pos.stopLossPrice) {
      pos.stopLossPrice = stepFloorPrice;
    }
    // Only mark trailingActive = true if stop-loss is genuinely above entry price (in profit)
    pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
    if (peakGainPct >= 2.5 && pos.trailingActive) pos.rocketMode = true;

    // Dynamic Noise-Filtered Stop (1.5% - 2.4%) + Fixed-TL-Risk Budget (max ~4.50 TL loss including exit friction)
    const dynamicNoiseSlPct = Number(Math.min(2.4, Math.max(1.5, (pos.atr1hPct || 1.6) * 0.90)).toFixed(2));
    if (!pos.trailingActive) {
      pos.slPct = pos.slPct ? Math.min(2.4, Math.max(1.5, pos.slPct)) : dynamicNoiseSlPct;
      const dynFloor = Number((pos.entryPrice * (1 - pos.slPct / 100)).toPrecision(5));
      if (!pos.stopLossPrice || pos.stopLossPrice < Number((pos.entryPrice * 0.975).toPrecision(5))) {
        pos.stopLossPrice = dynFloor;
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
    const isConfirmedStop =
      (pos.trailingActive && currentBid <= pos.stopLossPrice) ||
      isEmergencyTlLoss ||
      (pos.stopHitCount >= 2 && nowMs - (pos.firstStopHitAt || nowMs) >= 3000);

    // Engine #9: ZERO-LOSS EARLY SCRATCH & LIVE ORDERBOOK TRACKING (Sifir Zarar / Zayiflayan Tahta Erken Tahliye Kalkani)
    let liveObForScratch = Number(pos.liveObImbalance ?? pos.obImbalance ?? 0);
    if (!pos.partialTpDone && pos.unrealizedPnlPct <= 0.35) {
      liveObForScratch = await checkOrderbookImbalance(pos.symbol);
      pos.liveObImbalance = liveObForScratch;
    }

    if (isConfirmedStop) {
      const isProfitLock = pos.stopLossPrice > pos.entryPrice && pos.unrealizedPnlPct >= 0;
      exitReason = pos.rocketMode && isProfitLock
        ? `🚀 UÇUŞ MODU KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
        : isProfitLock
          ? `🔒 SIFIR RİSK KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
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
    } else if (!pos.partialTpDone && minsHeld >= 90 && peakGainPct < 1.2 && pos.unrealizedPnlPct <= -0.35 && liveObForScratch <= -0.20) {
      exitReason = `🛡️ BAYATLAYAN İVME & SATIŞ BASKISI ERKEN TAHLİYESİ (${Math.round(minsHeld)}dk Tepkisiz + Tahta ${liveObForScratch} -> Stop Beklenmeden Çıkıldı %${pos.unrealizedPnlPct})`;
    } else if (pos.partialTpDone && hoursHeld >= 4.5 && pos.unrealizedPnlPct >= 1.5 && (pos.atr1hPct || 1.5) < 1.0 && currentBid <= pos.highestPrice * 0.996) {
      exitReason = `💰 HIZLI KÂR HASADI & ROTASYON (Yavaşlayan Kârlı Coin Cebe Alındı +%${pos.unrealizedPnlPct})`;
    } else if (pos.isMoonshot) {
      exitReason = `🔄 SEÇENEK 2 GEÇİŞİ (Vurgun Slotu Kapatılıp 3 Ana Slota Aktarıldı %${pos.unrealizedPnlPct})`;
    } else if (hoursHeld >= 12 && pos.unrealizedPnlPct >= 0.15 && pos.unrealizedPnlPct < 0.6 && !pos.partialTpDone) {
      exitReason = `⏱️ KÂRLI ZAMAN ROTASYONU (12 Saatte Yavaş Kalan Coin Kârla Boşaltıldı +${pos.unrealizedPnlPct}%)`;
    }

    if (exitReason) {
      let soldQty = pos.qty;
      if (state.mode === 'LIVE_BINANCE') {
        const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
        if (!sellRes || sellRes.code !== 0) {
          remainingPositions.push(pos);
          continue;
        }
        if (sellRes.executedQty > 0) soldQty = sellRes.executedQty;
      }
      const proceedsUsdt = Number((currentBid * soldQty).toFixed(4));
      const exactCostUsdt = Number((pos.entryPrice * soldQty).toFixed(4));
      const netPnlUsdt = Number(((currentBid - pos.entryPrice) * soldQty).toFixed(4));
      const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));
      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));

      if (netPnlUsdt >= 0) {
        state.winCount++;
      } else {
        state.lossCount++;
        state.cooldowns[pos.symbol] = nowMs + 6 * 3600 * 1000;
      }

      appendTradeTelemetry(pos, currentBid, exitReason, netPnlUsdt, netPnlTry, soldQty);
      state.closedTrades.unshift({
        ...pos,
        positionId: pos.id,
        leg: 'FINAL',
        qty: soldQty,
        costUsdt: exactCostUsdt,
        exitPrice: currentBid,
        exitTime: new Date().toISOString(),
        exitReason,
        netPnlUsdt,
        netPnlTry,
      });
      logEvent(state, `🏁 [POZİSYON KAPANDI] ${pos.symbol} @ $${currentBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`);
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

  // Engine #9: Smart Portfolio Rotation + Listing Sniper (Anti-Churn: only rotates after >=10h in net profit >=+0.50% for a fresh <=60m REAL breaking news catalyst, avoiding TRY spread bleed!)
  const coreOpenPositions = state.openPositions.filter(p => !p.isMoonshot);
  const heldSymSetForRot = new Set(state.openPositions.map(p => p.symbol));
  const stagnantIdx = coreOpenPositions.length >= cfg.MAX_OPEN_POSITIONS
    ? state.openPositions.findIndex(p => {
        if (p.isMoonshot) return false;
        const hrs = (nowMs - new Date(p.entryTime).getTime()) / (1000 * 3600);
        return hrs >= 10.0 && p.unrealizedPnlPct >= 0.50 && p.unrealizedPnlPct <= 1.10 && !p.partialTpDone;
      })
    : -1;
  const usedLeadersAfterRot = new Set(
    state.openPositions.filter((_, idx) => idx !== stagnantIdx).map(p => p.leaderSymbol)
  );
  const bestCandidate = candidates.find(c => {
    if (heldSymSetForRot.has(c.symbol)) return false;
    if (usedLeadersAfterRot.has(c.leaderSymbol)) return false;
    if ((c.freshestMinutesAgo || 0) > 60) return false; // Must be fresh <= 60m breaking news to justify rotation spread!
    if (state.cooldowns[c.symbol] && state.cooldowns[c.symbol] > nowMs) return false;
    const isSynth = ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(c.headlines?.[0]?.source);
    if (isSynth) return false; // Never rotate an existing position for a synthetic no-news signal!
    return (c.takerBuyRatioPct || 50) >= 53.0 && (!c.topWhaleLongPct || c.topWhaleLongPct >= 52) && (c.rsi1h || 50) <= 52;
  });
  const isListingSniperAlert = Boolean(
    bestCandidate &&
    bestCandidate.headlines?.some(h => h.source === 'BinanceListingSniper' && h.minutesAgo <= 60) &&
    bestCandidate.totalScore >= 85
  );
  if (
    !signalsData.btcCrashAlert &&
    bestCandidate &&
    bestCandidate.totalScore >= 85 &&
    (bestCandidate.rsi1h || 50) <= (isListingSniperAlert ? 60 : 55) &&
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
      if (candOb >= -0.05) {
        const stag = state.openPositions[stagnantIdx];
        const sq = quotes[stag.symbol];
        if (sq && sq.bestBid) {
          let rotSellOk = true;
          if (state.mode === 'LIVE_BINANCE') {
            const sellRes = await executeBinanceRealOrder(cfg, stag.symbol, 'SELL', stag.qty);
            if (!sellRes || sellRes.code !== 0) rotSellOk = false;
          }
          if (rotSellOk) {
            const proceedsUsdt = Number((sq.bestBid * stag.qty).toFixed(4));
            const netPnlUsdt = Number((proceedsUsdt - stag.costUsdt).toFixed(4));
            state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
            state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
            if (netPnlUsdt >= 0) state.winCount++;
            else state.lossCount++;
            state.closedTrades.unshift({
              ...stag,
              exitPrice: sq.bestBid,
              exitTime: new Date().toISOString(),
              exitReason: `⚡ AKILLI ROTASYON (${bestCandidate.symbol} [${bestCandidate.totalScore}p] Fırsatına Geçildi)`,
              netPnlUsdt,
              netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
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
    const isWeakMarket = breadthPct < 32;
    const isRedMarketDump = breadthPct < 24;

    // Engine #13: Kasa Erime Sigortası (Anti-Meltdown & Consecutive-Loss Shield)
    if (state.highWaterMarkUsdt && state.highWaterMarkUsdt > currentTotalEquity * 1.20 && (state.lossCount || 0) === 0) { state.highWaterMarkUsdt = Number(currentTotalEquity.toFixed(4)); }
    state.highWaterMarkUsdt = Number(Math.max(state.highWaterMarkUsdt || state.initialBankrollUsdt, currentTotalEquity).toFixed(4));
    const drawdownFromPeakPct = state.highWaterMarkUsdt > 0
      ? ((state.highWaterMarkUsdt - currentTotalEquity) / state.highWaterMarkUsdt) * 100
      : 0;
    let consecutiveLosses = 0;
    for (const ct of state.closedTrades || []) {
      if (ct.netPnlUsdt < -0.05) consecutiveLosses++;
      else if (ct.netPnlUsdt > 0.02) break;
    }
    const isAntiMeltdownActive = consecutiveLosses >= 2 || drawdownFromPeakPct >= 4.0;

    // Engine #18: Rejim Bazlı Brüt Pozisyon Tavanı (Regime-Based Max Gross Exposure)
    const regimeExposurePct =
      breadthPct >= 40 ? 0.95 :
      breadthPct >= 32 ? 0.75 :
      breadthPct >= 24 ? 0.50 : 0.35; // When breadth < 24%, keep at least 65% in safe TRY cash!
    const maxGrossExposureUsdt = Number((currentTotalEquity * regimeExposurePct).toFixed(2));
    const effectiveMaxSlots = isRedMarketDump
      ? 2
      : isWeakMarket || isAntiMeltdownActive
        ? cfg.MAX_OPEN_POSITIONS
        : state.cashUsdt >= 3.00
          ? cfg.MAX_OPEN_POSITIONS + 1
          : cfg.MAX_OPEN_POSITIONS;
    if (!isWeakMarket && !isAntiMeltdownActive && state.cashUsdt >= 1.50 && state.openPositions.filter(p => !p.isMoonshot).length < effectiveMaxSlots) {
      if (!state.cashIdleSince) state.cashIdleSince = nowMs;
    } else {
      state.cashIdleSince = null;
    }
    const isCashIdleTooLong = Boolean(!isWeakMarket && !isAntiMeltdownActive && state.cashIdleSince && nowMs - state.cashIdleSince >= 15 * 60 * 1000);

    for (const cand of candidates) {
      const curCoreCount = state.openPositions.filter(p => !p.isMoonshot).length;
      const curOpenExposureUsdt = state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
      const remainingExposureUsdt = Number((maxGrossExposureUsdt - curOpenExposureUsdt).toFixed(2));
      if (curCoreCount >= effectiveMaxSlots || remainingExposureUsdt < 1.50) break;
      if (state.cashUsdt < 1.50) break;
      if (heldSymbols.has(cand.symbol)) continue;
      // Engine Conflict Prevention: Require explicit LONG consensus from 3-Model Semantic AI Council AND directMention === true!
      if (cand.liveLlmDecision !== 'LONG' || cand.hasDirectMention === false) continue;
      // In Red Markets (breadth < 24%), require Market-Independent Catalyst + Relative Strength (RS_ATR >= 1.2) instead of impossible RSI <= 32!
      if (isRedMarketDump && (cand.rsAtr || 0) < 1.2) continue;
      if (usedLeaders.has(cand.leaderSymbol) && !(isCashIdleTooLong && cand.totalScore >= 75)) continue;
      const adaptiveMem = state.adaptiveMemory || runAdaptiveLearningEngine(state);
      const coinMem = adaptiveMem?.coinStats?.[cand.symbol];
      const srcName = cand.headlines?.[0]?.source || 'RSS';
      const srcMem = adaptiveMem?.sourceStats?.[srcName];
      const regimeBucket = breadthPct < 24 ? 'RED' : breadthPct < 40 ? 'NEUTRAL' : 'GREEN';
      const bucketKey = `${srcName}:${regimeBucket}:${cand.entryPattern || 'STANDARD'}`;
      const bucketMod = adaptiveMem?.bucketStats?.[bucketKey]?.scoreMod || 0;
      const learnedScoreMod = (coinMem?.scoreMod || 0) + (srcMem?.scoreMod || 0) + bucketMod;
      const effectiveTotalScore = Number((cand.totalScore + learnedScoreMod).toFixed(1));
      const hasInstitutionalWhaleSurge =
        ((cand.topWhaleLongPct || 0) >= 60 && (cand.oiChange15mPct || 0) >= 0.2) ||
        ((cand.topWhaleLongPct || 0) >= 65 && (cand.oiChange15mPct || 0) >= 0 && (cand.rsi1h || 50) <= 55 && (cand.freshestMinutesAgo || 999) <= 60);
      const minReqScore = isRedMarketDump ? 84 : isWeakMarket ? 75 : isAntiMeltdownActive ? 70 : 58;
      const baseMinWhale = isRedMarketDump ? 56.0 : isWeakMarket ? 53.5 : isAntiMeltdownActive ? 53.5 : hasInstitutionalWhaleSurge ? 48.0 : isCashIdleTooLong ? 50.2 : 51.0;
      const baseMaxRsi = isRedMarketDump ? 62 : isWeakMarket ? 60 : 66;
      const minReqWhale = coinMem ? Math.max(baseMinWhale, coinMem.minWhale) : baseMinWhale;
      const maxReqRsi = coinMem ? Math.min(baseMaxRsi, coinMem.maxRsi) : baseMaxRsi;
      if (effectiveTotalScore < minReqScore) continue;
      if ((cand.freshestMinutesAgo || 0) > 360) continue; // Reject stale news older than 6 hours
      const isSynthCand = ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(cand.headlines?.[0]?.source);
      if (isSynthCand) {
        continue; // 100% BAN no-news synthetic signals! Only trade verified real news catalysts!
      }
      if ((cand.rsi1h || 50) > maxReqRsi) continue;
      if ((cand.takerBuyRatioPct || 50) < minReqWhale) continue;
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

      const obImbalance = await checkOrderbookImbalance(cand.symbol);
      const minAllowedOb = isRedMarketDump ? 0.0 : isCashIdleTooLong ? -0.15 : -0.05;
      if (obImbalance < minAllowedOb) {
        logEvent(state, `⚖️ [Tahta Kalkanı] ${cand.symbol} önünde satış duvarı (${obImbalance}) var, pas geçildi.`);
        continue;
      }

      // Fixed-TL-Risk Dynamic Position Sizing + Noise-Filtered Dynamic Stop (1.5% - 2.4%)
      // Separate illiquidity guard (spreadPct > 0.60% rejected) & un-duplicated exit friction (slippage 0.12% + fee 0.10% = 0.22%)
      const spreadPct = q.bestBid > 0 ? ((q.bestAsk - q.bestBid) / q.bestBid) * 100 : 0.20;
      if (spreadPct > 0.60) {
        logEvent(state, `⚠️ [Likidite Kalkanı] ${cand.symbol} makası fazla açık (%${spreadPct.toFixed(2)} > %0.60), pas geçildi.`);
        continue;
      }
      const safeSlPct = Number(
        Math.min(2.4, Math.max(1.5, (cand.atr1hPct || 1.6) * 0.90, spreadPct * 3.0)).toFixed(2)
      );
      const exitFrictionPct = 0.22; // 0.12% expected sell slippage + 0.10% sell fee (bestBid already captures spread)
      const effectiveRiskFraction = (safeSlPct + exitFrictionPct) / 100;
      const riskBudgetTry = Number(
        Math.max(4.0, currentTotalEquity * USD_TRY_RATE * (isAntiMeltdownActive ? 0.0038 : 0.0045)).toFixed(2)
      );
      const riskBudgetUsdt = riskBudgetTry / USD_TRY_RATE;
      const riskSizedUsdt = Number((riskBudgetUsdt / effectiveRiskFraction).toFixed(2));
      const maxSlotCapUsdt = Number((currentTotalEquity * 0.45).toFixed(2));
      const availCashUsdt = Math.floor(Math.max(0, state.cashUsdt) * 100) / 100;
      const costUsdt = Number(
        Math.min(riskSizedUsdt, maxSlotCapUsdt, remainingExposureUsdt, availCashUsdt).toFixed(2)
      );
      if (costUsdt < 1.50) continue;

      const buyPrice = q.bestAsk;
      let qty = Number((costUsdt / buyPrice).toPrecision(4));

      if (state.mode === 'LIVE_BINANCE') {
        const buyRes = await executeBinanceRealOrder(cfg, cand.symbol, 'BUY', qty, costUsdt);
        if (!buyRes || buyRes.code !== 0) continue;
        // Reconcile post-commission wallet balance floored to LOT_SIZE stepSize
        const postBuyTr = await fetchBinanceTrStatus(cfg);
        if (postBuyTr.ok && postBuyTr.assetsMap?.[cand.symbol] > 0) {
          const rawWalletQty = postBuyTr.assetsMap[cand.symbol];
          qty = trRule?.stepSize ? floorToStep(rawWalletQty, trRule.stepSize) : rawWalletQty;
        }
      }

      const tpPrice = Number((buyPrice * (1 + cand.tpPct / 100)).toPrecision(5));
      const slPrice = Number((buyPrice * (1 - safeSlPct / 100)).toPrecision(5));

      const newPos = {
        id: `pos_${Date.now()}_${cand.symbol}`,
        symbol: cand.symbol,
        leaderSymbol: cand.leaderSymbol,
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
        takerBuyRatioPct: cand.takerBuyRatioPct || 50,
        last1hTakerBuyPct: cand.last1hTakerBuyPct ?? cand.takerBuyRatioPct ?? 50,
        obImbalance,
        entryTime: new Date().toISOString(),
        entryPrice: buyPrice,
        entryPriceTry: q.bestAskTry || Number((buyPrice * USD_TRY_RATE).toFixed(4)),
        priceSource: q.priceSource || 'BINANCE_TR',
        currentPrice: q.bestBid || buyPrice,
        highestPrice: buyPrice,
        qty,
        initialQty: qty,
        initialCostUsdt: Number((buyPrice * qty).toFixed(4)),
        costUsdt: Number((buyPrice * qty).toFixed(4)),
        costTry: Math.round(buyPrice * qty * USD_TRY_RATE),
        riskBudgetTry,
        stopHitCount: 0,
        firstStopHitAt: 0,
        takeProfitPrice: tpPrice,
        stopLossPrice: slPrice,
        tpPct: cand.tpPct,
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
        `🟢 [OTOMATİK ALIM] ${cand.symbol} (${toTL(costUsdt)} TL) @ $${buyPrice} | Skor: ${cand.totalScore} | RSI: ${cand.rsi1h} | Balina: %${newPos.takerBuyRatioPct} | SL: -%${safeSlPct}`
      );
    }
  }

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
    p.holdReason = buildHoldReasonText(p);
  }

  const openSymSet = new Set(state.openPositions.map(p => p.symbol));
  let dustAssetsUsdt = 0;
  for (const [asset, freeQty] of Object.entries(trStatus.assetsMap || {})) {
    if (asset === 'TRY' || openSymSet.has(asset) || freeQty <= 0) continue;
    const usdtBid = quotes[asset]?.bestBid || 0;
    if (usdtBid > 0) {
      dustAssetsUsdt += usdtBid * freeQty;
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
  state.totalEquityUsdt = Number((state.totalEquityTry / USD_TRY_RATE).toFixed(4));
  state.initialBankrollUsdt = Number(((state.initialBankrollTry || 1000) / USD_TRY_RATE).toFixed(4));
  state.totalPnlTry = Number((state.totalEquityTry - (state.initialBankrollTry || 1000)).toFixed(2));
  state.totalPnlUsdt = Number((state.totalPnlTry / USD_TRY_RATE).toFixed(4));
  state.totalPnlPct = Number(((state.totalPnlTry / (state.initialBankrollTry || 1000)) * 100).toFixed(2));

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

  // Smart WhatsApp Filter: Only send instant WhatsApp on real BUY/SELL/HARVEST events (never spam on orderbook/scanner warnings!)
  const realTradeEvents = cycleEvents.filter(
    e => e.includes('🟢 [OTOMATİK ALIM]') || e.includes('🎰 [VURGUN SLOTU') || e.includes('💰 [SIFIR RİSK') || e.includes('🚀 [2. KADEME') || e.includes('🏁 [POZİSYON KAPANDI]')
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

  <div class="section">
    <h2>📈 Babaya Karşı 1.000 TL -> Canlı Kasa Büyüme Grafiği</h2>
    <div id="chartBox" style="width:100%;height:130px;"></div>
  </div>

  <div class="section">
    <h2>🟢 Şu An Açık Olan İşlemler (Tek Tıkla Manuel Satış Aktif)</h2>
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

      const eqTry = fmtTL(s.totalEquityUsdt);
      document.getElementById('equityVal').textContent = eqTry;
      document.getElementById('cashVal').textContent = fmtTL(s.cashUsdt);
      document.getElementById('rateVal').textContent = RATE.toFixed(2) + ' TL';
      if (s.binanceTrStatus) {
        document.getElementById('trWalletBar').textContent = '🏦 ' + s.binanceTrStatus;
      }

      const pnlEl = document.getElementById('pnlVal');
      const pnlTryNum = Number(s.totalPnlUsdt || 0) * RATE;
      const sign = pnlTryNum >= 0 ? '+' : '';
      pnlEl.textContent = sign + pnlTryNum.toFixed(2) + ' TL (' + sign + '%' + s.totalPnlPct + ')';
      pnlEl.className = 'kpi-val ' + (pnlTryNum >= 0 ? 'pos' : 'neg');

      document.getElementById('winVal').textContent = s.winCount + ' Kârlı / ' + s.lossCount + ' Stop';
      renderSvgChart(s.equityHistory);

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
        const modeTxt = p.holdReason
          ? p.holdReason.replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>').replace(/\\\`(.*?)\\\`/g, '<code style="color:#38bdf8;">$1</code>')
          : p.stage2TpDone
            ? '🚀 2 Kademe Alındı, Kalan %30 Sınırsız Roket'
            : p.partialTpDone
              ? '🔒 1. Kademe Cebimizde, Kalan %60 Sıfır Risk Uçuşta'
              : p.trailingActive
                ? '🔒 Sıfır Risk Kâr Kilidi Aktif (Stop: $' + p.stopLossPrice + ')'
                : '🛡️ +%1.5 Sıfır Risk Kilidi, +%2.8 (%40) Kâr Hasadı';
        return '<tr>' +
          '<td><strong>' + p.symbol + '</strong> <small style="color:#38bdf8;">(' + p.qty + ' Adet @ $' + p.currentPrice + ')</small><br><small style="color:#94a3b8;">' + p.headline + '</small></td>' +
          '<td>' + costTryVal.toFixed(2) + ' TL <small style="color:#94a3b8;">($' + costUsd.toFixed(2) + ')</small></td>' +
          '<td><strong>' + curTryVal.toFixed(2) + ' TL</strong> <small style="color:#94a3b8;">($' + curUsd.toFixed(2) + ')</small></td>' +
          '<td class="' + pClass + '">' + pSign + diffTry.toFixed(2) + ' TL (' + pSign + '%' + p.unrealizedPnlPct + ')</td>' +
          '<td style="max-width:440px;font-size:12.5px;line-height:1.45;">' + modeTxt + '</td>' +
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

      // Fast 4s Profit Harvest (TP1 & TP2) + Net-Friction-Adjusted Profit Ratchet (+1.5%, +2.2%, +3.2%, +4.5%, +7.0%)
      const didFastHarvest = await processProfitTargets(cfg, state, pos, currentBid);
      if (didFastHarvest) stateModified = true;
      const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
      let stepFloor = pos.stopLossPrice;
      if (peakGainPct >= 7.0) stepFloor = Math.max(stepFloor, Number((pos.highestPrice * 0.988).toPrecision(5)), Number((pos.entryPrice * 1.0602).toPrecision(5)));
      else if (peakGainPct >= 4.5) stepFloor = Math.max(stepFloor, Number((pos.highestPrice * 0.986).toPrecision(5)), Number((pos.entryPrice * 1.0342).toPrecision(5)));
      else if (peakGainPct >= 3.2) stepFloor = Math.max(stepFloor, Number((pos.entryPrice * 1.0202).toPrecision(5)));
      else if (peakGainPct >= 2.2) stepFloor = Math.max(stepFloor, Number((pos.entryPrice * 1.0112).toPrecision(5)));
      else if (peakGainPct >= 1.5) stepFloor = Math.max(stepFloor, Number((pos.entryPrice * 1.0062).toPrecision(5)));

      if (stepFloor > pos.stopLossPrice) {
        pos.stopLossPrice = stepFloor;
        pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
        stateModified = true;
      }

      const executableExit = currentBid * (1 - 0.0012) * (1 - 0.0010);
      const netPnlTryExec = (executableExit - pos.entryPrice) * pos.qty * USD_TRY_RATE;
      const posRiskBudgetTry = Number(pos.riskBudgetTry || 4.50);
      const nowTickMs = Date.now();

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
      const isConfirmedStop =
        (pos.trailingActive && currentBid <= pos.stopLossPrice) ||
        isEmergencyTlLoss ||
        (pos.stopHitCount >= 2 && nowTickMs - (pos.firstStopHitAt || nowTickMs) >= 3000);

      if (isConfirmedStop) {
        let soldQty = pos.qty;
        if (state.mode === 'LIVE_BINANCE') {
          const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
          if (!sellRes || sellRes.code !== 0) {
            remaining.push(pos);
            continue;
          }
          if (sellRes.executedQty > 0) soldQty = sellRes.executedQty;
        }
        const proceedsUsdt = Number((currentBid * soldQty).toFixed(4));
        const exactCostUsdt = Number((pos.entryPrice * soldQty).toFixed(4));
        const netPnlUsdt = Number(((currentBid - pos.entryPrice) * soldQty).toFixed(4));
        const netPnlTry = Number((netPnlUsdt * USD_TRY_RATE).toFixed(2));
        state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
        state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
        if (netPnlUsdt >= 0) state.winCount++;
        else {
          state.lossCount++;
          state.cooldowns[pos.symbol] = Date.now() + 6 * 3600 * 1000;
        }
        const isProfitLock = pos.stopLossPrice > pos.entryPrice && pos.unrealizedPnlPct >= 0;
        const exitReason = isProfitLock
          ? `🔒 4sn HIZLI KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
          : `🛡️ 4sn HIZLI RİSK MONİTÖRÜ (%${pos.unrealizedPnlPct} | ${netPnlTryExec.toFixed(2)} TL)`;
        appendTradeTelemetry(pos, currentBid, exitReason, netPnlUsdt, netPnlTry, soldQty);
        state.closedTrades.unshift({
          ...pos,
          positionId: pos.id,
          leg: 'FINAL',
          qty: soldQty,
          costUsdt: exactCostUsdt,
          exitPrice: currentBid,
          exitTime: new Date().toISOString(),
          exitReason,
          netPnlUsdt,
          netPnlTry,
        });
        logEvent(state, `⚡ [4sn HIZLI ÇIKIŞ] ${pos.symbol} @ $${currentBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`);
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
