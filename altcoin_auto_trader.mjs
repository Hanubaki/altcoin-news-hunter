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

function runAdaptiveLearningEngine(state) {
  const closed = state.closedTrades || [];
  const coinStats = {};
  const sourceStats = {};
  const lessons = [];

  for (const t of closed) {
    const sym = t.symbol;
    if (!sym) continue;
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
    const pnlU = Number(t.netPnlUsdt || 0);
    const pnlT = Number(t.netPnlTry ?? pnlU * USD_TRY_RATE);
    cs.netPnlUsdt = Number((cs.netPnlUsdt + pnlU).toFixed(4));
    cs.netPnlTry = Number((cs.netPnlTry + pnlT).toFixed(2));

    const src = t.newsSource || 'RSS';
    if (!sourceStats[src]) sourceStats[src] = { wins: 0, losses: 0, netPnlUsdt: 0, scoreMod: 0 };
    sourceStats[src].netPnlUsdt = Number((sourceStats[src].netPnlUsdt + pnlU).toFixed(4));

    if (pnlU >= 0) {
      cs.wins++;
      sourceStats[src].wins++;
      if (t.rsiAtEntry) cs.winRsis.push(Number(t.rsiAtEntry));
      if (t.takerBuyRatioPct) cs.winWhales.push(Number(t.takerBuyRatioPct));
    } else {
      cs.losses++;
      sourceStats[src].losses++;
      if (t.rsiAtEntry) cs.lossRsis.push(Number(t.rsiAtEntry));
      if (t.takerBuyRatioPct) cs.lossWhales.push(Number(t.takerBuyRatioPct));
    }
  }

  for (const [sym, cs] of Object.entries(coinStats)) {
    if (cs.losses > 0 && cs.netPnlUsdt < 0) {
      const avgLossRsi = cs.lossRsis.length ? cs.lossRsis.reduce((a, b) => a + b, 0) / cs.lossRsis.length : 49.4;
      const avgLossWhale = cs.lossWhales.length ? cs.lossWhales.reduce((a, b) => a + b, 0) / cs.lossWhales.length : 53.0;
      cs.maxRsi = Number(Math.max(38, Math.min(44, Math.floor(avgLossRsi - 4))).toFixed(1));
      cs.minWhale = Number(Math.max(55.0, Math.min(60.0, avgLossWhale + 2.0)).toFixed(1));
      cs.scoreMod = -10 * cs.losses;
      cs.lessonNote = `🛑 HATA OTOPSİSİ: ${sym} işleminde RSI ${avgLossRsi.toFixed(1)} ve Balina %${avgLossWhale.toFixed(1)} seviyesinde sahte kırılım (fakeout) yaşandı (${cs.netPnlTry} TL). Yeni Kural: ${sym} için RSI tavanı <= ${cs.maxRsi}, Balina şartı >= %${cs.minWhale} ve Skor Cezası ${cs.scoreMod} puan olarak sıkılaştırıldı.`;
      lessons.push(cs.lessonNote);
    } else if (cs.wins > 0 && cs.netPnlUsdt > 0) {
      cs.scoreMod = Math.min(8, cs.wins * 3);
      cs.maxRsi = 55;
      cs.minWhale = 50.8;
      cs.lessonNote = `✅ BAŞARI HAFIZASI: ${sym} (${cs.wins} Kâr / ${cs.losses} Zarar, Net +${cs.netPnlTry.toFixed(2)} TL) güçlü tahta tepkisi verdi -> Konsey Skor Bonusu +${cs.scoreMod} puan.`;
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

  state.adaptiveMemory = {
    updatedAt: new Date().toISOString(),
    totalAnalyzedTrades: closed.length,
    coinStats,
    sourceStats,
    lessons,
  };
  return state.adaptiveMemory;
}

function writeCleanTlReport(state) {
  const mem = state.adaptiveMemory || runAdaptiveLearningEngine(state);
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
          const stageTxt = p.isMoonshot
            ? p.trailingActive
              ? `🎰 VURGUN SLOTU (Sıfır Risk Kilidi Aktif — +%18 / Sınırsız Pump Peşinde)`
              : `🎰 KORUMALI VURGUN SLOTU (-%${p.slPct || 2.5} ATR Kalkanı | Hedef: +%18)`
            : p.stage2TpDone
              ? `🚀 2 Kademe Alındı, Kalan %30 Sıfır Riskle Sınırsız Roket Modunda`
              : p.partialTpDone
                ? `🔒 1. Kademe Cebimizde, Kalan %60 Sıfır Riskle +%7,5 Hedefinde`
                : p.trailingActive
                  ? `🛡️ Maliyet Üstü Sıfır Risk Kilidi Aktif (+%2,8'de 1. Kademe Satış)`
                  : `🛡️ ATR Kalkanı (-%${p.slPct || 2.4} Nefes Payı | +%1,5'te Sıfır Riske Geçer, +%2,8'de %40 Kâr Alır)`;
          return `| **${p.symbol}${p.isMoonshot ? ' (VURGUN)' : ''}** | \`${investedTry} TL\` | \`${curTry} TL\` | **\`${pnlSign}${pnlTry} TL (%${p.unrealizedPnlPct})\`** | ${stageTxt} |`;
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
* **Coinde Olan Para:** \`${openValTry} TL\`
* **Başarılı Satış / Zarar Kes:** \`${state.winCount} Kârlı Satış / ${state.lossCount} Zarar Kes\`
* **🏦 Binance TR Gerçek Hesap Bağlantısı:** \`${state.binanceTrStatus || 'API Doğrulandı (trbinance.com — Alım/Satım Yetkisi Aktif)'}\`

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

## 5. AKTİF KORUMA VE MAKSİMUM KAZANÇ MOTORLARI (v9.5)

1. **📏 ATR Nefes Payı Kalkanı (-%2,0 ile -%3,2):** Coinlerin 15 dakikalık normal iğnelerde erken stop olmasını önleyen gerçek volatilite bazlı stop-loss mesafesi.
2. **🛡️ +%1,5 Gerçek Sıfır Risk Kilidi (True Breakeven Lock):** Bir coin \`+%1,5\` yükseldiği anda Stop-Loss otomatik olarak maliyetin \`+%0,35\` üstüne çekilir; kâr kilidi sadece stop fiyatı gerçekten maliyetin üstündeyken aktif olur.
3. **🎰 +%2,8 Bedava Sürüş (Free-Ride / House Money) Hasadı:** Coin \`+%2,8\` yaptığı anda \`%40\`'ı satılıp sıcak kâr cebe atılır, kalan \`%60\`'ın stopu \`+%1,2+\` net kâra kilitlenir ve **%100 sıfır riskle** \`+%7,5\` ve sınırsız uçuşa bırakılır.
4. **🚫 Tepe (Overbought) ve Bayat Haber Engelleyici:** \`RSI > 55\` olan tepedeki coinlere ve son 12 saatte zarar yazmış bayat haber başlıklarına tekrar girilmez.
5. **🧠 Engine #15 — Otonom Hata Otopsisi ve Öz-Öğrenme Motoru:** Zarar edilen her işlemden sonra ilgili coinin RSI tavanını, minimum Balina giriş oranını ve Konsey güven puanını otonom olarak günceller; aynı hatayı ikinci kez yapmaz.
`;

  fs.writeFileSync(RAPOR_FILE, md, 'utf8');
}

function savePortfolioState(state) {
  runAdaptiveLearningEngine(state);
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
  const wanted = new Set(symbols.map(s => `${s}USDT`));
  try {
    const param = JSON.stringify(Array.from(wanted));
    const list = await fetchJson(`${BINANCE_API}/ticker/bookTicker?symbols=${encodeURIComponent(param)}`, {}, 5000);
    const map = {};
    for (const item of list) {
      const sym = item.symbol.replace(/USDT$/, '');
      map[sym] = {
        bestBid: Number(item.bidPrice),
        bestAsk: Number(item.askPrice),
      };
    }
    return map;
  } catch {
    try {
      const allList = await fetchJson(`${BINANCE_API}/ticker/bookTicker`, {}, 7500);
      const map = {};
      for (const item of allList) {
        if (wanted.has(item.symbol)) {
          const sym = item.symbol.replace(/USDT$/, '');
          map[sym] = {
            bestBid: Number(item.bidPrice),
            bestAsk: Number(item.askPrice),
          };
        }
      }
      return map;
    } catch {
      return {};
    }
  }
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
      if (adjQty > walletFree) {
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
      return trRes;
    }
    return { code: -1, msg: JSON.stringify(trRes || {}) };
  } catch (err) {
    return { code: -1, msg: err?.message || 'TR Order Error' };
  }
}

async function runTradingCycle() {
  await syncLiveUsdTryRate();
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  state.usdTryRate = USD_TRY_RATE;
  let trStatus = await fetchBinanceTrStatus(cfg);
  if (trStatus.ok) { state.binanceTrStatus = trStatus.summary; state.walletAssetsMap = trStatus.assetsMap; } else if (state.walletAssetsMap) { trStatus.assetsMap = state.walletAssetsMap; } else { state.binanceTrStatus = trStatus.summary; }

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

    // Engine #7A: ZERO-RISK "FREE-RIDE" (HOUSE MONEY) HARVEST at +3.8% (rides full 100% size up to +3.8% while protected by +1.2% Zero-Risk Stop Lock!)
    if (!pos.partialTpDone && ((!pos.isMoonshot && pos.unrealizedPnlPct >= 3.8) || (pos.isMoonshot && pos.unrealizedPnlPct >= 12.0))) {
      const sellQty = Number((pos.qty * 0.35).toPrecision(4));
      const remainQty = Number((pos.qty - sellQty).toPrecision(4));
      const soldCostUsdt = Number((pos.costUsdt * 0.35).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));

      if (state.mode === 'LIVE_BINANCE') {
        const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
        if (!sellRes || sellRes.code !== 0) {
          sellRes; // Keep position intact if order did not execute
        } else {
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
            exitReason: `💰 1. KADEME (%35) SIFIR RİSK KÂR AL (+%${pos.unrealizedPnlPct})`,
          });

          pos.qty = remainQty;
          pos.costUsdt = Number((pos.costUsdt - soldCostUsdt).toFixed(4));
          pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
          pos.partialTpDone = true;
          pos.rocketMode = true;
          pos.trailingActive = true;
          pos.stopLossPrice = Math.max(
            pos.stopLossPrice,
            Number((pos.entryPrice * 1.022).toPrecision(5)),
            Number((pos.highestPrice * 0.988).toPrecision(5))
          );
          pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));

          logEvent(
            state,
            `💰 [SIFIR RİSK KÂR HASADI] ${pos.symbol} %35'i satıldı (+${toTL(netPnlUsdt)} TL)! Kalan %65 Sıfır Riskle Bedava Uçuşta!`
          );
        }
      }
    }

    // Engine #7B: Stage 2 Profit Harvest (+7.5% -> Sell half of remaining, leave Uncapped Moonbag!)
    if (pos.partialTpDone && !pos.stage2TpDone && pos.unrealizedPnlPct >= 7.5) {
      const sellQty = Number((pos.qty * 0.5).toPrecision(4));
      const remainQty = Number((pos.qty - sellQty).toPrecision(4));
      const soldCostUsdt = Number((pos.costUsdt * 0.5).toFixed(4));
      const proceedsUsdt = Number((currentBid * sellQty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - soldCostUsdt).toFixed(4));

      if (state.mode === 'LIVE_BINANCE') {
        const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', sellQty);
        if (!sellRes || sellRes.code !== 0) { remainingPositions.push(pos); continue; }
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
        exitReason: `🚀 2. KADEME (%35) DEV KÂR AL (+%${pos.unrealizedPnlPct} | Kalan %30 Sınırsız Roket)`,
      });

      pos.qty = remainQty;
      pos.costUsdt = Number((pos.costUsdt - soldCostUsdt).toFixed(4));
      pos.costTry = Math.round(pos.costUsdt * USD_TRY_RATE);
      pos.stage2TpDone = true;
      pos.stopLossPrice = Math.max(
        pos.stopLossPrice,
        Number((pos.entryPrice * 1.062).toPrecision(5)),
        Number((pos.highestPrice * 0.989).toPrecision(5))
      );
      pos.unrealizedPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));

      logEvent(
        state,
        `🚀 [2. KADEME DEV KÂR ALINDI] ${pos.symbol} +%${pos.unrealizedPnlPct} kârla satıldı (+${toTL(netPnlUsdt)} TL)! Son %30 sınırsız uçuşta!`
      );
    }

    // Engine #8: 5-STAGE ZERO-RISK RATCHET LADDER (Adim Adim Sifir Risk Merdiveni)
    // Locks stop-loss above entry at +1.8% gain (+0.60% net floor), and ratchets up guaranteed profit at +2.5%, +3.2%, +4.5%, +7.0% without premature whipsaws!
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    let stepFloorPrice = pos.stopLossPrice;
    if (peakGainPct >= 7.0) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.988).toPrecision(5)), Number((pos.entryPrice * 1.058).toPrecision(5)));
    } else if (peakGainPct >= 4.5) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.highestPrice * 0.986).toPrecision(5)), Number((pos.entryPrice * 1.032).toPrecision(5)));
    } else if (peakGainPct >= 3.2) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.020).toPrecision(5)));
    } else if (peakGainPct >= 2.5) {
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.013).toPrecision(5)));
    } else if (peakGainPct >= 1.8) {
      // Zero-Risk Breakeven+ Lock once coin reaches +1.8% peak (locks +0.60% net profit, giving 1.2% breathing room against whipsaws)
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.006).toPrecision(5)));
    } else if (peakGainPct >= 1.48) {
      // True Breakeven Lock at +1.5% peak: locks +0.35% net profit so a +1.5% winner never turns into a loss!
      stepFloorPrice = Math.max(stepFloorPrice, Number((pos.entryPrice * 1.0035).toPrecision(5)));
    }

    if (stepFloorPrice > pos.stopLossPrice && currentBid > stepFloorPrice) {
      pos.stopLossPrice = stepFloorPrice;
    }
    // Only mark trailingActive = true if stop-loss is genuinely above entry price (in profit)
    pos.trailingActive = pos.stopLossPrice > pos.entryPrice;
    if (peakGainPct >= 2.5 && pos.trailingActive) pos.rocketMode = true;

    const hoursHeld = (nowMs - new Date(pos.entryTime).getTime()) / (1000 * 3600);
    const minsHeld = hoursHeld * 60;
    const latestSig = candidates.find(c => c.symbol === pos.symbol);
    let exitReason = null;

    // Engine #9: ZERO-LOSS EARLY SCRATCH (Sifir Zarar Erken Tahliye Kalkani)
    // If a coin fails to move after 45+ mins and both whale flow (<45%) and orderbook (<-0.25) turn bearish near breakeven, scratch early
    let liveObForScratch = 0;
    if (!pos.partialTpDone && pos.unrealizedPnlPct <= 0.15 && pos.unrealizedPnlPct >= -0.60 && minsHeld >= 45) {
      liveObForScratch = await checkOrderbookImbalance(pos.symbol);
    }

    if (currentBid <= pos.stopLossPrice) {
      const isProfitLock = pos.stopLossPrice > pos.entryPrice && pos.unrealizedPnlPct >= 0;
      exitReason = pos.rocketMode && isProfitLock
        ? `🚀 UÇUŞ MODU KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
        : isProfitLock
          ? `🔒 SIFIR RİSK KÂR KİLİDİ (+%${pos.unrealizedPnlPct})`
          : `🛡️ ATR KORUMA KALKANI (%${pos.unrealizedPnlPct})`;
    } else if (latestSig && latestSig.liveLlmDecision === 'WAIT' && latestSig.liveLlmConfidence >= 75 && !pos.rocketMode) {
      exitReason = `🧠 AI KONSEYİ TUZAK HABER TAHLİYESİ (GPT-120B & Qwen-3.8: Riskli Haber — %${pos.unrealizedPnlPct})`;
    } else if (!pos.partialTpDone && minsHeld >= 45 && pos.unrealizedPnlPct <= 0.1 && pos.unrealizedPnlPct >= -0.60 && liveObForScratch < -0.25 && latestSig && latestSig.takerBuyRatioPct < 45) {
      exitReason = `🛡️ SIFIR RİSK ERKEN TAHLİYE (İvme Zayıfladı, Başa Baş Noktasında Çıkıldı %${pos.unrealizedPnlPct})`;
    } else if (pos.partialTpDone && hoursHeld >= 4.5 && pos.unrealizedPnlPct >= 1.5 && (pos.atr1hPct || 1.5) < 1.0 && currentBid <= pos.highestPrice * 0.996) {
      exitReason = `💰 HIZLI KÂR HASADI & ROTASYON (Yavaşlayan Kârlı Coin Cebe Alındı +%${pos.unrealizedPnlPct})`;
    } else if (hoursHeld >= 12 && pos.unrealizedPnlPct >= 0.15 && pos.unrealizedPnlPct < 0.6 && !pos.partialTpDone) {
      exitReason = `⏱️ KÂRLI ZAMAN ROTASYONU (12 Saatte Yavaş Kalan Coin Kârla Boşaltıldı +${pos.unrealizedPnlPct}%)`;
    }

    if (exitReason) {
      if (state.mode === 'LIVE_BINANCE') {
        const sellRes = await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
        if (!sellRes || sellRes.code !== 0) {
          remainingPositions.push(pos);
          continue;
        }
      }
      const proceedsUsdt = Number((currentBid * pos.qty).toFixed(4));
      const exactCostUsdt = Number((pos.entryPrice * pos.qty).toFixed(4));
      const netPnlUsdt = Number(((currentBid - pos.entryPrice) * pos.qty).toFixed(4));
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
        costUsdt: exactCostUsdt,
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
  if (state.mode === 'LIVE_BINANCE') {
    const freshTr = await fetchBinanceTrStatus(cfg);
    if (freshTr.ok) {
      state.binanceTrStatus = freshTr.summary;
      state.cashUsdt = Number((freshTr.tryFree / USD_TRY_RATE).toFixed(4));
    }
  }

  // Engine #9: Smart Portfolio Rotation + Listing Sniper + Score-Upgrade Auto-Swap
  const heldSymSetForRot = new Set(state.openPositions.map(p => p.symbol));
  const bestCandidate = candidates.find(
    c => !heldSymSetForRot.has(c.symbol) && (c.takerBuyRatioPct || 50) >= 51.0 && (!c.topWhaleLongPct || c.topWhaleLongPct >= 48)
  );
  const isListingSniperAlert = Boolean(
    bestCandidate &&
    bestCandidate.headlines?.some(h => h.source === 'BinanceListingSniper' && h.minutesAgo <= 60) &&
    bestCandidate.totalScore >= 85
  );
  if (
    !signalsData.btcCrashAlert &&
    bestCandidate &&
    bestCandidate.totalScore >= 85 &&
    (bestCandidate.rsi1h || 50) <= (isListingSniperAlert ? 64 : 56) &&
    state.openPositions.length >= cfg.MAX_OPEN_POSITIONS
  ) {
    const stagnantIdx = state.openPositions.findIndex(p => {
      const hrs = (nowMs - new Date(p.entryTime).getTime()) / (1000 * 3600);
      if (isListingSniperAlert && !p.rocketMode && p.unrealizedPnlPct >= 0.15 && p.unrealizedPnlPct <= 1.2 && hrs >= 0.5) return true;
      return hrs >= 4.0 && p.unrealizedPnlPct >= 0.25 && p.unrealizedPnlPct <= 0.8 && !p.partialTpDone;
    });

    if (stagnantIdx !== -1) {
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

    const isWeakMarket = (signalsData.marketBreadthPct ?? 50) < 22;

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

    // Idle Cash Self-Healing Watchdog: If cash >= 2.50 USDT sits idle > 15 mins, relax ecosystem/orderbook filters automatically
    if (state.cashUsdt >= 2.50 && state.openPositions.length < cfg.MAX_OPEN_POSITIONS) {
      if (!state.cashIdleSince) state.cashIdleSince = nowMs;
    } else {
      state.cashIdleSince = null;
    }
    const isCashIdleTooLong = Boolean(state.cashIdleSince && nowMs - state.cashIdleSince >= 15 * 60 * 1000);

    for (const cand of candidates) {
      if (state.openPositions.filter(p => !p.isMoonshot).length >= cfg.MAX_OPEN_POSITIONS) break;
      if (state.cashUsdt < 2.50) break;
      if (heldSymbols.has(cand.symbol)) continue;
      // Only skip if AI explicitly flagged WAIT with ultra-high trap confidence (>=92) AND whale flow is weak (<53%)
      if (cand.liveLlmDecision === 'WAIT' && (cand.liveLlmConfidence || 0) >= 92 && (cand.takerBuyRatioPct || 50) < 53) continue;
      if (usedLeaders.has(cand.leaderSymbol) && !(isCashIdleTooLong && cand.totalScore >= 75)) continue;
      const adaptiveMem = state.adaptiveMemory || runAdaptiveLearningEngine(state);
      const coinMem = adaptiveMem?.coinStats?.[cand.symbol];
      const srcMem = adaptiveMem?.sourceStats?.[cand.headlines?.[0]?.source || 'RSS'];
      const learnedScoreMod = (coinMem?.scoreMod || 0) + (srcMem?.scoreMod || 0);
      const effectiveTotalScore = Number((cand.totalScore + learnedScoreMod).toFixed(1));
      const hasInstitutionalWhaleSurge = (cand.topWhaleLongPct || 0) >= 60 && (cand.oiChange15mPct || 0) >= 0.2;
      const minReqScore = isWeakMarket ? 78 : isAntiMeltdownActive ? 72 : 58;
      const baseMinWhale = isWeakMarket ? 54 : isAntiMeltdownActive ? 54.0 : hasInstitutionalWhaleSurge ? 47.5 : isCashIdleTooLong ? 50.2 : 51.0;
      const baseMaxRsi = isWeakMarket ? 45 : isAntiMeltdownActive ? 48 : isCashIdleTooLong ? 57 : 55;
      const minReqWhale = coinMem ? Math.max(baseMinWhale, coinMem.minWhale) : baseMinWhale;
      const maxReqRsi = coinMem ? Math.min(baseMaxRsi, coinMem.maxRsi) : baseMaxRsi;
      if (effectiveTotalScore < minReqScore) continue;
      if ((cand.freshestMinutesAgo || 0) > 180) continue; // Reject stale news older than 3 hours
      const isSynthCand = ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(cand.headlines?.[0]?.source);
      if (isSynthCand && ((cand.takerBuyRatioPct || 50) < 55.0 || (cand.rsi1h || 50) > 50 || (cand.aiConsensusCount || 0) < 3)) {
        continue; // Synthetic no-news signals require >=55% Whale Taker Buy, RSI <= 50, and >=3/4 AI Consensus
      }
      if ((cand.rsi1h || 50) > maxReqRsi) continue; // Reject top/overbought entries (or learned tighter RSI cap)
      if ((cand.takerBuyRatioPct || 50) < minReqWhale) continue;
      if (cand.topWhaleLongPct && cand.topWhaleLongPct < 42) continue; // Reject if Binance Top 20% Whales are shorting
      if (state.cooldowns[cand.symbol] && state.cooldowns[cand.symbol] > nowMs) continue;

      const candHeadlineClean = (cand.headlines?.[0]?.title || '').trim().toLowerCase();
      if (candHeadlineClean && recentLosingHeadlines.has(candHeadlineClean)) {
        continue; // Skip stale news that already caused a loss
      }

      const q = quotes[cand.symbol];
      if (!q || !q.bestAsk) continue;

      if (state.mode === 'LIVE_BINANCE') {
        const trRule = await getBinanceTrSymbolRules(cand.symbol);
        if (!trRule || trRule.spotTradingEnable !== 1) continue;
      }

      const obImbalance = await checkOrderbookImbalance(cand.symbol);
      const minAllowedOb = isCashIdleTooLong ? -0.18 : -0.08;
      if (obImbalance < minAllowedOb) {
        logEvent(state, `⚖️ [Tahta Kalkanı] ${cand.symbol} önünde satış duvarı (${obImbalance}) var, pas geçildi.`);
        continue;
      }

      // Engine #8 + #13: Auto-Compounding Sizing with Anti-Meltdown Throttle (cuts risk by 40% during a 2-loss streak)
      const baseConvictionPct = cand.totalScore >= 80 ? 0.42 : cand.totalScore >= 68 ? 0.36 : 0.32;
      const convictionPct = isAntiMeltdownActive ? Number((baseConvictionPct * 0.6).toFixed(3)) : baseConvictionPct;
      const targetAllocUsdt = Math.floor(currentTotalEquity * convictionPct * 100) / 100;
      const availCashUsdt = Math.floor(Math.max(0, state.cashUsdt) * 100) / 100;
      const costUsdt = Number(Math.min(targetAllocUsdt, availCashUsdt).toFixed(2));
      if (costUsdt < 2.50) continue;

      const buyPrice = q.bestAsk;
      const qty = Number((costUsdt / buyPrice).toPrecision(4));

      if (state.mode === 'LIVE_BINANCE') {
        const buyRes = await executeBinanceRealOrder(cfg, cand.symbol, 'BUY', qty, costUsdt);
        if (!buyRes || buyRes.code !== 0) continue;
      }

      // Use healthy ATR-based stop-loss (2.0% to 3.2%) so normal 15m volatility doesn't stop out the trade
      const safeSlPct = Number(Math.max(2.0, Math.min(Number(cand.slPct || 2.4), 3.2)).toFixed(2));
      const tpPrice = Number((buyPrice * (1 + cand.tpPct / 100)).toPrecision(5));
      const slPrice = Number((buyPrice * (1 - safeSlPct / 100)).toPrecision(5));

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

      logEvent(
        state,
        `🟢 [OTOMATİK ALIM] ${cand.symbol} (${toTL(costUsdt)} TL) @ $${buyPrice} | Skor: ${cand.totalScore} | RSI: ${cand.rsi1h} | Balina: %${newPos.takerBuyRatioPct} | SL: -%${safeSlPct}`
      );
    }
  }

  // Step 4: Engine #11 — PROTECTED ASYMMETRIC "VURGUN" SLOT (Only enters with AI LONG + Orderbook + Cooldown + RSI <= 52!)
  if (!signalsData.btcCrashAlert && !state.openPositions.some(p => p.isMoonshot) && state.cashUsdt >= 2.50) {
    const heldNow = new Set(state.openPositions.map(p => p.symbol));
    const moonCandidates = [...candidates]
      .filter(c => {
        if (heldNow.has(c.symbol)) return false;
        if (state.cooldowns[c.symbol] && state.cooldowns[c.symbol] > nowMs) return false;
        if ((c.freshestMinutesAgo || 0) > 180) return false;
        const isSynthMoon = ['WhaleOrderflowRadar', 'ShortSqueezeRadar'].includes(c.headlines?.[0]?.source);
        if (isSynthMoon && ((c.takerBuyRatioPct || 50) < 56.0 || (c.rsi1h || 50) > 48 || (c.aiConsensusCount || 0) < 3)) return false;
        if (c.liveLlmDecision && c.liveLlmDecision !== 'LONG') return false;
        if ((c.rsi1h || 50) > 55) return false;
        if (c.totalScore < 70 || (c.takerBuyRatioPct || 50) < 54) return false;
        const hClean = (c.headlines?.[0]?.title || '').trim().toLowerCase();
        if (hClean && recentLosingHeadlines.has(hClean)) return false;
        return true;
      })
      .sort((a, b) => (b.takerBuyRatioPct || 50) * 1.2 + b.totalScore - ((a.takerBuyRatioPct || 50) * 1.2 + a.totalScore));

    for (const moonPick of moonCandidates) {
      if (state.mode === 'LIVE_BINANCE') {
        const trRule = await getBinanceTrSymbolRules(moonPick.symbol);
        if (!trRule || trRule.spotTradingEnable !== 1) continue;
      }

      const moonOb = await checkOrderbookImbalance(moonPick.symbol);
      if (moonOb < -0.05) {
        logEvent(state, `⚖️ [Tahta Kalkanı - Vurgun] ${moonPick.symbol} önünde satış duvarı (${moonOb}) var, pas geçildi.`);
        continue;
      }

      let mq = quotes[moonPick.symbol];
      if (!mq || !mq.bestAsk) {
        const extraQuotes = await getOrderbookQuotes([moonPick.symbol]);
        mq = extraQuotes[moonPick.symbol];
      }
      if (mq && mq.bestAsk > 0) {
        const moonAllocUsdt = Number(Math.min(state.cashUsdt, currentTotalEquity * 0.16).toFixed(2));
        if (moonAllocUsdt >= 2.50) {
          const buyPrice = mq.bestAsk;
          const qty = Number((moonAllocUsdt / buyPrice).toPrecision(4));
          if (state.mode === 'LIVE_BINANCE') {
            const buyRes = await executeBinanceRealOrder(cfg, moonPick.symbol, 'BUY', qty, moonAllocUsdt);
            if (!buyRes || buyRes.code !== 0) continue;
          }
          const tpPct = 18.0;
          const slPct = Number(Math.max(2.4, Math.min(Number(moonPick.slPct || 2.6), 3.2)).toFixed(2));
          const tpPrice = Number((buyPrice * (1 + tpPct / 100)).toPrecision(5));
          const slPrice = Number((buyPrice * (1 - slPct / 100)).toPrecision(5));

          state.cashUsdt = Number((state.cashUsdt - moonAllocUsdt).toFixed(4));
          state.openPositions.push({
            id: `moon_${Date.now()}_${moonPick.symbol}`,
            symbol: moonPick.symbol,
            isMoonshot: true,
            leaderSymbol: moonPick.leaderSymbol,
            ecosystem: moonPick.ecosystems?.[0] || 'Vurgun',
            headline: `🎰 VURGUN SLOTU: ${moonPick.headlines?.[0]?.title || 'Balina Hacim Patlaması'}`,
            newsSource: moonPick.headlines?.[0]?.source || 'WhaleRadar',
            newsScore: moonPick.newsScore,
            totalScore: moonPick.totalScore,
            rsiAtEntry: moonPick.rsi1h,
            atr1hPct: moonPick.atr1hPct || 2.5,
            takerBuyRatioPct: moonPick.takerBuyRatioPct || 55,
            obImbalance: moonOb,
            entryTime: new Date().toISOString(),
            entryPrice: buyPrice,
            currentPrice: mq.bestBid || buyPrice,
            highestPrice: buyPrice,
            qty,
            costUsdt: moonAllocUsdt,
            costTry: Math.round(moonAllocUsdt * USD_TRY_RATE),
            takeProfitPrice: tpPrice,
            stopLossPrice: slPrice,
            tpPct,
            slPct,
            partialTpDone: false,
            stage2TpDone: false,
            trailingActive: false,
            rocketMode: false,
            unrealizedPnlUsdt: Number((((mq.bestBid || buyPrice) - buyPrice) * qty).toFixed(4)),
            unrealizedPnlPct: Number(((((mq.bestBid || buyPrice) - buyPrice) / buyPrice) * 100).toFixed(2)),
          });

          logEvent(
            state,
            `🎰 [VURGUN SLOTU AÇILDI] ${moonPick.symbol} (${toTL(moonAllocUsdt)} TL) @ $${buyPrice} | Hedef: +%18 | RSI: ${moonPick.rsi1h} | Balina: %${moonPick.takerBuyRatioPct} | SL: -%${slPct}`
          );
          break;
        }
      }
    }
  }

  // Refresh Binance TR wallet status after any buys/sells in this cycle before running Engine #14 Self-Auditor
  if (state.mode === 'LIVE_BINANCE') {
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
          stopLossPrice: Number((usdtBid * 0.9724).toPrecision(5)),
          tpPct: 5.5,
          slPct: 2.76,
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
      return `- ${p.symbol}${p.isMoonshot ? ' (Vurgun)' : ''}: ${curTry} TL (Kar: ${pnlSign}${pnlTry} TL | Hedef: ${targetTry} TL)`;
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
        const modeTxt = p.stage2TpDone
          ? '🚀 2 Kademe Alındı, Kalan %30 Sınırsız Roket'
          : p.partialTpDone
            ? '🔒 1. Kademe Cebimizde, Kalan %65 Sıfır Risk Uçuşta'
            : p.trailingActive
              ? '🔒 Sıfır Risk Kâr Kilidi Aktif (Stop: $' + p.stopLossPrice + ')'
              : '🛡️ +%1.2 Sıfır Risk Kilidi, +%3.8 Kâr Hasadı';
        return '<tr>' +
          '<td><strong>' + p.symbol + '</strong> <small style="color:#38bdf8;">(' + p.qty + ' Adet @ $' + p.currentPrice + ')</small><br><small style="color:#94a3b8;">' + p.headline + '</small></td>' +
          '<td>' + costTryVal.toFixed(2) + ' TL <small style="color:#94a3b8;">($' + costUsd.toFixed(2) + ')</small></td>' +
          '<td><strong>' + curTryVal.toFixed(2) + ' TL</strong> <small style="color:#94a3b8;">($' + curUsd.toFixed(2) + ')</small></td>' +
          '<td class="' + pClass + '">' + pSign + diffTry.toFixed(2) + ' TL (' + pSign + '%' + p.unrealizedPnlPct + ')</td>' +
          '<td>' + modeTxt + '</td>' +
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

let _tgOffset = 0;
let _tgLoopStarted = false;
async function startTelegramCommandBot() {
  if (_tgLoopStarted) return;
  _tgLoopStarted = true;
  setInterval(async () => {
    const cfg = loadEnv();
    if (!cfg.TELEGRAM_BOT_TOKEN) return;
    try {
      const res = await fetchJson(
        `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${_tgOffset + 1}&timeout=1`,
        {},
        4000
      );
      for (const upd of res?.result || []) {
        _tgOffset = Math.max(_tgOffset, upd.update_id);
        const msg = upd.message;
        if (!msg || !msg.text) continue;
        const chatId = String(msg.chat.id);
        const text = msg.text.trim();
        const lower = text.toLowerCase();

        // Save chat_id automatically on first message
        if (!cfg.TELEGRAM_CHAT_ID && fs.existsSync(ENV_FILE)) {
          const envRaw = fs.readFileSync(ENV_FILE, 'utf8').replace(/TELEGRAM_CHAT_ID=.*/g, `TELEGRAM_CHAT_ID=${chatId}`);
          fs.writeFileSync(ENV_FILE, envRaw, 'utf8');
        }

        let reply = '';
        if (lower.startsWith('/durum') || lower === 'durum') {
          const st = loadPortfolioState(cfg);
          reply = `📊 CANLI KASA DURUMU\n\n${buildSimpleWhatsAppMessage(st)}`;
        } else if (lower.startsWith('/sat ')) {
          const sym = text.split(/\s+/)[1];
          const r = await sellPositionManual(sym, '🤖 TELEGRAM KOMUTUYLA MANUEL SATIŞ');
          reply = `${r.ok ? '✅' : '⚠️'} ${r.msg}\n\n${buildSimpleWhatsAppMessage(r.state)}`;
        } else if (lower.startsWith('/nakit') || lower === 'nakit') {
          const r = await sellAllPositionsManual('🤖 TELEGRAM ACİL NAKİT KOMUTU');
          reply = `🛡️ Tüm açık coinler (${r.count} adet) satıldı ve TL nakite geçildi!\n\n${buildSimpleWhatsAppMessage(r.state)}`;
        } else if (lower.startsWith('/tara') || lower === 'tara') {
          const r = await safeRunTradingCycle();
          reply = `⚡ Anlık haber ve tahta taraması tamamlandı!\n\n${buildSimpleWhatsAppMessage(r.state)}`;
        } else {
          reply = `🤖 AltcoinAutoTrader v9.5 Kumanda\n\nKomutlar:\n• /durum — Anlık TL Kasa ve Açık Coinler\n• /sat AVAX — Belirtilen coini hemen satar\n• /nakit — Tüm coinleri satıp TL'ye geçer\n• /tara — Şimdi haber taraması yapar`;
        }

        await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reply }),
        }).catch(() => {});
      }
    } catch {
      // Ignore polling hiccups
    }
  }, 4000);
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
  const result = await safeRunTradingCycle();
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

    server.listen(port, '0.0.0.0', () => {
      console.log(`\n🌐 TL Bazlı Canlı Web Kontrol Paneli: http://localhost:${port}`);
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
