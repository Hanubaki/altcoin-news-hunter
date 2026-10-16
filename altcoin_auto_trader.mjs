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
  const tasks = [];
  // 1. WhatsApp via CallMeBot Free API
  if (cfg.WHATSAPP_PHONE && cfg.CALLMEBOT_API_KEY) {
    let phone = cfg.WHATSAPP_PHONE.replace(/\s+/g, '');
    if (phone.startsWith('05')) phone = '+9' + phone;
    else if (phone.startsWith('5')) phone = '+90' + phone;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(cfg.CALLMEBOT_API_KEY)}`;
    tasks.push(fetch(url, { signal: AbortSignal.timeout(5000) }).then(r => r.text()).catch(() => ''));
  }
  // 2. Telegram Bot API
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text: msg }),
        signal: AbortSignal.timeout(4000),
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
        signal: AbortSignal.timeout(4000),
      }).catch(() => {})
    );
  }
  return Promise.allSettled(tasks);
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
    ? '| *Şu an açık işlem yok* | - | - | - | - |\n'
    : state.openPositions
        .map(p => {
          const investedTry = toTL(p.costUsdt);
          const curTry = toTL(p.currentPrice * p.qty);
          const pnlSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
          const pnlTry = toTL(p.unrealizedPnlUsdt);
          const stageTxt = p.stage2TpDone
            ? `🚀 2 Kademe Kâr Alındı, Kalan %30 Sınırsız Roket Modunda`
            : p.partialTpDone
              ? `🚀 1. Kademe Satıldı, +%9'da 2. Kademe + Sınırsız Uçuş Modu`
              : `+%4,0'da 1. Kademe, +%9,0'da 2. Kademe, Kalanı Sınırsız Uçuş`;
          return `| **${p.symbol}** | \`${investedTry} TL\` | \`${curTry} TL\` | **\`${pnlSign}${pnlTry} TL (%${p.unrealizedPnlPct})\`** | ${stageTxt} |`;
        })
        .join('\n') + '\n';

  const md = `# 💰 KASA VE KÂR RAPORU (Sadece TL — Ultra-Yield v7.0)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}

---

## 1. GENEL KASA DURUMU

* **Başlangıç Parası:** \`1.000,00 TL\`
* **Şu Anki Toplam Para:** **\`${totalTry} TL\`**
* **Toplam Net Kâr / Zarar:** **\`${netPnlSign}${toTL(state.totalPnlUsdt)} TL\` (\`${netPnlSign}%${state.totalPnlPct}\`)**
* **Boşta Bekleyen Nakit:** \`${cashTry} TL\`
* **Coinde Olan Para:** \`${openValTry} TL\`
* **Başarılı Satış / Zarar Kes:** \`${state.winCount} Kârlı Satış / ${state.lossCount} Zarar Kes\`

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

## 4. AKTİF 12 MAKSİMUM VERİM & KORUMA MOTORU (v7.0)

1. **📢 Binance Resmi Duyuru & Listeleme Avcısı:** Binance'in kendi duyuru sistemini (\`Binance CMS\`) anlık tarar; yeni listeleme/teminat haberlerine \`1.8x\` öncelik verir.
2. **🔥 CoinGecko Küresel Trend Radarı:** Dünyada en çok aranan trend coinleri yakalayıp \`+10 Puan\` ivme bonusu ekler.
3. **🐋 Balina Market Alım Akışı (Whale Taker Flow):** Son mumlardaki gerçek alıcı baskısını ölçer (\`%53+\` balina alımı varsa girer, \`<%38\` balina satışı varsa reddeder).
4. **📈 Dipten Dönüş Mum Onayı:** Düşen bıçağı tutmaz; mumun yeşile dönmesini veya dipten tepki vermesini bekler.
5. **🔻 3 Kademeli Kâr Hasadı + 🚀 Sınırsız Roket Modu:** \`+%4,0\`'da paranın %40'ını, \`+%9,0\`'da %30'unu satıp kârı cebe atar; kalan %30'u **tavan sınırı olmadan (\`+%30\`, \`+%80\`, \`+%150\`)** uçuşta tutar.
6. **🧱 Canlı Satış Duvarı Erken Kaçış:** Açık coinin önüne aniden dev bir balina satış duvarı konursa fiyat düşmeden önce kârı kilitleyip çıkar.
7. **🔄 Otomatik Bileşik Kasa & Sinyal Gücüne Göre Pay:** Kazandığı her lirayı ana kasaya ekler; 80+ puanlık dev haberlere kasanın \`%38\`'ini, normal haberlere \`%28\`'ini yatırır.
8. **⚡ Akıllı Fırsat Değişimi (Swap):** Kasa doluyken 80+ puanlık dev bir haber düşerse, 2 saattir yerinde sayan zayıf coini otomatik satıp yeni fırsata geçer.
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
  sendInstantPhoneAlert(entry);
}

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
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

    // Protection #1: BTC Crash Tightener
    if (signalsData.btcCrashAlert && pos.unrealizedPnlPct > 0.5) {
      const emergencyStop = Number((currentBid * 0.992).toPrecision(5));
      if (emergencyStop > pos.stopLossPrice) {
        pos.stopLossPrice = emergencyStop;
        logEvent(state, `🛡️ [BTC Çöküş Kalkanı] ${pos.symbol} kârı korumaya alındı -> SL: $${pos.stopLossPrice}`);
      }
    }

    // Engine #6: Live Whale Sell-Wall Front-Run Check on Winning Positions
    if (pos.unrealizedPnlPct >= 2.2) {
      const liveOb = await checkOrderbookImbalance(pos.symbol);
      if (liveOb <= -0.58) {
        const wallProtectStop = Number((currentBid * 0.995).toPrecision(5));
        if (wallProtectStop > pos.stopLossPrice) {
          pos.stopLossPrice = wallProtectStop;
          logEvent(state, `🧱 [Satış Duvarı Kalkanı] ${pos.symbol} önünde balina satış duvarı (${liveOb}) tespit edildi, kâr kilidi sıkılaştırıldı!`);
        }
      }
    }

    // Engine #7A: Stage 1 Profit Harvest (+4.0% -> Sell 40%, lock SL at +1.0%)
    if (!pos.partialTpDone && pos.unrealizedPnlPct >= 4.0) {
      const sellQty = Number((pos.qty * 0.4).toPrecision(4));
      const remainQty = Number((pos.qty - sellQty).toPrecision(4));
      const soldCostUsdt = Number((pos.costUsdt * 0.4).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));

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
        costUsdt: soldCostUsdt,
        netPnlUsdt,
        netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
        exitReason: `💰 1. KADEME (%40) KÂR AL (+%${pos.unrealizedPnlPct})`,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number((pos.costUsdt - soldCostUsdt).toFixed(4));
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
        `💰 [1. KADEME KÂR CEBE ALINDI] ${pos.symbol} %40'ı satıldı (+${toTL(netPnlUsdt)} TL)! Kalan %60 Uçuş Modunda!`
      );
    }

    // Engine #7B: Stage 2 Profit Harvest (+9.0% -> Sell half of remaining = 30% original, leave 30% Uncapped Moonbag!)
    if (pos.partialTpDone && !pos.stage2TpDone && pos.unrealizedPnlPct >= 9.0) {
      const sellQty = Number((pos.qty * 0.5).toPrecision(4));
      const remainQty = Number((pos.qty - sellQty).toPrecision(4));
      const soldCostUsdt = Number((pos.costUsdt * 0.5).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));

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
        costUsdt: soldCostUsdt,
        netPnlUsdt,
        netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
        exitReason: `🚀 2. KADEME (%30) DEV KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %30 Sınırsız Roket)`,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number((pos.costUsdt - soldCostUsdt).toFixed(4));
      pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
      pos.stage2TpDone = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * 1.055).toPrecision(5)),
        Number((pos.highestPrice * 0.984).toPrecision(5))
      );
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));

      logEvent(
        state,
        `🚀 [2. KADEME DEV KÂR ALINDI] ${pos.symbol} +%${pos.unrealizedPnlPct} kârla satıldı (+${toTL(netPnlUsdt)} TL)! Son %30 sınırsız uçuşta!`
      );
    }

    // Dynamic ATR Trailing Stop Ratchet
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const trailDist = pos.atr1hPct ? Math.max(0.015, Math.min(0.028, (pos.atr1hPct * 0.85) / 100)) : 0.018;

    if (peakGainPct >= 4.0) {
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

    const hoursHeld = (nowMs - new Date(pos.entryTime).getTime()) / (1000 * 3600);
    const latestSig = candidates.find(c => c.symbol === pos.symbol);
    let exitReason = null;

    if (currentBid <= pos.stopLossPrice) {
      exitReason = pos.rocketMode
        ? `🚀 UÇUŞ MODU KÂR KİLİDİ (%${pos.unrealizedPnlPct})`
        : pos.trailingActive
          ? `🔒 İZ SÜREN KÂR KİLİDİ (%${pos.unrealizedPnlPct})`
          : `🛑 ZARAR KES (SL %${pos.unrealizedPnlPct})`;
    } else if (latestSig && latestSig.liveLlmDecision === 'WAIT' && latestSig.liveLlmConfidence >= 75 && !pos.rocketMode) {
      exitReason = `🧠 AI KONSEYİ TUZAK HABER TAHLİYESİ (GPT-120B & Qwen-3.8: Riskli Haber — %${pos.unrealizedPnlPct})`;
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
        state.cooldowns[pos.symbol] = nowMs + 6 * 3600 * 1000;
      }

      state.closedTrades.unshift({
        ...pos,
        exitPrice: currentBid,
        exitTime: new Date().toISOString(),
        exitReason,
        netPnlUsdt,
        netPnlTry: Number((netPnlUsdt * USD_TRY_RATE).toFixed(2)),
      });
      logEvent(state, `🏁 [POZİSYON KAPANDI] ${pos.symbol} @ $${currentBid} | ${exitReason} | Net: ${toTL(netPnlUsdt)} TL`);
    } else {
      remainingPositions.push(pos);
    }
  }
  state.openPositions = remainingPositions;

  // Engine #9: Smart Portfolio Rotation (Swap out a >2h stagnant coin if an 80+ score A+ breaking news catalyst arrives)
  const bestCandidate = candidates[0];
  if (
    !signalsData.btcCrashAlert &&
    bestCandidate &&
    bestCandidate.totalScore >= 80 &&
    state.openPositions.length >= cfg.MAX_OPEN_POSITIONS &&
    !state.openPositions.some(p => p.symbol === bestCandidate.symbol)
  ) {
    const stagnantIdx = state.openPositions.findIndex(p => {
      const hrs = (nowMs - new Date(p.entryTime).getTime()) / (1000 * 3600);
      return hrs >= 2.0 && Math.abs(p.unrealizedPnlPct) <= 0.6 && !p.partialTpDone;
    });

    if (stagnantIdx !== -1) {
      const stag = state.openPositions[stagnantIdx];
      const sq = quotes[stag.symbol];
      if (sq && sq.bestBid) {
        const proceedsUsdt = Number((sq.bestBid * stag.qty).toFixed(4));
        const netPnlUsdt = Number((proceedsUsdt - stag.costUsdt).toFixed(4));
        state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
        state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
        state.openPositions.splice(stagnantIdx, 1);
        logEvent(
          state,
          `⚡ [AKILLI ROTASYON] Hareketsiz ${stag.symbol} kapatıldı, yerine ${bestCandidate.totalScore} puanlık dev fırsat (${bestCandidate.symbol}) alınıyor!`
        );
      }
    }
  }

  // Compute current total equity for Auto-Compounding Dynamic Position Sizing
  const currentOpenVal = state.openPositions.reduce((s, p) => s + p.currentPrice * p.qty, 0);
  const currentTotalEquity = state.cashUsdt + currentOpenVal;

  // Step 3: Open new positions with Conviction-Based Auto-Compounding Sizing
  if (!signalsData.btcCrashAlert) {
    const usedLeaders = new Set(state.openPositions.map(p => p.leaderSymbol));
    const heldSymbols = new Set(state.openPositions.map(p => p.symbol));

    for (const cand of candidates) {
      if (state.openPositions.length >= cfg.MAX_OPEN_POSITIONS) break;
      if (state.cashUsdt < 4.50) break;
      if (heldSymbols.has(cand.symbol)) continue;
      if (usedLeaders.has(cand.leaderSymbol)) continue;
      if (cand.totalScore < 50) continue;
      if (state.cooldowns[cand.symbol] && state.cooldowns[cand.symbol] > nowMs) continue;

      const q = quotes[cand.symbol];
      if (!q || !q.bestAsk) continue;

      const obImbalance = await checkOrderbookImbalance(cand.symbol);
      if (obImbalance < -0.35) {
        logEvent(state, `⚖️ [Tahta Kalkanı] ${cand.symbol} önünde satış duvarı (${obImbalance}) var, pas geçildi.`);
        continue;
      }

      // Engine #8: Conviction-Based Auto-Compounding Sizing
      // 80+ score A+ catalyst -> 38% of total equity; 65-79 score -> 33%; 52-64 score -> 28%
      const convictionPct = cand.totalScore >= 80 ? 0.38 : cand.totalScore >= 65 ? 0.33 : 0.28;
      const targetAllocUsdt = Number((currentTotalEquity * convictionPct).toFixed(2));
      const costUsdt = Number(Math.min(targetAllocUsdt, state.cashUsdt).toFixed(2));
      if (costUsdt < 4.50) continue;

      const buyPrice = q.bestAsk;
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
        takerBuyRatioPct: cand.takerBuyRatioPct || 50,
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

      logEvent(
        state,
        `🟢 [OTOMATİK ALIM] ${cand.symbol} (${toTL(costUsdt)} TL) @ $${buyPrice} | Skor: ${cand.totalScore} | Balina Alım: %${newPos.takerBuyRatioPct}`
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
  <title>AltcoinAutoTrader v7.0 (Ultra-Yield) — TL Kasa Paneli</title>
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
      <h1 style="font-size: 20px;">🚀 AltcoinAutoTrader v7.0 (Ultra-Yield) — TL Kasa Paneli</h1>
      <p style="font-size: 13px; color: var(--muted); margin-top: 4px;">
        Binance Resmi Duyuru + Balina Akışı + 3 Kademeli Kâr Hasadı + 🚀 Sınırsız Uçuş Modu
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
        const modeTxt = p.stage2TpDone
          ? '🚀 2 Kademe Alındı, Kalan %30 Sınırsız Roket'
          : p.partialTpDone
            ? '🚀 1. Kademe Alındı, +%9 2. Kademe + Sınırsız Uçuş'
            : '+%4 1. Kademe, +%9 2. Kademe, Kalanı Sınırsız Uçuş';
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
  const shouldNotify = process.argv.includes('--notify');
  const result = await runTradingCycle();
  const s = result.state;

  console.log('\n================================================================================');
  console.log(`💰 [TL KASA ÖZETİ v7.0] Başlangıç: 1.000,00 TL -> Şu Anki Toplam: ${toTL(s.totalEquityUsdt)} TL`);
  console.log(`   Net Kâr/Zarar: ${s.totalPnlUsdt >= 0 ? '+' : ''}${toTL(s.totalPnlUsdt)} TL (%${s.totalPnlPct}) | Boştaki Nakit: ${toTL(s.cashUsdt)} TL`);
  console.log('================================================================================');

  for (const pos of s.openPositions) {
    console.log(
      `   🟢 AÇIK: ${pos.symbol} | Yatırılan: ${toTL(pos.costUsdt)} TL -> Şu An: ${toTL(pos.currentPrice * pos.qty)} TL | Net Kâr: ${pos.unrealizedPnlUsdt >= 0 ? '+' : ''}${toTL(pos.unrealizedPnlUsdt)} TL (%${pos.unrealizedPnlPct})`
    );
  }

  if (shouldNotify) {
    const openLines = s.openPositions
      .map(p => `• ${p.symbol}: ${toTL(p.currentPrice * p.qty)} TL (${p.unrealizedPnlUsdt >= 0 ? '+' : ''}${toTL(p.unrealizedPnlUsdt)} TL / %${p.unrealizedPnlPct})`)
      .join('\n');
    const waMsg =
      `💰 *ALTCOIN KASA RAPORU (v8.0 AI)*\n` +
      `Toplam Kasa: *${toTL(s.totalEquityUsdt)} TL*\n` +
      `Net Kar: *${s.totalPnlUsdt >= 0 ? '+' : ''}${toTL(s.totalPnlUsdt)} TL (%${s.totalPnlPct})*\n` +
      `Nakit: ${toTL(s.cashUsdt)} TL | Basari: ${s.winCount}/${s.winCount + s.lossCount}\n` +
      `--------------------\n` +
      `*Acik Islemler:*\n${openLines || 'Yok'}`;
    await sendInstantPhoneAlert(waMsg);
    console.log('📱 WhatsApp Kasa Raporu telefonuna gönderildi!');
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
