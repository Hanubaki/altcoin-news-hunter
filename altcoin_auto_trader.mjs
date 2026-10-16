#!/usr/bin/env node
/**
 * AltcoinAutoTrader v6.0 — Full-Protection Autonomous News-Sympathy Execution Engine
 *
 * 7 Built-in Institutional Protections & Profit Maximizers:
 * 1. 🛡️ BTC Çöküş Kalkanı (BTC Crash Circuit Breaker): Halts new buys & tightens stops if BTC drops >= 1.8% in 1h
 * 2. ⚖️ Tahta Duvar Kontrolü (Orderbook Depth Imbalance): Checks top-10 Bid vs Ask walls before buying
 * 3. 💰 Kademeli Kâr Al + Sınırsız Roket Modu (50% Partial TP at +4.5% + Uncapped Moonbag Runner)
 * 4. 📏 Dinamik ATR Volatilite Stop-Loss: Adapts stop distance to each coin's real hourly volatility
 * 5. ⏱️ Zaman Kilidi (18h Time-Stop): Auto-exits stagnant coins that fail to move after 18 hours
 * 6. 🧊 Zarar Sonrası Soğuma Kilidi (6h Cooldown Blacklist): Never re-buys a coin that hit SL for 6 hours
 * 7. 📊 Otomatik TL Raporlayıcı: Automatically writes a clean, 100% Turkish Lira (TL) RAPOR.md on every cycle
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { runNewsScan } from './altcoin_news_hunter.mjs';

const STATE_FILE = path.resolve('portfolio_state.json');
const SIGNALS_FILE = path.resolve('altcoin_news_signals.json');
const RAPOR_FILE = path.resolve('RAPOR.md');
const ENV_FILE = path.resolve('.env');

const BINANCE_API = 'https://api.binance.com/api/v3';
const USD_TRY_RATE = 35.7;

function loadEnv() {
  const cfg = {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
    LIVE_TRADING: process.env.LIVE_TRADING === 'true',
    BANKROLL_TRY: Number(process.env.BANKROLL_TRY || 1000),
    BANKROLL_USDT: Number(process.env.BANKROLL_USDT || 28.01),
    MAX_OPEN_POSITIONS: Number(process.env.MAX_OPEN_POSITIONS || 3),
    ORDER_SIZE_USDT: Number(process.env.ORDER_SIZE_USDT || 9.30), // ~332 TL x 3 = ~1,000 TL tam kasa kullanımı
    SCAN_INTERVAL_SECONDS: Number(process.env.SCAN_INTERVAL_SECONDS || 45),
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
      if (key === 'ORDER_SIZE_USDT' && val) cfg.ORDER_SIZE_USDT = Number(val);
      if (key === 'SCAN_INTERVAL_SECONDS' && val) cfg.SCAN_INTERVAL_SECONDS = Number(val);
    }
  }
  return cfg;
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

function writeCleanTlReport(state) {
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
    ? '| *Şu an açık işlem yok (Yeni güçlü haber bekleniyor)* | - | - | - | - |\n'
    : state.openPositions
        .map(p => {
          const investedTry = toTL(p.costUsdt);
          const curTry = toTL(p.currentPrice * p.qty);
          const pnlSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
          const pnlTry = toTL(p.unrealizedPnlUsdt);
          const statusNote = p.partialTpDone
            ? `🚀 Yarısı satıldı, kalan yarısı Uçuş Modunda (Kâr Kilidi: $${p.stopLossPrice})`
            : p.rocketMode
              ? `🚀 Uçuş Modu Aktif (Tavan Sınırı Yok, Kâr Kilidi: $${p.stopLossPrice})`
              : `+%4,5 olunca yarısı satılıp kalanı Uçuş Moduna geçecek`;
          return `| **${p.symbol}** | \`${investedTry} TL\` | \`${curTry} TL\` | **\`${pnlSign}${pnlTry} TL (%${p.unrealizedPnlPct})\`** | ${statusNote} |`;
        })
        .join('\n') + '\n';

  const md = `# 💰 KASA VE KÂR RAPORU (Sadece TL)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}

---

## 1. GENEL KASA DURUMU

* **Başlangıç Parası:** \`1.000,00 TL\`
* **Şu Anki Toplam Para:** **\`${totalTry} TL\`**
* **Toplam Net Kâr / Zarar:** **\`${netPnlSign}${toTL(state.totalPnlUsdt)} TL\` (\`${netPnlSign}%${state.totalPnlPct}\`)**
* **Boşta Bekleyen Nakit:** \`${cashTry} TL\`
* **Coinde Olan Para:** \`${openValTry} TL\`
* **Başarılı / Zarar Kes Sayısı:** \`${state.winCount} Kârlı Satış / ${state.lossCount} Zarar Kes\`

---

## 2. SATILIP CEBE GİREN İŞLEMLER (BİTENLER)

| Coin | Yatırılan Para | Satış Sonucu Alınan | Cebe Giren Net Kâr | Durum |
| :--- | :--- | :--- | :--- | :--- |
${closedRows}
---

## 3. ŞU AN AÇIK OLAN İŞLEMLER (DEVAM EDENLER)

| Coin | Yatırılan Para | Şu Anki Değeri | Anlık Net Kâr | Otomatik Satış Planı |
| :--- | :--- | :--- | :--- | :--- |
${openRows}
---

## 4. AKTİF KORUMA KALKANLARI

1. **🛡️ BTC Çöküş Kalkanı:** Bitcoin 1 saatte \`-%1,8\`'den fazla düşerse yeni alımları anında durdurur ve açık coinlerin kâr kilidini sıkılaştırır.
2. **💰 Kademeli Kâr Al + 🚀 Sınırsız Uçuş Modu:** Coin \`+%4,5\` yükseldiğinde **yarısını otomatik satıp kârı cebe atar**, kalan yarısının Stop-Loss'unu girişin üstüne kilitleyip **tavan sınırı olmadan (\`+%20\`, \`+%50\`, \`+%100\`)** yükseliş bitene kadar takip eder.
3. **⚖️ Balina Satış Duvarı Kontrolü:** Alım yapmadan önce Binance tahtasındaki ilk 10 kademe alıcı/satıcı hacmini ölçer; önünde dev satış duvarı olan coine girmez.
4. **⏱️ 18 Saat Zaman Kilidi & 6 Saat Soğuma Kalkanı:** 18 saatte hareket etmeyen ölü coinleri boşaltır; zarar kes (Stop) olan coini 6 saat boyunca kara listeye alır.
`;

  fs.writeFileSync(RAPOR_FILE, md, 'utf8');
}

function savePortfolioState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  writeCleanTlReport(state);
}

function logEvent(state, msg) {
  const entry = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`;
  console.log(entry);
  state.recentLogs.unshift(entry);
  if (state.recentLogs.length > 40) state.recentLogs.length = 40;
}

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AltcoinAutoTrader/6.0',
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
}

async function getOrderbookQuotes(symbols) {
  if (symbols.length === 0) return {};
  const param = JSON.stringify(symbols.map(s => `${s}USDT`));
  const list = await fetchJson(`${BINANCE_API}/ticker/bookTicker?symbols=${encodeURIComponent(param)}`);
  const map = {};
  for (const item of list) {
    const sym = item.symbol.replace(/USDT$/, '');
    map[sym] = {
      bestBid: Number(item.bidPrice),
      bestAsk: Number(item.askPrice),
    };
  }
  return map;
}

/**
 * Protection #2: Orderbook Depth Imbalance Check (Top 10 Bid vs Ask Volume)
 * Returns ratio between -1.0 (pure sell wall) and +1.0 (pure buy support)
 */
async function checkOrderbookImbalance(symbol) {
  try {
    const depth = await fetchJson(`${BINANCE_API}/depth?symbol=${symbol}USDT&limit=10`, {}, 3000);
    const bidVol = (depth.bids || []).reduce((s, b) => s + Number(b[0]) * Number(b[1]), 0);
    const askVol = (depth.asks || []).reduce((s, a) => s + Number(a[0]) * Number(a[1]), 0);
    if (bidVol + askVol === 0) return 0;
    return Number(((bidVol - askVol) / (bidVol + askVol)).toFixed(2));
  } catch {
    return 0;
  }
}

async function executeBinanceRealOrder(cfg, symbol, side, quantity, quoteOrderQty = null) {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    symbol: `${symbol}USDT`,
    side,
    type: 'MARKET',
    timestamp: String(timestamp),
  });

  if (side === 'BUY' && quoteOrderQty) {
    params.set('quoteOrderQty', Number(quoteOrderQty).toFixed(2));
  } else {
    params.set('quantity', String(quantity));
  }

  const signature = crypto
    .createHmac('sha256', cfg.BINANCE_SECRET_KEY)
    .update(params.toString())
    .digest('hex');
  params.set('signature', signature);

  return await fetchJson(`${BINANCE_API}/order?${params.toString()}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': cfg.BINANCE_API_KEY },
  });
}

async function runTradingCycle() {
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  state.mode = cfg.LIVE_TRADING && cfg.BINANCE_API_KEY ? 'LIVE_BINANCE' : 'REALTIME_ORDERBOOK_PAPER';

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
    if (!q || !q.bestBid) {
      remainingPositions.push(pos);
      continue;
    }

    const currentBid = q.bestBid;
    pos.currentPrice = currentBid;
    pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentBid);
    pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
    pos.unrealizedPnlPct = Number((((currentBid - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));

    // Protection #1: If BTC is crashing (<= -1.8% in 1h), tighten stop-loss on open positions immediately
    if (signalsData.btcCrashAlert && pos.unrealizedPnlPct > 0.5) {
      const emergencyStop = Number((currentBid * 0.992).toPrecision(5));
      if (emergencyStop > pos.stopLossPrice) {
        pos.stopLossPrice = emergencyStop;
        logEvent(state, `🛡️ [BTC Çöküş Kalkanı] ${pos.symbol} kârı korumaya alındı -> SL: $${pos.stopLossPrice}`);
      }
    }

    // Protection #3: Partial Take-Profit (At +4.5% gain, sell 50% into cash and turn remaining 50% into Free-Roll Moonbag!)
    if (!pos.partialTpDone && pos.unrealizedPnlPct >= 4.5) {
      const sellQty = Number((pos.qty * 0.5).toPrecision(4));
      const remainQty = Number((pos.qty - sellQty).toPrecision(4));
      const halfCostUsdt = Number((pos.costUsdt * 0.5).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - halfCostUsdt).toFixed(4));

      if (state.mode === 'LIVE_BINANCE') {
        await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
      }

      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      state.winCount++;

      state.closedTrades.unshift({
        symbol: pos.symbol,
        entryPrice: pos.entryPrice,
        exitPrice: currentBid,
        exitTime: new Date().toISOString(),
        costUsdt: halfCostUsdt,
        netPnlUsdt,
        netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
        exitReason: `💰 %50 KADEMELİ KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %50 Uçuş Modunda)`,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number((pos.costUsdt - halfCostUsdt).toFixed(4));
      pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
      pos.partialTpDone = true;
      pos.rocketMode = true;
      pos.trailingActive = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * 1.012).toPrecision(5)),
        Number((pos.highestPrice * 0.982).toPrecision(5))
      );
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));

      logEvent(
        state,
        `💰 [%50 KÂR CEBE ALINDI] ${pos.symbol} yarısı +%${pos.unrealizedPnlPct} kârla satıldı (+${toTL(netPnlUsdt)} TL)! Kalan yarısı tavan sınırsız 🚀 Uçuş Modunda!`
      );
    }

    // Dynamic ATR / Rocket Trailing Stop Update
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const trailDist = pos.atr1hPct ? Math.max(0.015, Math.min(0.028, (pos.atr1hPct * 0.85) / 100)) : 0.018;

    if (peakGainPct >= 4.5) {
      const rocketTrailStop = Number((pos.highestPrice * (1 - trailDist)).toPrecision(5));
      if (rocketTrailStop > pos.stopLossPrice) {
        pos.stopLossPrice = rocketTrailStop;
        pos.trailingActive = true;
        pos.rocketMode = true;
      }
    } else if (peakGainPct >= 2.2) {
      const breakEvenPlus = Number((pos.entryPrice * 1.008).toPrecision(5));
      const trailStop = Number((pos.highestPrice * 0.978).toPrecision(5));
      const newStop = Math.max(pos.stopLossPrice, breakEvenPlus, trailStop);
      if (newStop > pos.stopLossPrice) {
        pos.stopLossPrice = newStop;
        pos.trailingActive = true;
      }
    }

    // Protection #5: Stagnation Time-Stop (18 hours without reaching +1.0%)
    const hoursHeld = (nowMs - new Date(pos.entryTime).getTime()) / (1000 * 3600);
    let exitReason = null;

    if (currentBid <= pos.stopLossPrice) {
      exitReason = pos.rocketMode
        ? `🚀 UÇUŞ MODU KÂR KİLİDİ (%${pos.unrealizedPnlPct})`
        : pos.trailingActive
          ? `🔒 İZ SÜREN KÂR KİLİDİ (%${pos.unrealizedPnlPct})`
          : `🛑 ZARAR KES (SL %${pos.unrealizedPnlPct})`;
    } else if (hoursHeld >= 18 && pos.unrealizedPnlPct < 1.0) {
      exitReason = `⏱️ 18 SAAT ZAMAN KİLİDİ (Hareketsiz Coin Boşaltıldı %${pos.unrealizedPnlPct})`;
    }

    if (exitReason) {
      if (state.mode === 'LIVE_BINANCE') {
        await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
      }
      const proceedsUsdt = Number((currentBid * pos.qty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - pos.costUsdt).toFixed(4));
      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));

      if (netPnlUsdt >= 0) {
        state.winCount++;
      } else {
        state.lossCount++;
        // Protection #6: 6-Hour Cooldown Blacklist after a loss
        state.cooldowns[pos.symbol] = nowMs + 6 * 3600 * 1000;
      }

      const closedRecord = {
        ...pos,
        exitPrice: currentBid,
        exitTime: new Date().toISOString(),
        exitReason,
        netPnlUsdt,
        netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
      };
      state.closedTrades.unshift(closedRecord);
      logEvent(
        state,
        `🏁 [POZİSYON KAPANDI] ${pos.symbol} @ $${currentBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`
      );
    } else {
      remainingPositions.push(pos);
    }
  }
  state.openPositions = remainingPositions;

  // Step 3: Open new positions if BTC is not crashing and slots/cash available
  if (signalsData.btcCrashAlert) {
    logEvent(state, `🛡️ [BTC ÇÖKÜŞ KALKANI AKTİF] BTC son 1 saatte %${signalsData.btc1hChangePct} düştüğü için yeni altcoin alımı durduruldu.`);
  } else {
    const usedLeaders = new Set(state.openPositions.map(p => p.leaderSymbol));
    const heldSymbols = new Set(state.openPositions.map(p => p.symbol));

    for (const cand of candidates) {
      if (state.openPositions.length >= cfg.MAX_OPEN_POSITIONS) break;
      if (state.cashUsdt < 4.50) break; // Minimum meaningful trade size (~160 TL)
      if (heldSymbols.has(cand.symbol)) continue;
      if (usedLeaders.has(cand.leaderSymbol)) continue;
      if (cand.totalScore < 52) continue;

      // Protection #6: Check 6-Hour Cooldown Blacklist
      if (state.cooldowns[cand.symbol] && state.cooldowns[cand.symbol] > nowMs) {
        continue;
      }

      const q = quotes[cand.symbol];
      if (!q || !q.bestAsk) continue;

      // Protection #2: Orderbook Depth Imbalance Check (Reject if heavy sell wall < -0.35)
      const obImbalance = await checkOrderbookImbalance(cand.symbol);
      if (obImbalance < -0.35) {
        logEvent(state, `⚖️ [Tahta Kalkanı] ${cand.symbol} önünde yoğun satış duvarı var (Imbalance: ${obImbalance}), alım iptal.`);
        continue;
      }

      const buyPrice = q.bestAsk;
      const costUsdt = Number(Math.min(cfg.ORDER_SIZE_USDT, state.cashUsdt).toFixed(2));
      const qty = Number((costUsdt / buyPrice).toPrecision(4));

      if (state.mode === 'LIVE_BINANCE') {
        await executeBinanceRealOrder(cfg, cand.symbol, 'BUY', qty, costUsdt);
      }

      const tpPrice = Number((buyPrice * (1 + cand.tpPct / 100)).toPrecision(5));
      const slPrice = Number((buyPrice * (1 - cand.slPct / 100)).toPrecision(5));

      const newPos = {
        id: `pos_${Date.now()}_${cand.symbol}`,
        symbol: cand.symbol,
        leaderSymbol: cand.leaderSymbol,
        ecosystem: cand.ecosystems?.[0] || 'Genel',
        headline: cand.headlines?.[0]?.title || 'Pozitif Ekosistem Katalizörü',
        newsSource: cand.headlines?.[0]?.source || 'RSS',
        newsScore: cand.newsScore,
        totalScore: cand.totalScore,
        rsiAtEntry: cand.rsi1h,
        atr1hPct: cand.atr1hPct || 2.2,
        obImbalance,
        entryTime: new Date().toISOString(),
        entryPrice: buyPrice,
        currentPrice: q.bestBid || buyPrice,
        highestPrice: buyPrice,
        qty,
        costUsdt,
        costTry: Math.round(costUsdt * USD_TRY_RATE),
        takeProfitPrice: tpPrice,
        stopLossPrice: slPrice,
        tpPct: cand.tpPct,
        slPct: cand.slPct,
        partialTpDone: false,
        trailingActive: false,
        rocketMode: false,
        unrealizedPnlUsdt: Number((((q.bestBid || buyPrice) - buyPrice) * qty).toFixed(4)),
        unrealizedPnlPct: Number(((((q.bestBid || buyPrice) - buyPrice) / buyPrice) * 100).toFixed(2)),
      };

      state.cashUsdt = Number((state.cashUsdt - costUsdt).toFixed(4));
      state.openPositions.push(newPos);
      heldSymbols.add(cand.symbol);
      usedLeaders.add(cand.leaderSymbol);

      logEvent(
        state,
        `🟢 [OTOMATİK ALIM] ${cand.symbol} (${toTL(costUsdt)} TL) @ $${buyPrice} | Skor: ${cand.totalScore} | Tahta Dengesi: ${obImbalance} | SL: $${slPrice} (-%${cand.slPct})`
      );
    }
  }

  const openMarketValueUsdt = state.openPositions.reduce(
    (sum, p) => sum + p.currentPrice * p.qty,
    0
  );
  state.totalEquityUsdt = Number((state.cashUsdt + openMarketValueUsdt).toFixed(4));
  state.totalEquityTry = Number((state.totalEquityUsdt * USD_TRY_RATE).toFixed(2));
  state.totalPnlUsdt = Number((state.totalEquityUsdt - state.initialBankrollUsdt).toFixed(4));
  state.totalPnlPct = Number(((state.totalPnlUsdt / state.initialBankrollUsdt) * 100).toFixed(2));

  savePortfolioState(state);
  return { state, signalsData };
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AltcoinAutoTrader v6.0 — TL Bazlı Canlı Kontrol Paneli</title>
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
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
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
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
    }
    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      padding: 16px 20px;
      border-radius: 12px;
    }
    .kpi-label { font-size: 13px; color: var(--muted); }
    .kpi-val { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .section h2 { font-size: 17px; margin-bottom: 14px; color: #f8fafc; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .pos { color: var(--green); font-weight: 600; }
    .neg { color: var(--red); font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 style="font-size: 20px;">💰 AltcoinAutoTrader v6.0 — Tam Korumalı TL Kasa Paneli</h1>
      <p style="font-size: 13px; color: var(--muted); margin-top: 4px;">
        BTC Çöküş Kalkanı + %50 Kademeli Kâr Al + 🚀 Tavansız Uçuş Modu + Balina Duvar Kontrolü
      </p>
    </div>
    <button class="btn" onclick="triggerCycle()">⚡ Şimdi Tara & Güncelle</button>
  </div>

  <div class="grid-kpi">
    <div class="kpi">
      <div class="kpi-label">Toplam Kasa (TL)</div>
      <div class="kpi-val" id="equityVal">1.000,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Toplam Net Kâr (TL)</div>
      <div class="kpi-val" id="pnlVal">+0,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Boştaki Nakit (TL)</div>
      <div class="kpi-val" id="cashVal">0,00 TL</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Biten İşlemler</div>
      <div class="kpi-val" id="winVal">0 Kârlı / 0 Stop</div>
    </div>
  </div>

  <div class="section">
    <h2>🟢 Şu An Açık Olan İşlemler</h2>
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Yatırılan (TL)</th>
          <th>Şu Anki Değer (TL)</th>
          <th>Anlık Net Kâr (TL)</th>
          <th>Durum / Otomatik Satış Planı</th>
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

  <script>
    const RATE = 35.7;
    const fmtTL = u => (Number(u || 0) * RATE).toFixed(2) + ' TL';

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      const s = data.state;

      document.getElementById('equityVal').textContent = fmtTL(s.totalEquityUsdt);
      document.getElementById('cashVal').textContent = fmtTL(s.cashUsdt);

      const pnlEl = document.getElementById('pnlVal');
      const sign = s.totalPnlUsdt >= 0 ? '+' : '';
      pnlEl.textContent = sign + fmtTL(s.totalPnlUsdt) + ' (' + sign + '%' + s.totalPnlPct + ')';
      pnlEl.className = 'kpi-val ' + (s.totalPnlUsdt >= 0 ? 'pos' : 'neg');

      document.getElementById('winVal').textContent = s.winCount + ' Kârlı / ' + s.lossCount + ' Stop';

      const openBody = document.getElementById('openBody');
      openBody.innerHTML = s.openPositions.map(p => {
        const pClass = p.unrealizedPnlUsdt >= 0 ? 'pos' : 'neg';
        const pSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
        const modeTxt = p.partialTpDone
          ? '🚀 %50 Kâr Alındı, Kalan %50 Tavansız Uçuş Modunda'
          : '+%4,5 olunca yarısı satılıp kalanı Uçuş Moduna geçecek';
        return '<tr>' +
          '<td><strong>' + p.symbol + '</strong><br><small style="color:#94a3b8;">' + p.headline + '</small></td>' +
          '<td>' + fmtTL(p.costUsdt) + '</td>' +
          '<td><strong>' + fmtTL(p.currentPrice * p.qty) + '</strong></td>' +
          '<td class="' + pClass + '">' + pSign + fmtTL(p.unrealizedPnlUsdt) + ' (' + pSign + '%' + p.unrealizedPnlPct + ')</td>' +
          '<td>' + modeTxt + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5">Açık işlem yok.</td></tr>';

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

    async function triggerCycle() {
      await fetch('/api/cycle', { method: 'POST' });
      await loadState();
    }
    loadState();
    setInterval(loadState, 10000);
  </script>
</body>
</html>`;
}

async function main() {
  const isDaemon = process.argv.includes('--daemon');
  const result = await runTradingCycle();
  const s = result.state;

  console.log('\n================================================================================');
  console.log(`💰 [TL KASA ÖZETİ] Başlangıç: 1.000,00 TL -> Şu Anki Toplam: ${toTL(s.totalEquityUsdt)} TL`);
  console.log(`   Net Kâr/Zarar: ${s.totalPnlUsdt >= 0 ? '+' : ''}${toTL(s.totalPnlUsdt)} TL (%${s.totalPnlPct}) | Boştaki Nakit: ${toTL(s.cashUsdt)} TL`);
  console.log('================================================================================');

  for (const pos of s.openPositions) {
    console.log(
      `   🟢 AÇIK: ${pos.symbol} | Yatırılan: ${toTL(pos.costUsdt)} TL -> Şu An: ${toTL(pos.currentPrice * pos.qty)} TL | Net Kâr: ${pos.unrealizedPnlUsdt >= 0 ? '+' : ''}${toTL(pos.unrealizedPnlUsdt)} TL (%${pos.unrealizedPnlPct})`
    );
  }

  if (isDaemon) {
    const cfg = loadEnv();
    const port = 3847;
    const server = http.createServer(async (req, res) => {
      if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ state: loadPortfolioState(cfg) }));
      } else if (req.url === '/api/cycle' && req.method === 'POST') {
        const updated = await runTradingCycle();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ state: updated.state }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml());
      }
    });

    server.listen(port, () => {
      console.log(`\n🌐 TL Bazlı Canlı Web Kontrol Paneli: http://localhost:${port}`);
    });

    setInterval(() => {
      runTradingCycle().catch(err => console.error('Cycle error:', err.message));
    }, cfg.SCAN_INTERVAL_SECONDS * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
