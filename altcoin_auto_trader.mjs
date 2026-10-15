#!/usr/bin/env node
/**
 * AltcoinAutoTrader v5.0 — Autonomous News-to-Altcoin Execution Engine + Web Dashboard
 *
 * Features:
 * 1. Scans 6 global crypto news feeds + 69 Binance Altcoins across 10 Ecosystems
 * 2. Automatic Buy Execution:
 *    - LIVE_TRADING=true  -> Executes real signed HMAC-SHA256 orders on Binance Spot (/api/v3/order)
 *    - LIVE_TRADING=false -> Executes against real-time Binance Orderbook Best Ask (Buy) & Best Bid (Sell)
 * 3. Autonomous Position Management (Every Cycle):
 *    - Take-Profit (TP) auto-sell
 *    - Stop-Loss (SL) auto-sell
 *    - Dynamic Trailing Stop: Once a coin rises +2.2%, SL automatically moves above entry (+0.6% profit lock)
 *      and trails 1.8% behind the highest price reached
 * 4. Built-in Live Web Control Panel at http://localhost:3847 (--daemon mode)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { runNewsScan } from './altcoin_news_hunter.mjs';

const STATE_FILE = path.resolve('portfolio_state.json');
const SIGNALS_FILE = path.resolve('altcoin_news_signals.json');
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
    ORDER_SIZE_USDT: Number(process.env.ORDER_SIZE_USDT || 7.50),
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
      return JSON.parse(raw);
    } catch {
      // Fallback to fresh state
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
    openPositions: [],
    closedTrades: [],
    recentLogs: [],
  };
}

function savePortfolioState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
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
        'User-Agent': 'AltcoinAutoTrader/5.0',
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

/**
 * Fetch exact live Best Bid & Best Ask from Binance Orderbook (/api/v3/ticker/bookTicker)
 */
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
      bidQty: Number(item.bidQty),
      askQty: Number(item.askQty),
    };
  }
  return map;
}

/**
 * Execute real signed Binance Spot Market Order when LIVE_TRADING=true
 */
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

/**
 * Run a single full trading cycle:
 * 1. Refresh news catalyst signals via altcoin_news_hunter.mjs
 * 2. Monitor open positions against live Binance Bid/Ask -> trigger Trailing Stop / TP / SL
 * 3. Open new positions on top-scoring news altcoins if slots & cash available
 */
async function runTradingCycle() {
  const cfg = loadEnv();
  const state = loadPortfolioState(cfg);
  state.mode = cfg.LIVE_TRADING && cfg.BINANCE_API_KEY ? 'LIVE_BINANCE' : 'REALTIME_ORDERBOOK_PAPER';

  // Step 1: Run the 69-altcoin news scanner in-memory to get fresh signals
  let signalsData = { top4AltcoinPicks: [], allQualifiedOpportunities: [] };
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

  // Step 2: Manage existing open positions (Check TP, SL, and Trailing Stop)
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

    // Dynamic Trailing Stop Logic:
    // Once coin reaches +2.2% profit, lock stop-loss above entry (+0.6%) and trail 1.8% behind peak
    const peakGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (peakGainPct >= 2.2) {
      const breakEvenPlus = Number((pos.entryPrice * 1.006).toPrecision(5));
      const trailStop = Number((pos.highestPrice * 0.982).toPrecision(5));
      const newStop = Math.max(pos.stopLossPrice, breakEvenPlus, trailStop);
      if (newStop > pos.stopLossPrice) {
        pos.stopLossPrice = newStop;
        pos.trailingActive = true;
        logEvent(state, `🔒 [Trailing Stop] ${pos.symbol} kâr kilidi yükseltildi -> Yeni SL: $${pos.stopLossPrice}`);
      }
    }

    let exitReason = null;
    if (currentBid >= pos.takeProfitPrice) {
      exitReason = `HEDEF KÂR AL (TP +${pos.unrealizedPnlPct}%)`;
    } else if (currentBid <= pos.stopLossPrice) {
      exitReason = pos.trailingActive
        ? `İZ SÜREN KÂR KİLİDİ (Trailing Stop ${pos.unrealizedPnlPct}%)`
        : `ZARAR KES (SL ${pos.unrealizedPnlPct}%)`;
    }

    if (exitReason) {
      if (state.mode === 'LIVE_BINANCE') {
        await executeBinanceRealOrder(cfg, pos.symbol, 'SELL', pos.qty);
      }
      const proceedsUsdt = Number((currentBid * pos.qty).toFixed(4));
      const netPnlUsdt = Number((proceedsUsdt - pos.costUsdt).toFixed(4));
      state.cashUsdt = Number((state.cashUsdt + proceedsUsdt).toFixed(4));
      state.realizedPnlUsdt = Number((state.realizedPnlUsdt + netPnlUsdt).toFixed(4));
      if (netPnlUsdt >= 0) state.winCount++;
      else state.lossCount++;

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
        `💰 [SATIŞ TAMAMLANDI] ${pos.symbol} @ $${currentBid} | Sebep: ${exitReason} | Net Kâr/Zarar: $${netPnlUsdt} (${closedRecord.netPnlTry} TL)`
      );
    } else {
      remainingPositions.push(pos);
    }
  }
  state.openPositions = remainingPositions;

  // Step 3: Open new positions if we have free slots and cash
  const usedLeaders = new Set(state.openPositions.map(p => p.leaderSymbol));
  const heldSymbols = new Set(state.openPositions.map(p => p.symbol));

  for (const cand of candidates) {
    if (state.openPositions.length >= cfg.MAX_OPEN_POSITIONS) break;
    if (state.cashUsdt < cfg.ORDER_SIZE_USDT) break;
    if (heldSymbols.has(cand.symbol)) continue;
    if (usedLeaders.has(cand.leaderSymbol)) continue;
    if (cand.totalScore < 58) continue;

    const q = quotes[cand.symbol];
    if (!q || !q.bestAsk) continue;

    const buyPrice = q.bestAsk; // Realistic execution at Best Ask
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
      trailingActive: false,
      unrealizedPnlUsdt: Number((((q.bestBid || buyPrice) - buyPrice) * qty).toFixed(4)),
      unrealizedPnlPct: Number(((((q.bestBid || buyPrice) - buyPrice) / buyPrice) * 100).toFixed(2)),
    };

    state.cashUsdt = Number((state.cashUsdt - costUsdt).toFixed(4));
    state.openPositions.push(newPos);
    heldSymbols.add(cand.symbol);
    usedLeaders.add(cand.leaderSymbol);

    logEvent(
      state,
      `🟢 [OTOMATİK ALIM] ${cand.symbol}USDT @ $${buyPrice} (Ask) | Tutar: $${costUsdt} (~${newPos.costTry} TL) | Skor: ${cand.totalScore} | TP: $${tpPrice} (+%${cand.tpPct}) | SL: $${slPrice} (-%${cand.slPct})`
    );
  }

  // Compute total equity
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
  <title>AltcoinAutoTrader v5.0 — Canlı Haber & Otomatik Al-Sat Paneli</title>
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
      --amber: #f59e0b;
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
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.4);
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
    .btn:hover { opacity: 0.9; }
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
    th, td {
      text-align: left;
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .pos { color: var(--green); font-weight: 600; }
    .neg { color: var(--red); font-weight: 600; }
    .log-box {
      background: #070a12;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      font-family: monospace;
      font-size: 13px;
      max-height: 220px;
      overflow-y: auto;
      color: #cbd5e1;
    }
    .log-line { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 style="font-size: 20px;">🎯 AltcoinAutoTrader v5.0 — Canlı Haberden Otomatik Al-Sat</h1>
      <p style="font-size: 13px; color: var(--muted); margin-top: 4px;">
        6 Küresel Haber Kaynağı + 69 Binance Altcoin + Otomatik Kar Al (TP) / İz Süren Stop (Trailing SL)
      </p>
    </div>
    <div style="display:flex; gap:12px; align-items:center;">
      <span id="modeBadge" class="badge">YÜKLENİYOR...</span>
      <button class="btn" onclick="triggerCycle()">⚡ Şimdi Tara & İşlem Yap</button>
    </div>
  </div>

  <div class="grid-kpi">
    <div class="kpi">
      <div class="kpi-label">Toplam Portföy Değeri</div>
      <div class="kpi-val" id="equityVal">$28.01 (1,000 TL)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Boştaki Nakit (USDT)</div>
      <div class="kpi-val" id="cashVal">$0.00</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Toplam Net Kâr / Zarar</div>
      <div class="kpi-val" id="pnlVal">$0.00 (%0.00)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Kazanma Oranı (Win / Loss)</div>
      <div class="kpi-val" id="winVal">0 W / 0 L</div>
    </div>
  </div>

  <div class="section">
    <h2>🟢 Açık Altcoin Pozisyonları (Canlı Binance Orderbook Takibi)</h2>
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Yakaladığı Haber Katalizörü</th>
          <th>Giriş (Ask)</th>
          <th>Canlı Fiyat (Bid)</th>
          <th>Tutar / Adet</th>
          <th>Hedef TP / İz Süren SL</th>
          <th>Anlık Kâr/Zarar</th>
        </tr>
      </thead>
      <tbody id="openBody"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>📜 Tamamlanan (Satılan) İşlemler</h2>
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Giriş -> Çıkış</th>
          <th>Çıkış Sebebi</th>
          <th>Net Kâr/Zarar</th>
          <th>Zaman</th>
        </tr>
      </thead>
      <tbody id="closedBody"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>📡 Canlı Bot İşlem Kayıtları (Logs)</h2>
    <div class="log-box" id="logBox"></div>
  </div>

  <script>
    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      const s = data.state;

      document.getElementById('modeBadge').textContent =
        s.mode === 'LIVE_BINANCE' ? '🔴 GERÇEK BINANCE API MODU' : '🟢 CANLI TAHTA (PAPER) OTO AL-SAT';
      document.getElementById('equityVal').textContent =
        '$' + s.totalEquityUsdt.toFixed(2) + ' (~' + s.totalEquityTry + ' TL)';
      document.getElementById('cashVal').textContent = '$' + s.cashUsdt.toFixed(2);

      const pnlEl = document.getElementById('pnlVal');
      const sign = s.totalPnlUsdt >= 0 ? '+' : '';
      pnlEl.textContent = sign + '$' + s.totalPnlUsdt.toFixed(3) + ' (' + sign + s.totalPnlPct + '%)';
      pnlEl.className = 'kpi-val ' + (s.totalPnlUsdt >= 0 ? 'pos' : 'neg');

      document.getElementById('winVal').textContent = s.winCount + ' Başarılı / ' + s.lossCount + ' Stop';

      const openBody = document.getElementById('openBody');
      if (!s.openPositions.length) {
        openBody.innerHTML = '<tr><td colspan="7" style="color:#94a3b8;">Açık pozisyon yok.</td></tr>';
      } else {
        openBody.innerHTML = s.openPositions.map(p => {
          const pClass = p.unrealizedPnlUsdt >= 0 ? 'pos' : 'neg';
          const pSign = p.unrealizedPnlUsdt >= 0 ? '+' : '';
          return '<tr>' +
            '<td><strong>' + p.symbol + 'USDT</strong><br><small style="color:#94a3b8;">Lider: ' + p.leaderSymbol + ' | Skor: ' + p.totalScore + '</small></td>' +
            '<td style="max-width:340px;">[' + p.newsSource + '] ' + p.headline + '</td>' +
            '<td>$' + p.entryPrice + '</td>' +
            '<td><strong>$' + p.currentPrice + '</strong></td>' +
            '<td>$' + p.costUsdt + ' (' + p.qty + ' ' + p.symbol + ')</td>' +
            '<td><span class="pos">TP: $' + p.takeProfitPrice + ' (+%' + p.tpPct + ')</span><br><span class="neg">SL: $' + p.stopLossPrice + ' (-%' + p.slPct + ')</span></td>' +
            '<td class="' + pClass + '">' + pSign + '$' + p.unrealizedPnlUsdt + ' (' + pSign + p.unrealizedPnlPct + '%)</td>' +
          '</tr>';
        }).join('');
      }

      const closedBody = document.getElementById('closedBody');
      if (!s.closedTrades.length) {
        closedBody.innerHTML = '<tr><td colspan="5" style="color:#94a3b8;">Henüz kapanan işlem yok (TP veya SL bekleniyor).</td></tr>';
      } else {
        closedBody.innerHTML = s.closedTrades.map(c => {
          const cClass = c.netPnlUsdt >= 0 ? 'pos' : 'neg';
          const cSign = c.netPnlUsdt >= 0 ? '+' : '';
          return '<tr>' +
            '<td><strong>' + c.symbol + 'USDT</strong></td>' +
            '<td>$' + c.entryPrice + ' -> $' + c.exitPrice + '</td>' +
            '<td>' + c.exitReason + '</td>' +
            '<td class="' + cClass + '">' + cSign + '$' + c.netPnlUsdt + ' (' + cSign + c.netPnlTry + ' TL)</td>' +
            '<td>' + new Date(c.exitTime).toLocaleTimeString('tr-TR') + '</td>' +
          '</tr>';
        }).join('');
      }

      document.getElementById('logBox').innerHTML = (s.recentLogs || [])
        .map(l => '<div class="log-line">' + l + '</div>')
        .join('');
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

  console.log('\n================================================================================');
  console.log(`💼 [PORTFÖY ÖZETİ] Mod: ${result.state.mode}`);
  console.log(`   Toplam Varlık: $${result.state.totalEquityUsdt} (~${result.state.totalEquityTry} TL) | Boştaki Nakit: $${result.state.cashUsdt}`);
  console.log(`   Açık Pozisyon Sayısı: ${result.state.openPositions.length} | Kapanan İşlem: ${result.state.closedTrades.length}`);
  console.log('================================================================================');

  for (const pos of result.state.openPositions) {
    console.log(
      `   📌 AÇIK: ${pos.symbol}USDT | Giriş: $${pos.entryPrice} -> Canlı Bid: $${pos.currentPrice} | Anlık PnL: $${pos.unrealizedPnlUsdt} (%${pos.unrealizedPnlPct}) | TP: $${pos.takeProfitPrice} | SL: $${pos.stopLossPrice}`
    );
  }

  if (isDaemon) {
    const cfg = loadEnv();
    const port = 3847;
    const server = http.createServer(async (req, res) => {
      if (req.url === '/api/state') {
        const currentState = loadPortfolioState(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ state: currentState }));
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
      console.log(`\n🌐 Canlı Web Kontrol Paneli Aktif: http://localhost:${port}`);
      console.log(`⏱️  Otomatik Tarama & Al-Sat Döngüsü: Her ${cfg.SCAN_INTERVAL_SECONDS} saniyede bir çalışıyor...`);
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
