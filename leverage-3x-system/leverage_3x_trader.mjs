import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import tls from 'tls';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const STATE_FILE = path.join(__dirname, 'leverage_3x_state.json');
const REPORT_FILE = path.join(__dirname, 'KALDIRAC_3X_RAPOR.md');
const NEWS_SIGNALS_FILE = path.join(ROOT_DIR, 'altcoin_news_signals.json');
const SPOT_STATE_FILE = path.join(ROOT_DIR, 'portfolio_state.json');
const ENV_FILE = path.join(ROOT_DIR, '.env');

const FAPI_BASE = 'https://fapi.binance.com';
const USD_TRY_RATE = 49.55;
const LEVERAGE = 3; // Base Low-Wick Institutional Leverage (300 TL -> 3x = 900 TL, 3.5x = 1.050 TL, 4x = 1.200 TL)
const MAX_CONVICTION_LEVERAGE = 4;
const INITIAL_BANKROLL_TRY = 300.0;
const INITIAL_BANKROLL_USDT = Number((INITIAL_BANKROLL_TRY / USD_TRY_RATE).toFixed(4)); // ~6.0545 USDT
const MIN_NOTIONAL_USDT = 5.0; // Binance Futures hard minimum notional floor
const ROUND_TRIP_FEE_SLIP_FRAC = 0.0018; // 0.05% taker entry + 0.05% taker exit + 0.08% perp slippage on notional
const DASHBOARD_PORT = 3848;
let isPositionCycleBusy = false; // Strict Mutex Lock preventing 4s vs 30s double-close/double-refund race condition
let busySinceMs = 0; // Self-healing watchdog timestamp so sleep/wake socket hangs can never freeze the bot

const PERP_UNIVERSE = [
  'SOL', 'XRP', 'DOGE', 'SUI', 'ADA', 'AVAX', 'LINK', 'NEAR', 'APT', 'ARB',
  'OP', 'INJ', 'FET', 'RENDER', 'SEI', 'TIA', 'AAVE', 'UNI', 'WIF', '1000PEPE',
  'PENDLE', 'ENA', 'ONDO', 'JUP', 'TAO', 'WLD', 'FIL', 'ATOM', 'DOT', '1000BONK'
];

const EXCLUDED_FAPI_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'FDUSDUSDT', 'USDPUSDT', 'TUSDUSDT', 'BUSDUSDT', 'USDTTRY', 'BTCDOMUSDT', 'DEFIUSDT'
]);

let cachedValidCoinPerps = null;
let cachedValidCoinPerpsAtMs = 0;

async function getValidCoinPerpMap() {
  const now = Date.now();
  if (cachedValidCoinPerps && now - cachedValidCoinPerpsAtMs < 10 * 60 * 1000) {
    return cachedValidCoinPerps;
  }
  const info = await fetchJson(`${FAPI_BASE}/fapi/v1/exchangeInfo`, {}, 5000);
  if (info && Array.isArray(info.symbols)) {
    const map = new Map();
    for (const s of info.symbols) {
      if (
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.underlyingType === 'COIN' &&
        s.quoteAsset === 'USDT' &&
        !EXCLUDED_FAPI_SYMBOLS.has(s.symbol) &&
        !(Array.isArray(s.underlyingSubType) && s.underlyingSubType.includes('Alpha'))
      ) {
        map.set(s.symbol, s);
      }
    }
    if (map.size >= 30) {
      cachedValidCoinPerps = map;
      cachedValidCoinPerpsAtMs = now;
      return map;
    }
  }
  return cachedValidCoinPerps;
}

function selectConvictionLeverage(score, atr15mPct) {
  if (score >= 92 && atr15mPct <= 1.85) return 4;   // Ultra-Apex Sniper Shot (4x = 1.200 TL Power)
  if (score >= 85 && atr15mPct <= 2.40) return 3.5; // High-Conviction Surge (3.5x = 1.050 TL Power)
  return 3;                                         // Standard Anti-Wick Institutional Leverage (3x = 900 TL Power)
}

function sendGmailSmtp({ fromEmail, appPassword, toEmail, subject, textBody }) {
  return new Promise(resolve => {
    if (!fromEmail || !appPassword || !toEmail) return resolve(false);
    const cleanPass = appPassword.replace(/\s+/g, '');
    const socket = tls.connect(465, 'smtp.gmail.com', { rejectUnauthorized: false });
    let step = 0;
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolve(false);
    }, 9000);

    const finish = ok => {
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(ok);
    };

    socket.on('error', () => finish(false));
    socket.on('data', chunk => {
      const resp = chunk.toString();
      if (step === 0 && resp.startsWith('220')) {
        step = 1;
        socket.write('EHLO localhost\r\n');
      } else if (step === 1 && resp.includes('250')) {
        step = 2;
        socket.write('AUTH LOGIN\r\n');
      } else if (step === 2 && resp.startsWith('334')) {
        step = 3;
        socket.write(Buffer.from(fromEmail).toString('base64') + '\r\n');
      } else if (step === 3 && resp.startsWith('334')) {
        step = 4;
        socket.write(Buffer.from(cleanPass).toString('base64') + '\r\n');
      } else if (step === 4 && resp.startsWith('235')) {
        step = 5;
        socket.write(`MAIL FROM:<${fromEmail}>\r\n`);
      } else if (step === 5 && resp.startsWith('250')) {
        step = 6;
        socket.write(`RCPT TO:<${toEmail}>\r\n`);
      } else if (step === 6 && resp.startsWith('250')) {
        step = 7;
        socket.write('DATA\r\n');
      } else if (step === 7 && resp.startsWith('354')) {
        step = 8;
        const msg = [
          `From: "Yirtici Kaldirac Botu" <${fromEmail}>`,
          `To: <${toEmail}>`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          '',
          textBody,
          '.',
          '',
        ].join('\r\n');
        socket.write(msg);
      } else if (step === 8 && resp.startsWith('250')) {
        step = 9;
        socket.write('QUIT\r\n');
        finish(true);
      } else if (resp.startsWith('4') || resp.startsWith('5')) {
        finish(false);
      }
    });
  });
}

function sweepProfitToSpotVault(state, stepGainUsdt, symbol, reasonLabel) {
  state.spotVaultUsdt = Number((state.spotVaultUsdt || 0).toFixed(4));
  state.spotTransfers = state.spotTransfers || [];

  const openMarginUsdt = state.openPosition ? Number(state.openPosition.marginUsdt || 0) : 0;
  const currentPrincipalUsdt = Number((state.marginCashUsdt + openMarginUsdt).toFixed(4));

  // Rule 1: 100% of any balance above 100.00 TL (INITIAL_BANKROLL_USDT = 2.0182) is ALWAYS swept to Spot Wallet
  const excessAbove100Usdt = Math.max(0, Number((currentPrincipalUsdt - INITIAL_BANKROLL_USDT).toFixed(4)));
  // Rule 2: Even when below 100 TL, 50% of every positive profit is immediately swept to Spot Wallet (keeping >= $1.35 USDT MIN_NOTIONAL safety floor)
  const halfStepProfitUsdt = stepGainUsdt > 0 ? Number((stepGainUsdt * 0.50).toFixed(4)) : 0;

  let sweepUsdt = Math.max(excessAbove100Usdt, halfStepProfitUsdt);
  if (currentPrincipalUsdt <= INITIAL_BANKROLL_USDT && currentPrincipalUsdt - sweepUsdt < 1.35) {
    sweepUsdt = Math.max(0, Number((currentPrincipalUsdt - 1.35).toFixed(4)));
  }
  sweepUsdt = Math.min(sweepUsdt, state.marginCashUsdt);
  sweepUsdt = Number(sweepUsdt.toFixed(4));

  if (sweepUsdt < 0.0002) {
    return { sweptUsdt: 0, sweptTry: 0, totalSpotVaultTry: toTL(state.spotVaultUsdt) };
  }

  state.marginCashUsdt = Number((state.marginCashUsdt - sweepUsdt).toFixed(4));
  state.spotVaultUsdt = Number((state.spotVaultUsdt + sweepUsdt).toFixed(4));
  const sweptTry = toTL(sweepUsdt);
  const totalSpotVaultTry = toTL(state.spotVaultUsdt);

  const ts = new Date().toLocaleString('tr-TR');
  state.spotTransfers.unshift({
    time: ts,
    symbol,
    amountTry: sweptTry,
    amountUsdt: sweepUsdt,
    totalVaultTry: totalSpotVaultTry,
    reason: reasonLabel,
  });
  if (state.spotTransfers.length > 30) state.spotTransfers.length = 30;

  logEvent(
    state,
    `🏦 [SPOT CÜZDANA KÂR TRANSFERİ] ${symbol} işleminden +${sweptTry} TL kâr Spot Cüzdana aktarıldı! (Toplam Spot Kâr Kasası: +${totalSpotVaultTry} TL | Aktif Kaldıraç Kasası Max 100 TL Korumasında)`
  );

  return { sweptUsdt: sweepUsdt, sweptTry, totalSpotVaultTry };
}

async function sendProfitNotification(state, info) {
  const cfg = loadEnv();
  const toEmail = cfg.ALERT_EMAIL_TO || 'berkeakdemir5855@gmail.com';
  const rawPass = (cfg.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const appPass = rawPass && !rawPass.includes('@') ? rawPass : '';
  const composioKey = (cfg.COMPOSIO_API_KEY || '').trim();
  const ts = new Date().toLocaleString('tr-TR');
  const equityAfterTry = toTL(
    state.marginCashUsdt +
      (state.openPosition ? state.openPosition.marginUsdt + (state.openPosition.unrealizedPnlUsdt || 0) : 0)
  );
  const spotTransferTry = Number(info.spotTransferTry || 0);
  const totalSpotVaultTry = toTL(state.spotVaultUsdt || 0);

  const subject = `💰 [KÂR & SPOT TRANSFER] ${info.symbol} (${info.leverage}x ${info.side}) -> +${info.netPnlTry} TL Kazandın (+${spotTransferTry} TL Spot Cüzdana Atıldı!)`;
  const textBody = [
    `⚡ YIRTICI KALDIRAÇ SİSTEMİ — CANLI KÂR & SPOT CÜZDAN BİLDİRİMİ (${ts})`,
    `==========================================================`,
    `🪙 Kazandıran Coin          : ${info.symbol} (${info.leverage}x ${info.side})`,
    `🏆 İşlem Türü               : ${info.type}`,
    `💵 Net İşlem Kazancı        : +${info.netPnlTry} TL (Kasa ROE: +%${info.roePct})`,
    `🏦 Spot Cüzdana Aktarılan   : +${spotTransferTry} TL (Toplam Spot Kâr Kasası: +${totalSpotVaultTry} TL)`,
    `📈 Fiyat Hareketi           : $${info.entryPrice} -> $${info.exitPrice}`,
    `⚡ Aktif Kaldıraç Kasası    : ${equityAfterTry} TL (Max 100.00 TL Sabit Ana Para Kuralı)`,
    `🧠 Strateji / Tez           : ${info.thesis || '-'}`,
    `==========================================================`,
    `📱 Canlı Panel: http://${getLocalLanIp()}:${DASHBOARD_PORT}`,
  ].join('\n');

  const channels = ['🏦 Spot Cüzdana Atıldı'];
  let emailSent = false;

  // 1A. Direct Zero-Password HTTPS Mail Relay (FormSubmit -> berkeakdemir5855@gmail.com)
  try {
    const fsRes = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(toEmail)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: `http://localhost:${DASHBOARD_PORT}`,
        Referer: `http://localhost:${DASHBOARD_PORT}/`,
      },
      body: JSON.stringify({
        _subject: subject,
        _template: 'table',
        _captcha: 'false',
        Tarih_Saat: ts,
        Kazandiran_Coin: `${info.symbol} (${info.leverage}x ${info.side})`,
        Islem_Turu: info.type,
        Net_Kazanc: `+${info.netPnlTry} TL (ROE +%${info.roePct})`,
        Spot_Cuzdana_Atilan: `+${spotTransferTry} TL (Toplam Spot Kâr Kasası: +${totalSpotVaultTry} TL)`,
        Fiyat_Hareketi: `$${info.entryPrice} -> $${info.exitPrice}`,
        Aktif_Kaldirac_Kasasi: `${equityAfterTry} TL (Max 100 TL Sabit Ana Para)`,
        Strateji_Tezi: info.thesis || '-',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const fsJson = await fsRes.json().catch(() => null);
    if (fsJson && (fsJson.success === true || fsJson.success === 'true')) {
      channels.unshift(`📧 Doğrudan Mail (${toEmail})`);
      emailSent = true;
    } else if (fsJson && String(fsJson.message || '').includes('Activation')) {
      channels.unshift(`📧 Mail Aktivasyon Bekliyor (${toEmail})`);
    }
  } catch {
    // ignore transient error
  }

  // 1B. Composio GMAIL_SEND_EMAIL API (if COMPOSIO_API_KEY is configured)
  if (!emailSent && composioKey) {
    try {
      const compRes = await fetch('https://backend.composio.dev/api/v2/actions/GMAIL_SEND_EMAIL/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': composioKey,
        },
        body: JSON.stringify({
          input: {
            recipient_email: toEmail,
            subject,
            body: textBody,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (compRes.ok) {
        channels.unshift(`📧 Composio Mail (${toEmail})`);
        emailSent = true;
      }
    } catch {
      // ignore transient error
    }
  }

  // 1C. Native TLS Gmail SMTP (if 16-digit Gmail App Password is set)
  if (!emailSent && appPass) {
    const emailOk = await sendGmailSmtp({
      fromEmail: toEmail,
      appPassword: appPass,
      toEmail,
      subject,
      textBody,
    });
    if (emailOk) {
      channels.unshift(`📧 SMTP Mail (${toEmail})`);
      emailSent = true;
    }
  }

  // 2. Send Instant WhatsApp Alert to +905301613459 via CallMeBot
  if (cfg.WHATSAPP_PHONE && cfg.CALLMEBOT_API_KEY) {
    let phone = cfg.WHATSAPP_PHONE.replace(/\s+/g, '');
    if (phone.startsWith('05')) phone = '+9' + phone;
    else if (phone.startsWith('5')) phone = '+90' + phone;
    const waText = `💰 [KÂR & SPOT TRANSFER] ${info.symbol} (${info.leverage}x ${info.side}) işleminden +${info.netPnlTry} TL (ROE +%${info.roePct}) kazandın! 🏦 +${spotTransferTry} TL Spot Cüzdana atıldı (Toplam Spot Kârı: +${totalSpotVaultTry} TL | Aktif Kaldıraç Kasası: ${equityAfterTry} TL)`;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(waText)}&apikey=${encodeURIComponent(cfg.CALLMEBOT_API_KEY)}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (r.ok) channels.unshift(`📲 WhatsApp (${phone})`);
    } catch {
      // ignore transient network timeout
    }
  }

  state.profitMails = state.profitMails || [];
  state.profitMails.unshift({
    time: ts,
    symbol: info.symbol,
    side: info.side,
    leverage: info.leverage,
    type: info.type,
    netPnlTry: info.netPnlTry,
    spotTransferTry,
    roePct: info.roePct,
    entryPrice: info.entryPrice,
    exitPrice: info.exitPrice,
    equityAfterTry,
    deliveryStatus: channels.join(' + '),
  });
  if (state.profitMails.length > 25) state.profitMails.length = 25;
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        return net.address;
      }
    }
  }
  return '192.168.1.101';
}

function loadEnv() {
  const cfg = {};
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) cfg[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return cfg;
}

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  let timer = null;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      resolve(null);
    }, timeoutMs);
  });
  const workPromise = (async () => {
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toTL(usdt) {
  return Number((Number(usdt || 0) * USD_TRY_RATE).toFixed(2));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof s.marginCashUsdt === 'number') return s;
    } catch {
      // ignore corrupt state
    }
  }
  return {
    version: '3x-Mutlak-Yapi-v7.0-15Layer-Apex',
    mode: 'SIM_LIVE_FAPI',
    leverage: LEVERAGE,
    initialBankrollTry: INITIAL_BANKROLL_TRY,
    initialBankrollUsdt: INITIAL_BANKROLL_USDT,
    marginCashUsdt: INITIAL_BANKROLL_USDT,
    totalEquityUsdt: INITIAL_BANKROLL_USDT,
    realizedPnlUsdt: 0,
    totalPnlUsdt: 0,
    totalPnlPct: 0,
    winCount: 0,
    lossCount: 0,
    openPosition: null,
    closedTrades: [],
    topCandidates: [],
    marketSummary: {
      btcPrice: 0,
      btcChange15mPct: 0,
      btcChange1hPct: 0,
      avgFundingRatePct: 0,
      minsToNextFunding: 0,
      regimeLabel: 'TARANIYOR',
      lastScanAt: null,
      statusNote: '12 Katmanlı Milyarderler Konseyi (v7.0) + Mobil Komuta Merkezi taranıyor...',
    },
    events: [],
  };
}

function loadSpotPortfolioSummary() {
  try {
    if (!fs.existsSync(SPOT_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SPOT_STATE_FILE, 'utf8'));
    return {
      totalEquityTry: toTL(raw.totalEquityUsdt || 0),
      cashTry: toTL(raw.cashUsdt || 0),
      totalPnlTry: toTL(raw.totalPnlUsdt || 0),
      totalPnlPct: Number(raw.totalPnlPct || 0),
      winCount: Number(raw.winCount || 0),
      lossCount: Number(raw.lossCount || 0),
      openPositions: (raw.openPositions || []).map(p => ({
        symbol: p.symbol,
        costTry: toTL(p.costUsdt),
        pnlTry: toTL(p.unrealizedPnlUsdt),
        pnlPct: p.unrealizedPnlPct,
        stopPrice: p.stopLossPrice,
        tpPrice: p.takeProfitPrice,
      })),
      noBuyShort: raw.noBuyShort || 'Piyasa taranıyor...',
    };
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function logEvent(state, msg) {
  const ts = new Date().toLocaleTimeString('tr-TR');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  state.events = state.events || [];
  state.events.unshift(line);
  if (state.events.length > 40) state.events.length = 40;
}

function computeRsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeEma(values, period) {
  if (!values || values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeAtrPct(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 1.2;
  let trSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const prevClose = Number(klines[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  const atr = trSum / period;
  const lastClose = Number(klines[klines.length - 1][4]) || 1;
  return Number(((atr / lastClose) * 100).toFixed(3));
}

function analyzeMtfAndVolatilitySqueeze(klines) {
  if (!Array.isArray(klines) || klines.length < 30) {
    return {
      mtfTrend: 'NÖTR',
      mtfBullishPts: 0,
      mtfBearishPts: 0,
      squeezeLabel: 'Normal Volatilite',
      squeezeBullishPts: 0,
      squeezeBearishPts: 0,
    };
  }
  const closes = klines.map(k => Number(k[4]));
  const lastClose = closes[closes.length - 1];

  const ema20 = computeEma(closes, 20);
  const ema50 = computeEma(closes, Math.min(50, closes.length));
  const mtfBullish = lastClose > ema20 && ema20 >= ema50 * 0.999;
  const mtfBearish = lastClose < ema20 && ema20 <= ema50 * 1.001;

  let mtfTrend = 'YATAY MTF';
  let mtfBullishPts = 0;
  let mtfBearishPts = 0;
  if (mtfBullish) {
    mtfTrend = 'MTF YÜKSELİŞ (EMA20>50)';
    mtfBullishPts = 5;
  } else if (mtfBearish) {
    mtfTrend = 'MTF DÜŞÜŞ (EMA20<50)';
    mtfBearishPts = 5;
  }

  const calcSliceStats = endIdx => {
    const win = klines.slice(Math.max(0, endIdx - 20), endIdx);
    const cWin = win.map(k => Number(k[4]));
    const mean = cWin.reduce((s, v) => s + v, 0) / (cWin.length || 1);
    const variance = cWin.reduce((s, v) => s + (v - mean) ** 2, 0) / (cWin.length || 1);
    const std = Math.sqrt(variance);
    let trSum = 0;
    for (let i = 1; i < win.length; i++) {
      const h = Number(win[i][2]);
      const l = Number(win[i][3]);
      const pc = Number(win[i - 1][4]);
      trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    const atr = trSum / Math.max(1, win.length - 1);
    const bbHalfWidth = 2.0 * std;
    const kcHalfWidth = 1.5 * atr;
    const isCoiled = bbHalfWidth <= kcHalfWidth;
    const bbWidthPct = mean > 0 ? ((2 * bbHalfWidth) / mean) * 100 : 2.0;
    return { mean, std, atr, isCoiled, bbWidthPct };
  };

  const curStats = calcSliceStats(klines.length);
  const prevStats = calcSliceStats(klines.length - 1);
  const prev2Stats = calcSliceStats(klines.length - 2);

  const wasRecentlyCoiled = prevStats.isCoiled || prev2Stats.isCoiled || prevStats.bbWidthPct <= 1.85;
  const isExpandingUp = wasRecentlyCoiled && lastClose > curStats.mean + 1.15 * curStats.std;
  const isExpandingDown = wasRecentlyCoiled && lastClose < curStats.mean - 1.15 * curStats.std;

  let squeezeLabel = curStats.isCoiled ? 'Yay Sıkışması (TTM Coil)' : 'Normal';
  let squeezeBullishPts = 0;
  let squeezeBearishPts = 0;
  if (isExpandingUp) {
    squeezeLabel = '💥 TTM Sıkışma Patlaması (YUKARI)';
    squeezeBullishPts = 6;
  } else if (isExpandingDown) {
    squeezeLabel = '💥 TTM Sıkışma Patlaması (AŞAĞI)';
    squeezeBearishPts = 6;
  }

  return {
    mtfTrend,
    mtfBullishPts,
    mtfBearishPts,
    squeezeLabel,
    squeezeBullishPts,
    squeezeBearishPts,
  };
}

function analyzeCandleSmcAndCvd15m(klines) {
  if (!Array.isArray(klines) || klines.length < 18) {
    return {
      bullishPattern: null,
      bearishPattern: null,
      patternLabel: 'NÖTR MUM',
      bullishCandlePts: 0,
      bearishCandlePts: 0,
      sellSideSweep: false,
      buySideSweep: false,
      smcLabel: 'YOK',
      bullishSmcPts: 0,
      bearishSmcPts: 0,
      cvdLabel: 'NÖTR CVD',
      normCvd3BarPct: 0,
      bullishCvdPts: 0,
      bearishCvdPts: 0,
      vetoLong: false,
      vetoShort: false,
      clv: 0.5,
      structuralLow: 0,
      structuralHigh: 0,
    };
  }

  const parseBar = raw => {
    const open = Number(raw[1]);
    const high = Number(raw[2]);
    const low = Number(raw[3]);
    const close = Number(raw[4]);
    const vol = Number(raw[5]);
    const takerBuyVol = Number(raw[9] || vol * 0.5);
    const delta = 2 * takerBuyVol - vol;
    const deltaPct = vol > 0 ? Number(((delta / vol) * 100).toFixed(1)) : 0;
    const range = Math.max(1e-9, high - low);
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const clv = Number(((close - low) / range).toFixed(2));
    const bodyRatio = Number((body / range).toFixed(2));
    const upperWickRatio = Number((upperWick / range).toFixed(2));
    const lowerWickRatio = Number((lowerWick / range).toFixed(2));
    const isGreen = close >= open;
    return {
      open, high, low, close, vol, takerBuyVol, delta, deltaPct,
      range, body, upperWick, lowerWick, clv, bodyRatio, upperWickRatio, lowerWickRatio, isGreen,
    };
  };

  const bars = klines.map(parseBar);
  const n = bars.length;
  const b0 = bars[n - 1];
  const b1 = bars[n - 2];
  const b2 = bars[n - 3];
  const b3 = bars[n - 4];

  // Wall #1: Unclosed Baby Candle Protection (b0 < 25% of completed 3-bar average volume)
  const avgCompletedVol = (b1.vol + b2.vol + b3.vol) / 3 || 1;
  const isBabyB0 = b0.vol < avgCompletedVol * 0.25;
  const effectiveClv = isBabyB0 ? b1.clv : b0.clv;

  const isHammerB1 =
    b1.lowerWickRatio >= 0.45 &&
    b1.lowerWick >= b1.body * 1.8 &&
    b1.upperWickRatio <= 0.22 &&
    b1.clv >= 0.65 &&
    b1.low <= Math.min(b2.low, b3.low);

  const isHammerB0 =
    !isBabyB0 &&
    b0.lowerWickRatio >= 0.48 &&
    b0.lowerWick >= b0.body * 1.9 &&
    b0.upperWickRatio <= 0.20 &&
    b0.clv >= 0.68 &&
    b0.low <= Math.min(b1.low, b2.low);

  const isBullishEngulfing =
    !b2.isGreen &&
    b1.isGreen &&
    b1.body >= b2.body * 1.08 &&
    b1.close >= b2.open &&
    b1.open <= b2.close * 1.001 &&
    b1.clv >= 0.68 &&
    b1.vol >= b2.vol * 0.95;

  const isMorningStar =
    !b3.isGreen &&
    b3.bodyRatio >= 0.50 &&
    b2.bodyRatio <= 0.38 &&
    b1.isGreen &&
    b1.bodyRatio >= 0.50 &&
    b1.close >= (b3.open + b3.close) / 2 &&
    b1.clv >= 0.68;

  const isBullishMarubozu =
    (b1.isGreen && b1.bodyRatio >= 0.72 && b1.upperWickRatio <= 0.15 && b1.clv >= 0.80) ||
    (!isBabyB0 && b0.isGreen && b0.bodyRatio >= 0.74 && b0.upperWickRatio <= 0.14 && b0.clv >= 0.82);

  const isThreeHigherLows = isBabyB0
    ? b1.low > b2.low && b2.low > b3.low && b1.isGreen && b2.isGreen && b1.clv >= 0.60
    : b0.low > b1.low && b1.low > b2.low && b0.isGreen && b1.isGreen && b0.clv >= 0.60;

  const isShootingStarB1 =
    b1.upperWickRatio >= 0.45 &&
    b1.upperWick >= b1.body * 1.8 &&
    b1.lowerWickRatio <= 0.22 &&
    b1.clv <= 0.35 &&
    b1.high >= Math.max(b2.high, b3.high);

  const isShootingStarB0 =
    !isBabyB0 &&
    b0.upperWickRatio >= 0.48 &&
    b0.upperWick >= b0.body * 1.9 &&
    b0.lowerWickRatio <= 0.20 &&
    b0.clv <= 0.32 &&
    b0.high >= Math.max(b1.high, b2.high);

  const isBearishEngulfing =
    b2.isGreen &&
    !b1.isGreen &&
    b1.body >= b2.body * 1.08 &&
    b1.close <= b2.open &&
    b1.open >= b2.close * 0.999 &&
    b1.clv <= 0.32 &&
    b1.vol >= b2.vol * 0.95;

  const isEveningStar =
    b3.isGreen &&
    b3.bodyRatio >= 0.50 &&
    b2.bodyRatio <= 0.38 &&
    !b1.isGreen &&
    b1.bodyRatio >= 0.50 &&
    b1.close <= (b3.open + b3.close) / 2 &&
    b1.clv <= 0.32;

  const isBearishMarubozu =
    (!b1.isGreen && b1.bodyRatio >= 0.72 && b1.lowerWickRatio <= 0.15 && b1.clv <= 0.20) ||
    (!isBabyB0 && !b0.isGreen && b0.bodyRatio >= 0.74 && b0.lowerWickRatio <= 0.14 && b0.clv <= 0.18);

  const isThreeLowerHighs = isBabyB0
    ? b1.high < b2.high && b2.high < b3.high && !b1.isGreen && !b2.isGreen && b1.clv <= 0.40
    : b0.high < b1.high && b1.high < b2.high && !b0.isGreen && !b1.isGreen && b0.clv <= 0.40;

  let bullishPattern = null;
  let bullishCandlePts = 0;
  if (isBullishEngulfing && effectiveClv >= 0.45) {
    bullishPattern = 'Boğa Yutan (Engulfing)';
    bullishCandlePts = 10;
  } else if ((isHammerB1 && effectiveClv >= 0.45) || isHammerB0) {
    bullishPattern = 'Likidite Çekici (Hammer)';
    bullishCandlePts = 10;
  } else if (isMorningStar && effectiveClv >= 0.45) {
    bullishPattern = 'Sabah Yıldızı (Morning Star)';
    bullishCandlePts = 9;
  } else if (isBullishMarubozu) {
    bullishPattern = 'Boğa Marubozu';
    bullishCandlePts = 8;
  } else if (isThreeHigherLows) {
    bullishPattern = '3 Yükselen Dip';
    bullishCandlePts = 6;
  } else if (!isBabyB0 && b0.isGreen && b0.clv >= 0.68) {
    bullishCandlePts = 4;
  }

  let bearishPattern = null;
  let bearishCandlePts = 0;
  if (isBearishEngulfing && effectiveClv <= 0.55) {
    bearishPattern = 'Ayı Yutan (Bearish Engulfing)';
    bearishCandlePts = 10;
  } else if ((isShootingStarB1 && effectiveClv <= 0.55) || isShootingStarB0) {
    bearishPattern = 'Kayan Yıldız (Shooting Star)';
    bearishCandlePts = 10;
  } else if (isEveningStar && effectiveClv <= 0.55) {
    bearishPattern = 'Akşam Yıldızı (Evening Star)';
    bearishCandlePts = 9;
  } else if (isBearishMarubozu) {
    bearishPattern = 'Ayı Marubozu';
    bearishCandlePts = 8;
  } else if (isThreeLowerHighs) {
    bearishPattern = '3 Alçalan Tepe';
    bearishCandlePts = 6;
  } else if (!isBabyB0 && !b0.isGreen && b0.clv <= 0.32) {
    bearishCandlePts = 4;
  }

  const priorWindow = bars.slice(Math.max(0, n - 18), n - 2);
  const swingLow16 = Math.min(...priorWindow.map(b => b.low));
  const swingHigh16 = Math.max(...priorWindow.map(b => b.high));
  const window16 = bars.slice(-16);
  const fullLow16 = Math.min(...window16.map(b => b.low));
  const fullHigh16 = Math.max(...window16.map(b => b.high));
  const posIn16BarRange = fullHigh16 > fullLow16 ? Number(((b0.close - fullLow16) / (fullHigh16 - fullLow16)).toFixed(2)) : 0.5;

  // Wall #2 & #3: Post-Mortem ATOM Anti-Fishing Detector
  // A) Volume & Taker Flow Deceleration on Bounce (Price creeps higher on >=25% falling volume after upper-wick rejection or falling delta)
  const hasPriorUpperWickTrap = b2.upperWickRatio >= 0.42 || b1.upperWickRatio >= 0.42;
  const isVolTakerDecayLong =
    b1.close > b2.close &&
    ((hasPriorUpperWickTrap && b1.vol < b2.vol * 0.78 && b1.deltaPct < b2.deltaPct - 8) ||
      (b1.vol < b2.vol * 0.68 && b1.deltaPct < b2.deltaPct - 14) ||
      (!isBabyB0 && b0.close >= b1.close && b0.deltaPct <= -12));

  // B) Dead-Cat Bounce into Heavy 4h Dump Supply Zone (ATOM 16:00 UTC dump pattern)
  let maxBearDumpVol = 0;
  let bearDumpOriginHigh = 0;
  for (let i = Math.max(0, n - 12); i < n - 2; i++) {
    const dBar = bars[i];
    if (!dBar.isGreen && dBar.vol >= avgCompletedVol * 1.15 && (dBar.open - dBar.close) / dBar.open >= 0.0035) {
      if (dBar.vol > maxBearDumpVol) {
        maxBearDumpVol = dBar.vol;
        bearDumpOriginHigh = dBar.high;
      }
    }
  }
  const isDeadCatBounceIntoSupply =
    maxBearDumpVol > 0 &&
    b0.close < bearDumpOriginHigh &&
    posIn16BarRange >= 0.42 &&
    posIn16BarRange <= 0.86 &&
    b1.vol < maxBearDumpVol * 0.76 &&
    b1.vol < b2.vol * 0.85;

  const isFishingTrapLong = Boolean(isVolTakerDecayLong || isDeadCatBounceIntoSupply);

  const sellSideSweep =
    (b1.low < swingLow16 && b1.close > swingLow16 && b0.close > swingLow16) ||
    (!isBabyB0 && b0.low < swingLow16 && b0.close > swingLow16 && b0.clv >= 0.55);

  const buySideSweep =
    (b1.high > swingHigh16 && b1.close < swingHigh16 && b0.close < swingHigh16) ||
    (!isBabyB0 && b0.high > swingHigh16 && b0.close < swingHigh16 && b0.clv <= 0.45);

  const hasBullishFvg =
    (b1.low > b3.high && b0.close >= b3.high) ||
    (b0.low > b2.high && b1.isGreen && b1.bodyRatio >= 0.55);

  const hasBearishFvg =
    (b1.high < b3.low && b0.close <= b3.low) ||
    (b0.high < b2.low && !b1.isGreen && b1.bodyRatio >= 0.55);

  let bullishSmcPts = 0;
  let bearishSmcPts = 0;
  const smcTags = [];
  if (sellSideSweep) {
    bullishSmcPts += 9;
    smcTags.push('Dip Likidite Avı (SSL Sweep)');
  }
  if (hasBullishFvg) {
    bullishSmcPts += 6;
    smcTags.push('Boğa FVG Boşluğu');
  }
  if (buySideSweep) {
    bearishSmcPts += 9;
    smcTags.push('Tepe Likidite Avı (BSL Sweep)');
  }
  if (hasBearishFvg) {
    bearishSmcPts += 6;
    smcTags.push('Ayı FVG Boşluğu');
  }
  bullishSmcPts = Math.min(12, bullishSmcPts);
  bearishSmcPts = Math.min(12, bearishSmcPts);

  const cvd3BarSum = b0.delta + b1.delta + b2.delta;
  const vol3BarSum = Math.max(1e-9, b0.vol + b1.vol + b2.vol);
  const normCvd3BarPct = Number(((cvd3BarSum / vol3BarSum) * 100).toFixed(1));

  // True Dip-Only Bullish CVD Absorption (Never award dip-absorption points at the top of a pump!)
  const isBullishCvdAbsorption =
    posIn16BarRange <= 0.52 &&
    !isFishingTrapLong &&
    (normCvd3BarPct >= 0 || b0.deltaPct >= 12) &&
    ((b1.low <= b2.low * 1.001 && b1.lowerWickRatio >= 0.28 && b1.deltaPct > b2.deltaPct + 6 && b1.deltaPct >= 8) ||
      (!isBabyB0 && b0.low <= b1.low * 1.001 && b0.lowerWickRatio >= 0.30 && b0.deltaPct >= 10 && b0.clv >= 0.55));

  const isBearishCvdExhaustion =
    posIn16BarRange >= 0.48 &&
    (normCvd3BarPct <= 0 || b0.deltaPct <= -12) &&
    ((b1.high >= b2.high * 0.999 && b1.upperWickRatio >= 0.28 && b1.deltaPct < b2.deltaPct - 6 && b1.deltaPct <= -8) ||
      (!isBabyB0 && b0.high >= b1.high * 0.999 && b0.upperWickRatio >= 0.30 && b0.deltaPct <= -10 && b0.clv <= 0.45));

  let bullishCvdPts = 0;
  let bearishCvdPts = 0;
  let cvdLabel = `CVD ${normCvd3BarPct >= 0 ? '+' : ''}${normCvd3BarPct}%`;

  if (isBullishCvdAbsorption) {
    bullishCvdPts = 14;
    cvdLabel = `🟢 Dip Alıcı Emilimi (CVD Div +${Math.max(0, normCvd3BarPct)}%)`;
  } else if (normCvd3BarPct >= 12 && !isFishingTrapLong) {
    bullishCvdPts = 11;
    cvdLabel = `🟢 Güçlü Taker Alım (CVD +${normCvd3BarPct}%)`;
  } else if (normCvd3BarPct >= 5 && !isFishingTrapLong) {
    bullishCvdPts = 6;
  }

  if (isBearishCvdExhaustion) {
    bearishCvdPts = 14;
    cvdLabel = `🔴 Tepe Alıcı Tükenmesi (CVD Div ${normCvd3BarPct}%)`;
  } else if (normCvd3BarPct <= -12) {
    bearishCvdPts = 11;
    cvdLabel = `🔴 Güçlü Taker Satış (CVD ${normCvd3BarPct}%)`;
  } else if (normCvd3BarPct <= -5) {
    bearishCvdPts = 6;
  }

  const vetoLong = Boolean(
    bearishPattern ||
      buySideSweep ||
      isFishingTrapLong ||
      b0.upperWickRatio >= 0.48 ||
      (b1.upperWickRatio >= 0.48 && b1.clv <= 0.42 && effectiveClv < 0.65) ||
      (!isBabyB0 && !b0.isGreen && b0.clv <= 0.30)
  );

  const vetoShort = Boolean(
    bullishPattern ||
      sellSideSweep ||
      (!isBabyB0 && b0.lowerWickRatio >= 0.48) ||
      (b1.lowerWickRatio >= 0.50 && b1.clv >= 0.62 && effectiveClv > 0.35) ||
      (!isBabyB0 && b0.isGreen && b0.clv >= 0.70)
  );

  const patternLabel = isFishingTrapLong
    ? `🎣 Yemleme/Fishing Tuzağı (Hacim↓/Direnç — LONG Veto)`
    : bullishPattern
      ? `🟢 ${bullishPattern} (CLV:${effectiveClv})`
      : bearishPattern
        ? `🔴 ${bearishPattern} (CLV:${effectiveClv})`
        : vetoLong
          ? `⚠️ Üst İğne Reddi (CLV:${effectiveClv} — LONG Veto)`
          : vetoShort
            ? `⚠️ Alt İğne Tepkisi (CLV:${effectiveClv} — SHORT Veto)`
            : `⚪ Dengeli Mum (CLV:${effectiveClv})`;

  const low4Bar = Math.min(b0.low, b1.low, b2.low, b3.low);
  const high4Bar = Math.max(b0.high, b1.high, b2.high, b3.high);
  const posIn4BarRange = high4Bar > low4Bar ? Number(((b0.close - low4Bar) / (high4Bar - low4Bar)).toFixed(2)) : 0.5;
  const runup4BarPct = low4Bar > 0 ? Number((((b0.close - low4Bar) / low4Bar) * 100).toFixed(2)) : 0;
  const green3Completed = b1.isGreen && b2.isGreen && b3.isGreen;

  return {
    bullishPattern,
    bearishPattern,
    patternLabel,
    bullishCandlePts,
    bearishCandlePts,
    sellSideSweep,
    buySideSweep,
    hasBullishFvg,
    hasBearishFvg,
    smcLabel: smcTags.length ? smcTags.join(' + ') : 'Normal Yapı',
    bullishSmcPts,
    bearishSmcPts,
    normCvd3BarPct,
    cvdLabel,
    bullishCvdPts,
    bearishCvdPts,
    vetoLong,
    vetoShort,
    isFishingTrapLong,
    posIn4BarRange,
    runup4BarPct,
    green3Completed,
    clv: effectiveClv,
    structuralLow: Math.min(b0.low, b1.low),
    structuralHigh: Math.max(b0.high, b1.high),
  };
}

function computeWeightedBookImbalance(bids, asks) {
  if (!bids?.length || !asks?.length) return 0;
  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0) return 0;
  let wBid = 0;
  let wAsk = 0;
  for (const [pStr, qStr] of bids.slice(0, 15)) {
    const p = Number(pStr);
    const q = Number(qStr);
    const distBps = ((mid - p) / mid) * 10000;
    if (distBps <= 25) wBid += Math.exp(-distBps / 6) * p * q;
  }
  for (const [pStr, qStr] of asks.slice(0, 15)) {
    const p = Number(pStr);
    const q = Number(qStr);
    const distBps = ((p - mid) / mid) * 10000;
    if (distBps <= 25) wAsk += Math.exp(-distBps / 6) * p * q;
  }
  if (wBid + wAsk <= 0) return 0;
  return Number(((wBid - wAsk) / (wBid + wAsk)).toFixed(3));
}

async function fetchPerpOrderbookConfirm(symbol, side) {
  // Engine #38 (GPT-6-Luna Two-Snapshot Perp Microprice & Spoof-Decay Gate — 1.8s Interval):
  const d1 = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}USDT&limit=20`, {}, 2500);
  if (!d1?.bids?.length || !d1?.asks?.length) return { ok: false, reason: 'NO_DEPTH_1' };
  await new Promise(r => setTimeout(r, 1800));
  const d2 = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}USDT&limit=20`, {}, 2500);
  if (!d2?.bids?.length || !d2?.asks?.length) return { ok: false, reason: 'NO_DEPTH_2' };

  const seq1 = Number(d1.lastUpdateId || 0);
  const seq2 = Number(d2.lastUpdateId || 0);
  if (seq1 > 0 && seq2 > 0 && seq2 < seq1) {
    return { ok: false, reason: `STALE_BOOK_SEQUENCE (${seq1}->${seq2})` };
  }

  const bestBid1 = Number(d1.bids[0][0]);
  const bestAsk1 = Number(d1.asks[0][0]);
  const bidVol1 = Number(d1.bids[0][1] || 0);
  const askVol1 = Number(d1.asks[0][1] || 0);
  const midPrice1 = (bestBid1 + bestAsk1) / 2;
  const microPrice1 =
    bidVol1 + askVol1 > 0
      ? (bestBid1 * askVol1 + bestAsk1 * bidVol1) / (bidVol1 + askVol1)
      : midPrice1;
  const halfSpread1 = (bestAsk1 - bestBid1) / 2;
  const microSkew1 =
    halfSpread1 > 0
      ? Number(((microPrice1 - midPrice1) / halfSpread1).toFixed(3))
      : 0;

  const bestBid = Number(d2.bids[0][0]);
  const bestAsk = Number(d2.asks[0][0]);
  const bidVol0 = Number(d2.bids[0][1] || 0);
  const askVol0 = Number(d2.asks[0][1] || 0);
  const midPrice = (bestBid + bestAsk) / 2;
  const microPrice =
    bidVol0 + askVol0 > 0
      ? (bestBid * askVol0 + bestAsk * bidVol0) / (bidVol0 + askVol0)
      : midPrice;
  const halfSpread2 = (bestAsk - bestBid) / 2;
  const microSkew =
    halfSpread2 > 0
      ? Number(((microPrice - midPrice) / halfSpread2).toFixed(3))
      : 0;
  const spreadPct = bestBid > 0 ? Number((((bestAsk - bestBid) / bestBid) * 100).toFixed(4)) : 99;
  const ob1 = computeWeightedBookImbalance(d1.bids, d1.asks);
  const ob2 = computeWeightedBookImbalance(d2.bids, d2.asks);
  const avgOb = Number(((ob1 + ob2) / 2).toFixed(3));
  const obDelta = Number((ob2 - ob1).toFixed(3));
  const bookHollowing = bestBid < bestBid1 && bestAsk > bestAsk1;

  if (spreadPct > 0.18) {
    return { ok: false, reason: `WIDE_SPREAD (${spreadPct}%)`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
  }
  if (bookHollowing) {
    return { ok: false, reason: `BOOK_HOLLOWING (bid ${bestBid1}->${bestBid} | ask ${bestAsk1}->${bestAsk})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
  }
  if (side === 'LONG') {
    if (obDelta < -0.10) {
      return { ok: false, reason: `SPOOF_WALL_DECAY_LONG (ob:${ob1}->${ob2} | dI:${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    if (avgOb < 0.05 || ob2 < 0.02 || microSkew < -0.16 || (microSkew1 < -0.20 && microSkew < 0)) {
      return { ok: false, reason: `WEAK_LONG_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  if (side === 'SHORT') {
    if (obDelta > 0.10) {
      return { ok: false, reason: `SPOOF_WALL_DECAY_SHORT (ob:${ob1}->${ob2} | dI:+${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    if (avgOb > -0.05 || ob2 > -0.02 || microSkew > 0.16 || (microSkew1 > 0.20 && microSkew > 0)) {
      return { ok: false, reason: `WEAK_SHORT_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  return { ok: true, bestBid, bestAsk, spreadPct, avgOb, ob1, ob2, obDelta, microSkew1, microSkew };
}

function readSharedNewsSignals() {
  try {
    if (!fs.existsSync(NEWS_SIGNALS_FILE)) return { candidates: [] };
    const raw = JSON.parse(fs.readFileSync(NEWS_SIGNALS_FILE, 'utf8'));
    const list = raw?.allQualifiedOpportunities || raw?.top4AltcoinPicks || raw?.candidates || [];
    return { candidates: list, marketBreadthPct: raw?.marketBreadthPct, isConfirmedGoldenAge: raw?.isConfirmedGoldenAge };
  } catch {
    return { candidates: [] };
  }
}

async function scanPerpUniverse(state) {
  const [validMap, premiumList, tickerList, btcKlines15m] = await Promise.all([
    getValidCoinPerpMap(),
    fetchJson(`${FAPI_BASE}/fapi/v1/premiumIndex`, {}, 5000),
    fetchJson(`${FAPI_BASE}/fapi/v1/ticker/24hr`, {}, 5000),
    fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=10`, {}, 4000),
  ]);
  if (!Array.isArray(premiumList) || !Array.isArray(tickerList)) {
    return [];
  }

  const premMap = new Map();
  for (const p of premiumList) premMap.set(p.symbol, p);
  const tickMap = new Map();
  for (const t of tickerList) tickMap.set(t.symbol, t);

  const btcPrem = premMap.get('BTCUSDT');
  const btcTick = tickMap.get('BTCUSDT');
  const btcMark = Number(btcPrem?.markPrice || btcTick?.lastPrice || 0);
  const minsToNextFunding = btcPrem?.nextFundingTime
    ? Math.max(0, Math.round((Number(btcPrem.nextFundingTime) - Date.now()) / 60000))
    : 240;

  let btc15mChangePct = 0;
  let btc1hChangePct = 0;
  if (Array.isArray(btcKlines15m) && btcKlines15m.length >= 6) {
    const bLast = Number(btcKlines15m[btcKlines15m.length - 1][4]);
    const bPrev15m = Number(btcKlines15m[btcKlines15m.length - 2][4]);
    const bPrev1h = Number(btcKlines15m[btcKlines15m.length - 5][4]);
    if (bPrev15m > 0) btc15mChangePct = Number((((bLast - bPrev15m) / bPrev15m) * 100).toFixed(2));
    if (bPrev1h > 0) btc1hChangePct = Number((((bLast - bPrev1h) / bPrev1h) * 100).toFixed(2));
  }

  const btcVetoLong = btc15mChangePct <= -0.45 || btc1hChangePct <= -1.10;
  const btcVetoShort = btc15mChangePct >= 0.45 || btc1hChangePct >= 1.10;

  const sharedNews = readSharedNewsSignals();
  const newsMap = new Map();
  for (const c of sharedNews.candidates || []) {
    newsMap.set(c.symbol, c);
  }

  const preCandidates = [];
  let fundingSum = 0;
  let fundingCnt = 0;

  // Engine v8.0: Dynamic All-Market High-Velocity Universe (100+ Liquid COIN Perpetuals >= $15M Vol & >= 3.2% 24h Range)
  const fSymsToScan = new Set();
  if (validMap && validMap.size > 0) {
    for (const fSym of validMap.keys()) fSymsToScan.add(fSym);
  } else {
    for (const sym of PERP_UNIVERSE) fSymsToScan.add(`${sym}USDT`);
  }
  if (state.openPosition?.fSym) fSymsToScan.add(state.openPosition.fSym);

  for (const fSym of fSymsToScan) {
    const sym = fSym.replace(/USDT$/, '');
    const prem = premMap.get(fSym);
    const tick = tickMap.get(fSym);
    if (!prem || !tick) continue;

    const isCurrentlyOpen = state.openPosition?.symbol === sym;
    const quoteVol24h = Number(tick.quoteVolume || 0);
    const high24h = Number(tick.highPrice || 0);
    const low24h = Number(tick.lowPrice || 0);
    const range24hPct = low24h > 0 ? Number((((high24h - low24h) / low24h) * 100).toFixed(2)) : 0;

    // Require >= $15M 24h volume and >= 3.2% 24h range (banishes dead stable-like sleepers like TRX unless already open)
    if (!isCurrentlyOpen && (quoteVol24h < 15e6 || range24hPct < 3.2)) continue;

    const fundingRatePct = Number((Number(prem.lastFundingRate || 0) * 100).toFixed(4));
    const contractNextFundingMs = Number(prem.nextFundingTime || 0);
    const contractMinsToFunding =
      contractNextFundingMs > Date.now()
        ? Math.max(0, Math.round((contractNextFundingMs - Date.now()) / 60000))
        : minsToNextFunding;
    const markPrice = Number(prem.markPrice || tick.lastPrice || 0);
    const indexPrice = Number(prem.indexPrice || markPrice);
    const basisPct = indexPrice > 0 ? Number((((markPrice - indexPrice) / indexPrice) * 100).toFixed(4)) : 0;
    const change24hPct = Number(tick.priceChangePercent || 0);
    const newsCand = newsMap.get(sym) || newsMap.get(sym.replace(/^1000/, ''));

    fundingSum += fundingRatePct;
    fundingCnt++;

    // High-Velocity Predator Priority Score (Combines 24h Momentum + Range Expansion + Squeeze Dislocation + Liquidity)
    const priorityScore =
      (isCurrentlyOpen ? 9999 : 0) +
      Math.min(35, Math.abs(change24hPct)) * 2.4 +
      Math.min(45, range24hPct) * 1.5 +
      Math.min(0.35, Math.abs(fundingRatePct)) * 120 +
      Math.min(0.60, Math.abs(basisPct)) * 55 +
      Math.log10(Math.max(15, quoteVol24h / 1e6)) * 9 +
      (newsCand?.hasDirectMention ? 35 : newsCand ? 15 : 0);

    preCandidates.push({
      symbol: sym,
      fSym,
      markPrice,
      indexPrice,
      fundingRatePct,
      minsToFunding: contractMinsToFunding,
      basisPct,
      quoteVol24h,
      change24hPct,
      range24hPct,
      newsCand,
      priorityScore,
    });
  }

  preCandidates.sort((a, b) => b.priorityScore - a.priorityScore);
  const topToInspect = preCandidates.slice(0, 20);

  const evaluated = [];
  for (const item of topToInspect) {
    // Engine #35: Fetch 5 orthogonal institutional streams including `/futures/data/takerlongshortRatio`
    const [klines15m, oiHist, topPosRatio, globalAccRatio, instTakerRatio] = await Promise.all([
      fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=${item.fSym}&interval=15m&limit=64`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${item.fSym}&period=15m&limit=5`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
    ]);
    if (!Array.isArray(klines15m) || klines15m.length < 30) continue;

    const closes = klines15m.map(k => Number(k[4]));
    const lastPrice = closes[closes.length - 1];
    const price1hAgo = closes[Math.max(0, closes.length - 5)];
    const change1hPct = price1hAgo > 0 ? Number((((lastPrice - price1hAgo) / price1hAgo) * 100).toFixed(2)) : 0;
    const rsi15m = computeRsi(closes, 14);
    const atr15mPct = computeAtrPct(klines15m, 14);
    const anatomy = analyzeCandleSmcAndCvd15m(klines15m);
    const mtfSqueeze = analyzeMtfAndVolatilitySqueeze(klines15m);

    // Engine #35.1 + Wall #3: Institutional Perp Taker Buy/Sell Volume Ratio & Deceleration Guard
    let instBuySellRatio = 1.0;
    let prevInstBuySellRatio = 1.0;
    if (Array.isArray(instTakerRatio) && instTakerRatio.length > 0) {
      instBuySellRatio = Number(Number(instTakerRatio[instTakerRatio.length - 1]?.buySellRatio || 1.0).toFixed(2));
      prevInstBuySellRatio = Number(Number(instTakerRatio[0]?.buySellRatio || instBuySellRatio).toFixed(2));
    }
    const isTakerRatioCrashingLong =
      instBuySellRatio < 0.92 ||
      (prevInstBuySellRatio >= 1.50 && instBuySellRatio < prevInstBuySellRatio * 0.62);
    const isTakerRatioCrashingShort =
      instBuySellRatio > 1.08 ||
      (prevInstBuySellRatio <= 0.70 && instBuySellRatio > prevInstBuySellRatio * 1.45);
    let instTakerLongPts = 0;
    let instTakerShortPts = 0;
    if (instBuySellRatio >= 1.14 && !isTakerRatioCrashingLong) {
      instTakerLongPts = Math.min(8, Math.round((instBuySellRatio - 1.0) * 20));
    } else if (instBuySellRatio <= 0.88 && !isTakerRatioCrashingShort) {
      instTakerShortPts = Math.min(8, Math.round((1.0 - instBuySellRatio) * 20));
    }

    const rsVsBtcAtr = Number(((change1hPct - btc1hChangePct) / Math.max(0.40, atr15mPct)).toFixed(2));
    let bullishRsPts = 0;
    let bearishRsPts = 0;
    if (rsVsBtcAtr >= 0.70) {
      bullishRsPts = Math.min(8, Math.round(rsVsBtcAtr * 4));
    } else if (rsVsBtcAtr <= -0.70) {
      bearishRsPts = Math.min(8, Math.round(Math.abs(rsVsBtcAtr) * 4));
    }

    let pvSum = 0;
    let vSum = 0;
    for (const k of klines15m.slice(-16)) {
      const typ = (Number(k[2]) + Number(k[3]) + Number(k[4])) / 3;
      const v = Number(k[5]);
      pvSum += typ * v;
      vSum += v;
    }
    const vwap4h = vSum > 0 ? pvSum / vSum : lastPrice;
    const vwapDistPct = vwap4h > 0 ? Number((((lastPrice - vwap4h) / vwap4h) * 100).toFixed(3)) : 0;

    let bullishBasisPts = 0;
    let bearishBasisPts = 0;
    let basisLabel = `Basis ${item.basisPct >= 0 ? '+' : ''}%${item.basisPct}`;
    // Wall #6A: Only award Spot-Discount LONG points if price is not in a freefall below 4h VWAP
    if (item.basisPct <= -0.030 && (lastPrice >= vwap4h * 0.996 || change1hPct > 0)) {
      bullishBasisPts = Math.min(8, Math.round(Math.abs(item.basisPct) * 110));
      basisLabel = `🟢 LightCrypto Spot İskontosu (${item.basisPct}%)`;
    } else if (item.basisPct >= 0.045) {
      bearishBasisPts = Math.min(8, Math.round(item.basisPct * 100));
      basisLabel = `🔴 GCR Vadeli Köpüğü (+${item.basisPct}%)`;
    }

    let fundingCountdownBonusLong = 0;
    let fundingCountdownBonusShort = 0;
    const itemMinsToFunding = Number.isFinite(item.minsToFunding) ? item.minsToFunding : minsToNextFunding;
    if (itemMinsToFunding > 15 && itemMinsToFunding <= 45) {
      if (item.fundingRatePct <= -0.015 && (lastPrice >= vwap4h * 0.996 || change1hPct > 0)) {
        fundingCountdownBonusLong = 5;
      } else if (item.fundingRatePct >= 0.020) {
        fundingCountdownBonusShort = 5;
      }
    }

    const recent2 = klines15m.slice(-2);
    const totVol2 = recent2.reduce((s, k) => s + Number(k[5]), 0);
    const takerBuyVol2 = recent2.reduce((s, k) => s + Number(k[9]), 0);
    const takerBuyPct = totVol2 > 0 ? Number(((takerBuyVol2 / totVol2) * 100).toFixed(1)) : 50;

    const prev12VolAvg =
      klines15m.slice(-14, -2).reduce((s, k) => s + Number(k[5]), 0) / 12 || 1;
    const curBarVol = Math.max(Number(klines15m[klines15m.length - 1][5]), Number(klines15m[klines15m.length - 2][5]));
    const volRatio15m = Number((curBarVol / prev12VolAvg).toFixed(2));

    let oiDelta1hPct = 0;
    if (Array.isArray(oiHist) && oiHist.length >= 2) {
      const firstOi = Number(oiHist[0]?.sumOpenInterestValue || oiHist[0]?.sumOpenInterest || 0);
      const lastOi = Number(oiHist[oiHist.length - 1]?.sumOpenInterestValue || oiHist[oiHist.length - 1]?.sumOpenInterest || 0);
      if (firstOi > 0) {
        oiDelta1hPct = Number((((lastOi - firstOi) / firstOi) * 100).toFixed(2));
      }
    }

    const isBnfLiquidationBounce = Boolean(
      change1hPct <= -2.8 &&
        oiDelta1hPct <= -1.0 &&
        rsi15m <= 29 &&
        (anatomy.bullishPattern || anatomy.sellSideSweep) &&
        anatomy.normCvd3BarPct >= 0
    );

    let oiQuadrant = 'NÖTR';
    let bullishOiPts = 0;
    let bearishOiPts = 0;
    if (isBnfLiquidationBounce) {
      oiQuadrant = 'Q4-BNF (Long Tasfiye Dibi + Çekiç Dönüşü)';
      bullishOiPts = 14;
    } else if (change1hPct >= 0.25 && oiDelta1hPct >= 0.45) {
      oiQuadrant = 'Q1 (Fiyat↑ OI↑ Yeni Long Girişi)';
      bullishOiPts = Math.min(14, Math.round(7 + oiDelta1hPct * 2.5));
    } else if (change1hPct >= 0.25 && oiDelta1hPct <= -0.50) {
      oiQuadrant = 'Q2 (Fiyat↑ OI↓ Short Kapatma)';
      bullishOiPts = 5;
      if (rsi15m >= 68) bearishOiPts = 6;
    } else if (change1hPct <= -0.25 && oiDelta1hPct >= 0.45) {
      oiQuadrant = 'Q3 (Fiyat↓ OI↑ Agresif Short Yığılması)';
      if (item.fundingRatePct <= -0.008 && anatomy.bullishCvdPts >= 6 && lastPrice >= vwap4h * 0.996) {
        bullishOiPts = 11;
        oiQuadrant = 'Q3-TUZAK (Short Yığılması + Alıcı Emilimi)';
      } else {
        bearishOiPts = Math.min(14, Math.round(7 + oiDelta1hPct * 2.4));
      }
    } else if (change1hPct <= -0.25 && oiDelta1hPct <= -0.50) {
      oiQuadrant = 'Q4 (Fiyat↓ OI↓ Long Tasfiye/Kapitülasyon)';
      if (anatomy.bullishCandlePts >= 8 || anatomy.bullishSmcPts >= 8) {
        bullishOiPts = 10;
      } else {
        bearishOiPts = 9;
      }
    }

    let whaleLongPct = 50;
    let retailLongPct = 50;
    if (Array.isArray(topPosRatio) && topPosRatio.length > 0) {
      const r = Number(topPosRatio[topPosRatio.length - 1]?.longShortRatio || 1);
      whaleLongPct = Number(((100 * r) / (1 + r)).toFixed(1));
    }
    if (Array.isArray(globalAccRatio) && globalAccRatio.length > 0) {
      const r = Number(globalAccRatio[globalAccRatio.length - 1]?.longShortRatio || 1);
      retailLongPct = Number(((100 * r) / (1 + r)).toFixed(1));
    }
    const whaleRetailSpread = Number((whaleLongPct - retailLongPct).toFixed(1));

    // Bi-Directional Institutional Taker Override: When live Taker L/S & CVD confirm active institutional dumping, passive account ratio does not penalize/veto SHORT
    const isLiveInstTakerDumping = instBuySellRatio <= 0.85 && (anatomy.normCvd3BarPct <= -6 || takerBuyPct <= 46.5);
    let bullishWhalePts = 0;
    let bearishWhalePts = 0;
    if (whaleRetailSpread >= 4.0) {
      bullishWhalePts = Math.min(14, Math.round((whaleRetailSpread - 2) * 1.3));
      bearishWhalePts = isLiveInstTakerDumping ? 0 : -Math.min(14, Math.round(whaleRetailSpread * 1.0));
    } else if (whaleRetailSpread <= -3.0) {
      bearishWhalePts = Math.min(15, Math.round((Math.abs(whaleRetailSpread) - 1.5) * 1.35));
      bullishWhalePts = -Math.min(18, Math.round(Math.abs(whaleRetailSpread) * 1.2));
    }
    const whaleVetoLong = whaleRetailSpread <= -6.5;
    const whaleVetoShort = isLiveInstTakerDumping ? whaleRetailSpread >= 16.5 : whaleRetailSpread >= 10.5;

    const isGcrCrowdedManiaShort = Boolean(
      (item.change24hPct >= 10.0 || rsi15m >= 71) &&
        (whaleRetailSpread <= -4.0 || item.basisPct >= 0.045 || item.fundingRatePct >= 0.018 || isLiveInstTakerDumping) &&
        (anatomy.bearishPattern || anatomy.buySideSweep || anatomy.bearishCvdPts >= 6)
    );
    if (isGcrCrowdedManiaShort) {
      bearishWhalePts = Math.min(16, bearishWhalePts + 6);
    }

    // Layer #16 (v8.0): High-Velocity Momentum Surge Bonus (Clean MTF + Volume Expansion + 1h Velocity)
    let velocityLongPts = 0;
    let velocityShortPts = 0;
    if (
      change1hPct >= 0.85 &&
      mtfSqueeze.mtfBullishPts > 0 &&
      volRatio15m >= 1.25 &&
      !anatomy.isFishingTrapLong
    ) {
      velocityLongPts = Math.min(8, Math.round(change1hPct * 2.5 + (volRatio15m - 1) * 3));
    } else if (
      change1hPct <= -0.85 &&
      mtfSqueeze.mtfBearishPts > 0 &&
      (volRatio15m >= 1.15 || isLiveInstTakerDumping)
    ) {
      velocityShortPts = Math.min(8, Math.round(Math.abs(change1hPct) * 2.5 + Math.max(0, volRatio15m - 0.9) * 3));
    }

    const newsAgeMins = item.newsCand?.freshestMinutesAgo ?? 999;
    const hasFreshDirectNews = Boolean(
      item.newsCand &&
        item.newsCand.hasDirectMention &&
        newsAgeMins <= 60 &&
        item.newsCand.liveLlmDecision !== 'WAIT'
    );
    const hasSpotGoldenLeaderSynergy = Boolean(
      item.newsCand &&
        item.newsCand.isGoldenAgeLeader &&
        item.newsCand.liveLlmDecision === 'LONG'
    );

    // Layer #15: Liquidation Magnet Cluster Detector (4h High/Low Stop-Hunt & Short/Long Squeeze Magnet)
    const high4h = Math.max(...klines15m.slice(-16).map(k => Number(k[2])));
    const low4h = Math.min(...klines15m.slice(-16).map(k => Number(k[3])));
    let liqMagnetLongPts = 0;
    let liqMagnetShortPts = 0;
    let liqMagnetLabel = '';
    if (
      oiDelta1hPct >= 0.50 &&
      lastPrice >= high4h * 0.988 &&
      (item.fundingRatePct < 0 || item.basisPct <= -0.025) &&
      !anatomy.vetoLong
    ) {
      liqMagnetLongPts = 5;
      liqMagnetLabel = ' | 🧲 Short Likidasyon Mıknatısı';
    } else if (
      (oiDelta1hPct >= 0.45 || isLiveInstTakerDumping) &&
      lastPrice <= low4h * 1.012 &&
      item.fundingRatePct > -0.05 &&
      !anatomy.vetoShort
    ) {
      liqMagnetShortPts = 5;
      liqMagnetLabel = ' | 🧲 Long Likidasyon Mıknatısı';
    }

    let bullishFundNewsPts = fundingCountdownBonusLong;
    let bearishFundNewsPts = fundingCountdownBonusShort;
    if (item.fundingRatePct <= -0.010 && (lastPrice >= vwap4h * 0.996 || change1hPct > 0)) {
      bullishFundNewsPts += Math.min(10, Math.round(Math.abs(item.fundingRatePct) * 450));
    }
    if (hasFreshDirectNews) {
      bullishFundNewsPts += 10;
    } else if (hasSpotGoldenLeaderSynergy || (item.newsCand && item.newsCand.totalScore >= 78 && newsAgeMins <= 60)) {
      bullishFundNewsPts += 7;
    }
    bullishFundNewsPts = Math.min(14, bullishFundNewsPts);

    if (item.fundingRatePct >= 0.015) {
      bearishFundNewsPts += Math.min(10, Math.round(item.fundingRatePct * 350));
    }
    if (rsi15m >= 69) {
      bearishFundNewsPts += Math.min(8, Math.round((rsi15m - 66) * 1.2));
    }
    bearishFundNewsPts = Math.min(13, bearishFundNewsPts);

    // Wall #6B + Engine #39 (GPT-6-Luna Contract-Specific nextFundingTime Settlement Cost & Dump Guard):
    // 1) Block paying-direction entry within 15m of settlement if |funding| >= 0.035%
    // 2) Block fresh LONG within 12m of settlement on extreme negative funding (<= -0.35%) before funding-farmers dump at the clock boundary
    const fundingVetoLong =
      item.fundingRatePct >= 0.080 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct >= 0.035) ||
      (itemMinsToFunding <= 12 && item.fundingRatePct <= -0.35);
    const fundingVetoShort =
      item.fundingRatePct <= -0.120 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct <= -0.035);

    const vwapLongOk =
      isBnfLiquidationBounce ||
      (lastPrice >= vwap4h * 0.9985 && vwapDistPct <= 1.85 && rsi15m >= 38 && rsi15m <= 70 && mtfSqueeze.mtfBearishPts === 0);
    // Unblinded Bi-Directional Short: Allows both Trend Breakdown Shorts (price <= VWAP, RSI 31-66) AND Overbought Mania Fade Shorts (RSI >= 67)
    const vwapShortOk =
      (lastPrice <= vwap4h * 1.003 && rsi15m >= 31 && rsi15m <= 66 && mtfSqueeze.mtfBullishPts === 0) ||
      rsi15m >= 67 ||
      isGcrCrowdedManiaShort;

    const rawLongTotal =
      36 +
      bullishOiPts +
      bullishWhalePts +
      anatomy.bullishCvdPts +
      anatomy.bullishSmcPts +
      anatomy.bullishCandlePts +
      bullishFundNewsPts +
      (isBnfLiquidationBounce ? 8 : bullishRsPts + mtfSqueeze.mtfBullishPts) +
      bullishBasisPts +
      mtfSqueeze.squeezeBullishPts +
      instTakerLongPts +
      liqMagnetLongPts +
      velocityLongPts;

    const rawShortTotal =
      36 +
      bearishOiPts +
      bearishWhalePts +
      anatomy.bearishCvdPts +
      anatomy.bearishSmcPts +
      anatomy.bearishCandlePts +
      bearishFundNewsPts +
      bearishRsPts +
      bearishBasisPts +
      mtfSqueeze.mtfBearishPts +
      mtfSqueeze.squeezeBearishPts +
      instTakerShortPts +
      liqMagnetShortPts +
      velocityShortPts;

    let engine = 'WATCHLIST';
    let side = 'LONG_ADAY';
    let score = 50;
    let thesis = '';

    // Wall #4: Anti-Top-Chase / Anti-Bottom-Chase + Engine #37 (v8.4 Anti-Exhaustion, 1h Alignment, Volume Floor & Basis Dump Trap Veto)
    const isOverextendedMicroTopLong =
      !isBnfLiquidationBounce &&
      ((anatomy.green3Completed &&
        anatomy.runup4BarPct >= Math.max(0.95, atr15mPct * 1.45) &&
        anatomy.posIn4BarRange >= 0.86 &&
        volRatio15m < 1.55) ||
        (item.change24hPct >= 18.0 && (volRatio15m < 1.35 || mtfSqueeze.mtfBullishPts === 0)));

    // Extreme Negative Basis Dump Trap Veto (e.g. ALTUSDT: basis <= -0.60% while 24h <= -5.0% means spot/unlock dumping, NOT a discount!)
    const isBasisDumpTrapLong = item.basisPct <= -0.60 && item.change24hPct <= -5.0;

    // Require active 15m volume participation (volRatio15m >= 0.72) and positive 1h momentum alignment (prevents BTWUSDT 1h:-0.41% & ALTUSDT 0.51x vol traps)
    const hasLongMomentumAndVol =
      volRatio15m >= 0.72 && (isBnfLiquidationBounce || (change1hPct >= 0.15 && rsVsBtcAtr >= 0.05));
    const hasShortMomentumAndVol =
      volRatio15m >= 0.72 && (isGcrCrowdedManiaShort || (change1hPct <= -0.15 && rsVsBtcAtr <= -0.05));

    const canTriggerLong =
      !btcVetoLong &&
      !whaleVetoLong &&
      !fundingVetoLong &&
      !anatomy.vetoLong &&
      !isTakerRatioCrashingLong &&
      !isOverextendedMicroTopLong &&
      !isBasisDumpTrapLong &&
      hasLongMomentumAndVol &&
      vwapLongOk &&
      (takerBuyPct >= 51.5 || instBuySellRatio >= 1.14 || isBnfLiquidationBounce) &&
      (isBnfLiquidationBounce || rsVsBtcAtr >= -0.20) &&
      rawLongTotal >= 78;

    const canTriggerShort =
      !btcVetoShort &&
      !whaleVetoShort &&
      !fundingVetoShort &&
      !anatomy.vetoShort &&
      !isTakerRatioCrashingShort &&
      hasShortMomentumAndVol &&
      vwapShortOk &&
      (takerBuyPct <= 48.5 || instBuySellRatio <= 0.88 || isGcrCrowdedManiaShort) &&
      (rsVsBtcAtr <= 0.25 || isGcrCrowdedManiaShort) &&
      rawShortTotal >= 78;

    if (canTriggerLong && (!canTriggerShort || rawLongTotal >= rawShortTotal)) {
      side = 'LONG';
      score = Math.min(99, rawLongTotal);
      const dynLev = selectConvictionLeverage(score, atr15mPct);
      engine = isBnfLiquidationBounce
        ? 'ENGINE_BNF_LIQUIDATION_BOUNCE_LONG'
        : hasFreshDirectNews
          ? 'ENGINE_QULLAMAGGIE_NEWS_OI_LONG'
          : mtfSqueeze.squeezeBullishPts > 0
            ? 'ENGINE_TTM_VOLATILITY_SQUEEZE_LONG'
            : item.basisPct <= -0.030 || item.fundingRatePct <= -0.010
              ? 'ENGINE_LIGHTCRYPTO_SQUEEZE_LONG'
              : 'ENGINE_EUGENE_WHALE_SMC_LONG';
      thesis = `[${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel}] ${oiQuadrant} | ${mtfSqueeze.mtfTrend} | 1s: ${change1hPct >= 0 ? '+' : ''}%${change1hPct} (24s: ${item.change24hPct >= 0 ? '+' : ''}%${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr >= 0 ? '+' : ''}${rsVsBtcAtr} ATR | ${basisLabel} | Balina Makası: ${whaleRetailSpread >= 0 ? '+' : ''}%${whaleRetailSpread} | Taker L/S: ${instBuySellRatio}x | ${anatomy.cvdLabel}${liqMagnetLabel} -> ${dynLev}x LONG!`;
    } else if (canTriggerShort) {
      side = 'SHORT';
      score = Math.min(99, rawShortTotal);
      const dynLev = selectConvictionLeverage(score, atr15mPct);
      engine = isGcrCrowdedManiaShort
        ? 'ENGINE_GCR_MANIA_FADE_SHORT'
        : mtfSqueeze.squeezeBearishPts > 0
          ? 'ENGINE_TTM_VOLATILITY_SQUEEZE_SHORT'
          : 'ENGINE_SMC_WHALE_FLUSH_SHORT';
      thesis = `[${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel}] ${oiQuadrant} | ${mtfSqueeze.mtfTrend} | 1s: %${change1hPct} (24s: %${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr} ATR | ${basisLabel} | Balina Makası: %${whaleRetailSpread} | Kurumsal Taker L/S: ${instBuySellRatio}x | ${anatomy.cvdLabel}${liqMagnetLabel} -> ${dynLev}x SHORT!`;
    } else {
      if (rawShortTotal > rawLongTotal && !anatomy.vetoShort && !fundingVetoShort) {
        side = 'SHORT_ADAY';
        score = Math.min(75, Math.max(30, rawShortTotal));
      } else {
        side = 'LONG_ADAY';
        score = Math.min(75, Math.max(30, rawLongTotal));
      }
      thesis = `${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel} | ${oiQuadrant} | 1s: ${change1hPct >= 0 ? '+' : ''}%${change1hPct} (24s: ${item.change24hPct >= 0 ? '+' : ''}%${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr >= 0 ? '+' : ''}${rsVsBtcAtr} | Balina Makası: ${whaleRetailSpread >= 0 ? '+' : ''}%${whaleRetailSpread} | Taker L/S: ${instBuySellRatio}x | ${anatomy.cvdLabel}`;
    }

    const convictionLeverage = selectConvictionLeverage(score, atr15mPct);

    evaluated.push({
      symbol: item.symbol,
      fSym: item.fSym,
      markPrice: lastPrice,
      fundingRatePct: item.fundingRatePct,
      minsToFunding: itemMinsToFunding,
      basisPct: item.basisPct,
      basisLabel,
      change1hPct,
      change24hPct: item.change24hPct,
      range24hPct: item.range24hPct,
      rsVsBtcAtr,
      rsi15m,
      atr15mPct,
      vwap4h: Number(vwap4h.toPrecision(6)),
      vwapDistPct,
      takerBuyPct,
      instBuySellRatio,
      volRatio15m,
      oiDelta1hPct,
      oiQuadrant,
      whaleLongPct,
      retailLongPct,
      whaleRetailSpread,
      candlePattern: anatomy.patternLabel,
      smcLabel: anatomy.smcLabel,
      cvdLabel: anatomy.cvdLabel,
      mtfTrend: mtfSqueeze.mtfTrend,
      squeezeLabel: mtfSqueeze.squeezeLabel,
      structuralLow: anatomy.structuralLow,
      structuralHigh: anatomy.structuralHigh,
      convictionLeverage,
      engine,
      side,
      score,
      thesis,
      headline: item.newsCand?.headlines?.[0]?.title || null,
    });
  }

  evaluated.sort((a, b) => b.score - a.score);

  const avgFunding = fundingCnt > 0 ? Number((fundingSum / fundingCnt).toFixed(4)) : 0;
  state.marketSummary = {
    btcPrice: btcMark,
    btcChange15mPct: btc15mChangePct,
    btcChange1hPct: btc1hChangePct,
    avgFundingRatePct: avgFunding,
    minsToNextFunding,
    activeUniverseCount: preCandidates.length,
    regimeLabel: btcVetoLong
      ? `⚠️ BTC SERT DÜŞÜŞ (${btc15mChangePct}%/15dk) -> LONG VETO, SADECE GCR SHORT!`
      : btcVetoShort
        ? `🚀 BTC SERT YÜKSELİŞ (+${btc15mChangePct}%/15dk) -> SHORT VETO, SADECE EUGENE LONG!`
        : `20 KATMANLI YIRTICI KONSEY v8.6 (${preCandidates.length} Likit Kontrat | 3x-3.5x-4x Anti-İğne + Luna Mikro-Fiyat Kalkanı)`,
    lastScanAt: new Date().toLocaleString('tr-TR'),
    statusNote: state.openPosition
      ? `🔥 Açık ${state.openPosition.leverage || LEVERAGE}x ${state.openPosition.side}: ${state.openPosition.symbol}USDT takip ediliyor.`
      : `🛡️ Pusuda: Tüm Binance Futures (${preCandidates.length} Yüksek Hızlı Kontrat) 3x/3.5x/4x için taranıyor.`,
  };
  state.topCandidates = evaluated.slice(0, 8);
  return evaluated;
}

async function manageOpenPosition(state, candidates = []) {
  const pos = state.openPosition;
  if (!pos || pos.isClosing) return;

  const book = await fetchJson(`${FAPI_BASE}/fapi/v1/ticker/bookTicker?symbol=${pos.fSym}`, {}, 2500);
  if (!book || !state.openPosition || state.openPosition.isClosing) return;
  const bestBid = Number(book.bidPrice || 0);
  const bestAsk = Number(book.askPrice || 0);
  if (bestBid <= 0 || bestAsk <= 0) return;

  const markExitPrice = pos.side === 'LONG' ? bestBid : bestAsk;
  pos.currentPrice = markExitPrice;

  if (pos.side === 'LONG') {
    if (!pos.extremePrice || markExitPrice > pos.extremePrice) pos.extremePrice = markExitPrice;
  } else {
    if (!pos.extremePrice || markExitPrice < pos.extremePrice) pos.extremePrice = markExitPrice;
  }

  const rawCoinMoveFrac =
    pos.side === 'LONG'
      ? (markExitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - markExitPrice) / pos.entryPrice;

  const peakCoinMoveFrac =
    pos.side === 'LONG'
      ? (pos.extremePrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - pos.extremePrice) / pos.entryPrice;

  const netCoinMoveFrac = rawCoinMoveFrac - ROUND_TRIP_FEE_SLIP_FRAC;
  const netPnlUsdt = Number((pos.notionalUsdt * netCoinMoveFrac).toFixed(4));
  const netPnlTry = toTL(netPnlUsdt);
  const roePct = Number(((netPnlUsdt / pos.marginUsdt) * 100).toFixed(2));
  const underlyingMovePct = Number((rawCoinMoveFrac * 100).toFixed(2));

  pos.unrealizedPnlUsdt = netPnlUsdt;
  pos.unrealizedPnlTry = netPnlTry;
  pos.roePct = roePct;
  pos.underlyingMovePct = underlyingMovePct;
  const posLev = pos.leverage || LEVERAGE;

  // Stage 2 (v8.4 Asymmetric Runner + Zero-Choke): Harvest 35% at +1.25% Coin Move, keep 65% Runner with 0.90% breathing room (+0.35% stop lock)
  if (!pos.tp1Done && rawCoinMoveFrac >= 0.0125) {
    const harvestFrac = 0.35;
    const closedMarginUsdt = Number((pos.marginUsdt * harvestFrac).toFixed(4));
    const closedNotionalUsdt = Number((pos.notionalUsdt * harvestFrac).toFixed(4));
    const partialNetPnlUsdt = Number((closedNotionalUsdt * netCoinMoveFrac).toFixed(4));
    const partialNetPnlTry = toTL(partialNetPnlUsdt);
    const partialRoePct = Number(((partialNetPnlUsdt / closedMarginUsdt) * 100).toFixed(2));

    state.marginCashUsdt = Number((state.marginCashUsdt + closedMarginUsdt + partialNetPnlUsdt).toFixed(4));
    state.realizedPnlUsdt = Number((state.realizedPnlUsdt + partialNetPnlUsdt).toFixed(4));

    pos.marginUsdt = Number((pos.marginUsdt - closedMarginUsdt).toFixed(4));
    pos.notionalUsdt = Number((pos.notionalUsdt - closedNotionalUsdt).toFixed(4));
    pos.marginTry = toTL(pos.marginUsdt);
    pos.notionalTry = toTL(pos.notionalUsdt);
    pos.realizedPartialUsdt = Number(((pos.realizedPartialUsdt || 0) + partialNetPnlUsdt).toFixed(4));
    pos.tp1Done = true;
    pos.ratchetStage = 'TP1_HARVESTED_RUNNER';

    if (pos.side === 'LONG') {
      const lockTp1 = Number((pos.entryPrice * (1 + 0.0035)).toPrecision(6));
      if (lockTp1 > pos.stopPrice) pos.stopPrice = lockTp1;
    } else {
      const lockTp1 = Number((pos.entryPrice * (1 - 0.0035)).toPrecision(6));
      if (lockTp1 < pos.stopPrice) pos.stopPrice = lockTp1;
    }

    logEvent(
      state,
      `💰 [TP1 %35 KÂR CEBELLEZİ] ${pos.symbol}USDT (${posLev}x ${pos.side}) +%${underlyingMovePct} yürüyüşte %35 nakde çevrildi (+${partialNetPnlTry} TL cebe indi!) | Kalan %65 Ana Gövde Runner Stopu +%0.35 Kâra Kilitlendi (0.90% Nefes Payı)!`
    );

    const tp1Sweep = sweepProfitToSpotVault(
      state,
      partialNetPnlUsdt,
      `${pos.symbol}USDT`,
      'TP1 %35 KÂR CEBELLEZİ -> Spot Cüzdana Kâr Transferi'
    );
    pos.sweptAtTp1Try = tp1Sweep.sweptTry;

    await sendProfitNotification(state, {
      symbol: `${pos.symbol}USDT`,
      side: pos.side,
      leverage: posLev,
      type: 'TP1 %35 KÂR CEBELLEZİ (%65 Runner Devam Ediyor)',
      netPnlTry: partialNetPnlTry,
      spotTransferTry: tp1Sweep.sweptTry,
      roePct: partialRoePct,
      entryPrice: pos.entryPrice,
      exitPrice: markExitPrice,
      thesis: pos.thesis,
    });
  }

  // Stage 1 / Stage 3 (v8.4 Wide-Breathing Ratchet): Prevents premature +2.39 TL choke so 65% Runner catches +10 TL to +25 TL waves
  if (peakCoinMoveFrac >= 0.0195) {
    pos.ratchetStage = 'PARABOLIC_SQUEEZE_RUNNER';
    if (pos.side === 'LONG') {
      const trailStop = Number((pos.extremePrice * (1 - 0.0055)).toPrecision(6));
      if (trailStop > pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice >= pos.tpPrice * 0.997) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb >= 0.12) {
          pos.tpPrice = Number((markExitPrice * 1.015).toPrecision(6));
        }
      }
    } else {
      const trailStop = Number((pos.extremePrice * (1 + 0.0055)).toPrecision(6));
      if (trailStop < pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice <= pos.tpPrice * 1.003) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb <= -0.12) {
          pos.tpPrice = Number((markExitPrice * 0.985).toPrecision(6));
        }
      }
    }
  } else if (peakCoinMoveFrac >= 0.0155) {
    if (!pos.ratchetStage.includes('TP1')) pos.ratchetStage = 'PROFIT_LOCK_2';
    if (pos.side === 'LONG') {
      const lock2 = Number((pos.entryPrice * (1 + 0.0075)).toPrecision(6));
      if (lock2 > pos.stopPrice) pos.stopPrice = lock2;
    } else {
      const lock2 = Number((pos.entryPrice * (1 - 0.0075)).toPrecision(6));
      if (lock2 < pos.stopPrice) pos.stopPrice = lock2;
    }
  } else if (peakCoinMoveFrac >= 0.0092) {
    pos.ratchetStage = 'FAST_BREAKEVEN_PLUS';
    if (pos.side === 'LONG') {
      const bePlus = Number((pos.entryPrice * (1 + 0.0024)).toPrecision(6));
      if (bePlus > pos.stopPrice) pos.stopPrice = bePlus;
    } else {
      const bePlus = Number((pos.entryPrice * (1 - 0.0024)).toPrecision(6));
      if (bePlus < pos.stopPrice) pos.stopPrice = bePlus;
    }
  }

  const isTpHit =
    pos.side === 'LONG' ? markExitPrice >= pos.tpPrice : markExitPrice <= pos.tpPrice;
  const isStopHit =
    pos.side === 'LONG' ? markExitPrice <= pos.stopPrice : markExitPrice >= pos.stopPrice;

  const minsHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
  const isTimeStop = minsHeld >= 90 && rawCoinMoveFrac < 0.0035 && rawCoinMoveFrac > -0.0065;

  let isOrderflowScratch = false;
  let isFishingEmergencyExit = false;
  let isFundingSettlementHarvest = false;
  const curPosLiveCand = candidates.find(c => c.symbol === pos.symbol);
  if (!isTpHit && !isStopHit && curPosLiveCand && Number.isFinite(curPosLiveCand.minsToFunding)) {
    const posMinsToFund = curPosLiveCand.minsToFunding;
    const liveFundPct = curPosLiveCand.fundingRatePct;
    const isPayingHeavyFunding =
      (pos.side === 'LONG' && liveFundPct >= 0.050) ||
      (pos.side === 'SHORT' && liveFundPct <= -0.050);
    const isExtremeNegFundFarmerDumpRisk =
      pos.side === 'LONG' && liveFundPct <= -0.40 && !pos.tp1Done && rawCoinMoveFrac < 0.0125;
    if (
      posMinsToFund <= 5 &&
      rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC + 0.0015 &&
      (isPayingHeavyFunding || isExtremeNegFundFarmerDumpRisk)
    ) {
      isFundingSettlementHarvest = true;
    }
  }
  if (!isTpHit && !isStopHit && minsHeld >= 12 && rawCoinMoveFrac <= 0.0010 && rawCoinMoveFrac >= -0.0060 && curPosLiveCand) {
    if (
      (pos.side === 'LONG' && (curPosLiveCand.instBuySellRatio <= 0.75 || curPosLiveCand.candlePattern.includes('Yemleme/Fishing')) && curPosLiveCand.takerBuyPct <= 44.0) ||
      (pos.side === 'SHORT' && curPosLiveCand.instBuySellRatio >= 1.35 && curPosLiveCand.takerBuyPct >= 56.0)
    ) {
      isFishingEmergencyExit = true;
    }
  }
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && minsHeld >= 22 && rawCoinMoveFrac <= 0.0015 && rawCoinMoveFrac >= -0.0045) {
    const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
    if (depth?.bids?.length && depth?.asks?.length) {
      const liveOb = computeWeightedBookImbalance(depth.bids, depth.asks);
      if ((pos.side === 'LONG' && liveOb <= -0.22) || (pos.side === 'SHORT' && liveOb >= 0.22)) {
        isOrderflowScratch = true;
      }
    }
  }

  // Zero-Loss Slot Rotation Rule (v8.4): NEVER rotate out at a loss (rawCoinMoveFrac must cover round-trip fees >= 0.0018)!
  let rotationTarget = null;
  const nowMs = Date.now();
  const isRotationCooldownReady = nowMs - (state.lastRotationAtMs || 0) >= 30 * 60 * 1000;
  const symbolCooldowns = state.symbolCooldowns || {};
  const obVetoCooldowns = state.obVetoCooldowns || {};
  if (
    !isTpHit &&
    !isStopHit &&
    !isOrderflowScratch &&
    isRotationCooldownReady &&
    minsHeld >= 25 &&
    rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC &&
    rawCoinMoveFrac <= 0.0035 &&
    candidates.length > 0
  ) {
    const curLiveCand = candidates.find(c => c.symbol === pos.symbol);
    const curLiveScore = curLiveCand ? curLiveCand.score : 99; // Fail-closed if missing
    const isCurDegraded = Boolean(curLiveCand && (curLiveCand.engine === 'WATCHLIST' || curLiveScore < 66));
    const bestNewCand = candidates.find(
      c =>
        c.symbol !== pos.symbol &&
        c.engine !== 'WATCHLIST' &&
        (c.side === 'LONG' || c.side === 'SHORT') &&
        c.score >= 92 &&
        (!symbolCooldowns[c.symbol] || symbolCooldowns[c.symbol] <= nowMs) &&
        (!obVetoCooldowns[c.symbol] || obVetoCooldowns[c.symbol] <= nowMs)
    );
    if (isCurDegraded && bestNewCand && bestNewCand.score - curLiveScore >= 22) {
      rotationTarget = bestNewCand;
    }
  }

  let exitReason = null;
  if (isTpHit) {
    exitReason = `🎯 ${posLev}x TAM HEDEF HASADI (${pos.side} | Coin %${underlyingMovePct} -> Kasa ROE +%${roePct})`;
  } else if (isStopHit) {
    const isProfitStop =
      pos.side === 'LONG' ? pos.stopPrice > pos.entryPrice : pos.stopPrice < pos.entryPrice;
    exitReason = isProfitStop
      ? `🔒 ${posLev}x SIFIR RİSK / SIKIŞTIRMA KÂR KİLİDİ (${pos.side} | Kasa ROE +${roePct}%)`
      : `🛡️ ${posLev}x İZOLE STOP KALKANI (${pos.side} | Coin %${underlyingMovePct} -> Kasa ROE ${roePct}%)`;
  } else if (isFishingEmergencyExit) {
    exitReason = `🎣 YEMLEME (FISHING) ERKEN TAHLİYESİ (Kurumsal Alıcı Çöktü [Taker L/S ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x], Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isOrderflowScratch) {
    exitReason = `🛡️ EUGENE ERKEN TAHTA TAHLİYESİ (Emir Defteri Tersine Döndü, Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isFundingSettlementHarvest) {
    exitReason = `⏱️ FONLAMA KESİNTİSİ ÖNCESİ KÂR HASADI (Kesime <=5dk | Fonlama %${curPosLiveCand?.fundingRatePct ?? 0} | ROE +${roePct}%)`;
  } else if (rotationTarget) {
    exitReason = `🔄 ULTRA-APEX SIFIR-ZARAR SLOT ROTASYONU (Başabaş/Kârlı İşlemden ${rotationTarget.symbol} [${rotationTarget.score}/99] Fırsatına Geçildi | ROE +${roePct}%)`;
  } else if (isTimeStop) {
    exitReason = `⏱️ 90dk FONLAMA/ZAMAN KORUMASI (İvme Durdu, Fonlama Kesintisi Öncesi Çıkıldı | ROE ${roePct}%)`;
  }

  if (exitReason && state.openPosition && !pos.isClosing) {
    pos.isClosing = true; // Synchronous atomic lock so no concurrent loop can ever double-close or double-refund!
    state.openPosition = null;

    const finalLegPnlUsdt = Number((pos.notionalUsdt * netCoinMoveFrac).toFixed(4));
    const totalLifecyclePnlUsdt = Number(((pos.realizedPartialUsdt || 0) + finalLegPnlUsdt).toFixed(4));
    const totalLifecyclePnlTry = toTL(totalLifecyclePnlUsdt);
    const initialMarginUsdt = pos.initialMarginUsdt || pos.marginUsdt;
    const initialNotionalUsdt = pos.initialNotionalUsdt || pos.notionalUsdt;
    const lifecycleRoePct = Number(((totalLifecyclePnlUsdt / initialMarginUsdt) * 100).toFixed(2));

    state.marginCashUsdt = Number((state.marginCashUsdt + pos.marginUsdt + finalLegPnlUsdt).toFixed(4));
    state.realizedPnlUsdt = Number((state.realizedPnlUsdt + finalLegPnlUsdt).toFixed(4));
    if (totalLifecyclePnlUsdt >= 0) state.winCount = (state.winCount || 0) + 1;
    else state.lossCount = (state.lossCount || 0) + 1;

    state.closedTrades.unshift({
      symbol: pos.symbol,
      side: pos.side,
      engine: pos.engine,
      leverage: posLev,
      marginTry: toTL(initialMarginUsdt),
      notionalTry: toTL(initialNotionalUsdt),
      entryPrice: pos.entryPrice,
      exitPrice: markExitPrice,
      roePct: lifecycleRoePct,
      netPnlTry: totalLifecyclePnlTry,
      exitReason,
      closedAt: new Date().toLocaleString('tr-TR'),
    });
    if (!state.symbolCooldowns) state.symbolCooldowns = {};
    const cdMins = totalLifecyclePnlUsdt >= 0 ? 25 : 35;
    state.symbolCooldowns[pos.symbol] = Date.now() + cdMins * 60 * 1000;
    if (rotationTarget) {
      state.lastRotationAtMs = Date.now();
    }
    if (state.closedTrades.length > 30) state.closedTrades.length = 30;
    logEvent(state, `${exitReason} | ${pos.symbol}USDT Toplam Net: ${totalLifecyclePnlTry >= 0 ? '+' : ''}${totalLifecyclePnlTry} TL`);

    if (totalLifecyclePnlTry > 0) {
      const finalSweep = sweepProfitToSpotVault(
        state,
        Math.max(0, finalLegPnlUsdt),
        `${pos.symbol}USDT`,
        `${isTpHit ? 'TAM HEDEF HASADI (TP)' : 'KÂR KİLİDİ KAPANIŞI'} -> Spot Cüzdana Kâr Transferi`
      );
      const totalSweptForTradeTry = Number(((pos.sweptAtTp1Try || 0) + finalSweep.sweptTry).toFixed(2));
      await sendProfitNotification(state, {
        symbol: `${pos.symbol}USDT`,
        side: pos.side,
        leverage: posLev,
        type: isTpHit ? 'TAM HEDEF HASADI (TP)' : 'KÂR KİLİDİ KAPANIŞI',
        netPnlTry: totalLifecyclePnlTry,
        spotTransferTry: totalSweptForTradeTry,
        roePct: lifecycleRoePct,
        entryPrice: pos.entryPrice,
        exitPrice: markExitPrice,
        thesis: pos.thesis,
      });
    }
  }
}

async function tryOpenPosition(state, candidates) {
  if (state.openPosition) return;

  // Hard 100 TL Cap Enforcement: If leverage cash ever exceeds 100.00 TL (2.0182 USDT), sweep excess to Spot Vault BEFORE sizing
  if (state.marginCashUsdt > INITIAL_BANKROLL_USDT + 0.0002) {
    sweepProfitToSpotVault(state, 0, 'KASA_100TL_TAVAN', '100 TL Üstü Fazla Bakiye -> Spot Cüzdana Otomatik Transfer');
  }

  const nowEntryMs = Date.now();
  const symCds = state.symbolCooldowns || {};
  if (!state.obVetoCooldowns) state.obVetoCooldowns = {};
  const obVetoCds = state.obVetoCooldowns;

  const actionable = candidates.filter(
    c =>
      c.engine !== 'WATCHLIST' &&
      (c.side === 'LONG' || c.side === 'SHORT') &&
      c.score >= 78 &&
      (!symCds[c.symbol] || symCds[c.symbol] <= nowEntryMs) &&
      (!obVetoCds[c.symbol] || obVetoCds[c.symbol] <= nowEntryMs)
  );
  if (!actionable.length) return;

  // v8.4 Fixed 100 TL Principal Rule: NEVER risk more than 100.00 TL (INITIAL_BANKROLL_USDT) in Leverage!
  const cappedPrincipalUsdt = Math.min(state.marginCashUsdt, INITIAL_BANKROLL_USDT);
  const usableMarginUsdt = Number((cappedPrincipalUsdt * 0.96).toFixed(4));

  for (const cand of actionable) {
    const chosenLev = cand.convictionLeverage || selectConvictionLeverage(cand.score, cand.atr15mPct);
    const maxNotionalUsdt = Number((usableMarginUsdt * chosenLev).toFixed(4));
    if (maxNotionalUsdt < MIN_NOTIONAL_USDT) {
      logEvent(
        state,
        `⚠️ [MIN_NOTIONAL KALKANI] Mevcut ${chosenLev}x Alım Gücü ($${maxNotionalUsdt} / ${toTL(maxNotionalUsdt)} TL) Binance Futures alt sınırı olan 5.00 USDT altına indiği için emir durduruldu!`
      );
      return;
    }

    const obCheck = await fetchPerpOrderbookConfirm(cand.symbol, cand.side);
    if (!obCheck.ok) {
      // Engine #36: 12-Minute Orderbook Veto Strike Cooldown (prevents hammering a rejected book 30s later like BTWUSDT)
      state.obVetoCooldowns[cand.symbol] = Date.now() + 12 * 60 * 1000;
      logEvent(
        state,
        `⚖️ [Vadeli Tahta Vetosu + 12dk Blok] ${cand.symbol} (${chosenLev}x ${cand.side} | ${cand.score}p) pas geçildi: ${obCheck.reason}`
      );
      continue;
    }

    const entryPrice = cand.side === 'LONG' ? obCheck.bestAsk : obCheck.bestBid;
    let rawWickDistFrac = 0.0095;
    if (cand.side === 'LONG' && cand.structuralLow > 0 && cand.structuralLow < entryPrice) {
      rawWickDistFrac = (entryPrice - cand.structuralLow * 0.999) / entryPrice;
    } else if (cand.side === 'SHORT' && cand.structuralHigh > entryPrice) {
      rawWickDistFrac = (cand.structuralHigh * 1.001 - entryPrice) / entryPrice;
    }
    // v8.5 300 TL Anti-Wick Stop Band (-0.92% to -1.22% structural room so 3x-4x leverage survives normal market wicks)
    const maxSlCap = chosenLev >= 4 ? 0.0108 : chosenLev >= 3.5 ? 0.0115 : 0.0122;
    const underlyingSlFrac = Math.min(maxSlCap, Math.max(0.0092, rawWickDistFrac, (cand.atr15mPct / 100) * 0.78));
    const underlyingTpFrac = Math.max(0.0250, underlyingSlFrac * 2.65);

    const stopPrice =
      cand.side === 'LONG'
        ? Number((entryPrice * (1 - underlyingSlFrac)).toPrecision(6))
        : Number((entryPrice * (1 + underlyingSlFrac)).toPrecision(6));

    const tpPrice =
      cand.side === 'LONG'
        ? Number((entryPrice * (1 + underlyingTpFrac)).toPrecision(6))
        : Number((entryPrice * (1 - underlyingTpFrac)).toPrecision(6));

    const liqDistFrac = Number((0.92 / chosenLev).toFixed(4));
    const liqPrice =
      cand.side === 'LONG'
        ? Number((entryPrice * (1 - liqDistFrac)).toPrecision(6))
        : Number((entryPrice * (1 + liqDistFrac)).toPrecision(6));

    state.leverage = chosenLev;
    state.marginCashUsdt = Number((state.marginCashUsdt - usableMarginUsdt).toFixed(4));
    state.openPosition = {
      id: `perp_${Date.now()}_${cand.symbol}`,
      symbol: cand.symbol,
      fSym: cand.fSym,
      side: cand.side,
      engine: cand.engine,
      candlePattern: cand.candlePattern,
      leverage: chosenLev,
      initialMarginUsdt: usableMarginUsdt,
      initialNotionalUsdt: maxNotionalUsdt,
      marginUsdt: usableMarginUsdt,
      marginTry: toTL(usableMarginUsdt),
      notionalUsdt: maxNotionalUsdt,
      notionalTry: toTL(maxNotionalUsdt),
      entryPrice,
      currentPrice: entryPrice,
      extremePrice: entryPrice,
      stopPrice,
      tpPrice,
      liqPrice,
      tp1Done: false,
      realizedPartialUsdt: 0,
      underlyingSlPct: Number((underlyingSlFrac * 100).toFixed(2)),
      underlyingTpPct: Number((underlyingTpFrac * 100).toFixed(2)),
      fundingRatePct: cand.fundingRatePct,
      oiDelta1hPct: cand.oiDelta1hPct,
      whaleRetailSpread: cand.whaleRetailSpread,
      obImbalanceAtEntry: obCheck.avgOb,
      spreadPctAtEntry: obCheck.spreadPct,
      thesis: cand.thesis,
      ratchetStage: 'INITIAL_STOP',
      unrealizedPnlUsdt: 0,
      unrealizedPnlTry: 0,
      roePct: 0,
      underlyingMovePct: 0,
      entryTime: new Date().toISOString(),
    };

    logEvent(
      state,
      `🚀 [${chosenLev}x ${cand.side} GİRİŞ (300 TL Anti-İğne)] ${cand.symbol}USDT @ $${entryPrice} | Teminat: ${toTL(usableMarginUsdt)} TL (${chosenLev}x Büyüklük: ${toTL(maxNotionalUsdt)} TL) | Stop: $${stopPrice} (-%${(underlyingSlFrac * 100).toFixed(2)}) | TP1: +%1.25 (%35 Nakit) | Ana Hedef: $${tpPrice} (+%${(underlyingTpFrac * 100).toFixed(2)}) | ${cand.thesis}`
    );
    break;
  }
}

function updateAccountingAndReport(state) {
  const openEquityUsdt = state.openPosition
    ? state.openPosition.marginUsdt + (state.openPosition.unrealizedPnlUsdt || 0)
    : 0;
  state.spotVaultUsdt = Number((state.spotVaultUsdt || 0).toFixed(4));
  state.totalEquityUsdt = Number((state.marginCashUsdt + openEquityUsdt).toFixed(4));
  state.totalPnlUsdt = Number((state.totalEquityUsdt + state.spotVaultUsdt - state.initialBankrollUsdt).toFixed(4));
  state.totalPnlPct = Number(((state.totalPnlUsdt / state.initialBankrollUsdt) * 100).toFixed(2));
  const lanIp = getLocalLanIp();

  const pos = state.openPosition;
  const activeLev = pos?.leverage || state.leverage || LEVERAGE;
  const openSection = !pos
    ? '| *Şu an açık vadeli işlem yok (16 Katmanlı Yırtıcı Konsey Skoru >= 78 bekleniyor)* | - | - | - | - | - |\n'
    : `| **${pos.symbol}USDT (${pos.side} ${pos.leverage || LEVERAGE}x)** | \`${pos.marginTry} TL\` *(${pos.leverage || LEVERAGE}x Hacim: ${pos.notionalTry} TL)* | \`$${pos.entryPrice}\` -> \`$${pos.currentPrice}\` | **\`${pos.unrealizedPnlTry >= 0 ? '+' : ''}${pos.unrealizedPnlTry} TL (ROE %${pos.roePct})\`** | 🛑 Stop: \`$${pos.stopPrice}\`<br>🎯 Hedef: \`$${pos.tpPrice}\`<br>💀 Likidasyon: \`$${pos.liqPrice}\` | **${pos.engine}**<br>${pos.thesis} |\n`;

  const closedSection =
    !state.closedTrades || state.closedTrades.length === 0
      ? '| *Henüz kapanan vadeli işlem yok* | - | - | - | - |\n'
      : state.closedTrades
          .slice(0, 12)
          .map(
            c =>
              `| **${c.symbol}USDT (${c.side} ${c.leverage || 3}x)** | \`${c.marginTry} TL\` *(${c.notionalTry} TL)* | \`$${c.entryPrice}\` -> \`$${c.exitPrice}\` | **\`${c.netPnlTry >= 0 ? '+' : ''}${c.netPnlTry} TL (%${c.roePct})\`** | ${c.exitReason} |`
          )
          .join('\n') + '\n';

  const candSection =
    !state.topCandidates || state.topCandidates.length === 0
      ? '| *Tarama bekleniyor* | - | - | - | - | - |\n'
      : state.topCandidates
          .map(
            c =>
              `| **${c.symbol}USDT** | \`${c.side}\` (**\`${c.score}/99\`** -> \`${c.convictionLeverage || 3}x\`) | \`%${c.fundingRatePct}\` | \`${c.whaleRetailSpread >= 0 ? '+' : ''}%${c.whaleRetailSpread}\` *(${c.whaleLongPct}L/${c.retailLongPct}L)* | \`%${c.oiDelta1hPct}\` | ${c.thesis} |`
          )
          .join('\n') + '\n';

  const md = `# ⚡ 300 TL SABİT ANA PARA (3x–4x ANTİ-İĞNE KALDIRAÇ) + SPOT CÜZDAN KÂR SİFONU (Mutlak Yapı v8.5)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}  
**PC Paneli:** \`http://localhost:${DASHBOARD_PORT}\` | **📱 Telefon Wi-Fi Linki:** \`http://${lanIp}:${DASHBOARD_PORT}\`  
**Çalışma Modu:** \`${state.mode}\` *(Sadece Max 300 TL İle Oynar + 3x/3.5x/4x Anti-İğne Kaldıraç + Kazanılan Kârları Otomatik Spot Cüzdana Atar)*

---

## 1. 300 TL SABİT KALDIRAÇ KASASI & SPOT CÜZDANA AKTARILAN KÂR DURUMU

* **Kaldıraç Sabit Tavanı (Max Ana Para):** \`${toTL(state.initialBankrollUsdt)} TL\` (\`$${state.initialBankrollUsdt} USDT\`)
* **Aktif Kaldıraç Kasası (Max 300 TL):** **\`${toTL(state.totalEquityUsdt)} TL\`** *(3x–4x İşlem Gücü: \`${toTL(state.totalEquityUsdt * activeLev)} TL\` - \`${toTL(state.totalEquityUsdt * MAX_CONVICTION_LEVERAGE)} TL\`)*
* **🏦 Spot Cüzdana Atılan Dokunulmaz Kâr Kasası:** **\`+${toTL(state.spotVaultUsdt)} TL\`** *(Kaldıraç stopları bu kasaya asla dokunamaz!)*
* **Toplam Net Kâr / Zarar:** **\`${state.totalPnlUsdt >= 0 ? '+' : ''}${toTL(state.totalPnlUsdt)} TL\` (\`${state.totalPnlPct >= 0 ? '+' : ''}%${state.totalPnlPct}\`)**
* **Başarılı İşlem / Stop:** \`${state.winCount} Kazanç / ${state.lossCount} Stop\`
* **BTC Kalkanı & Vadeli Rejim:** **\`${state.marketSummary?.regimeLabel || '-'}\`** *(BTC 15dk: \`%${state.marketSummary?.btcChange15mPct || 0}\` | 1s: \`%${state.marketSummary?.btcChange1hPct || 0}\`)*

---

## 2. AÇIK VADELİ POZİSYON (3x / 3.5x / 4x LONG & SHORT — MAX 300 TL ANA PARA)

| Kontrat & Yön | Teminat (Kaldıraçlı Büyüklük) | Giriş -> Güncel | Anlık Net Kâr (ROE) | Stop / Hedef / Likidasyon | Strateji Motoru & Milyarder Tezi |
| :--- | :--- | :--- | :--- | :--- | :--- |
${openSection}
---

## 3. CANLI YÜKSEK HIZLI VADELİ RADAR (100+ KONTRAT İÇİNDEN EN GÜÇLÜ 8 ADAY)

| Kontrat | Yön, Skor & Kaldıraç | Fonlama (8s) | Balina vs Küçük Yatırımcı Makası | OI (1s) | 16 Katmanlı Yırtıcı Konsey Tezi |
| :--- | :--- | :--- | :--- | :--- | :--- |
${candSection}
---

## 4. KAPANAN VADELİ İŞLEMLER

| Kontrat & Yön | Teminat (Hacim) | Giriş -> Çıkış | Net Kâr / ROE | Çıkış Sebebi |
| :--- | :--- | :--- | :--- | :--- |
${closedSection}
`;
  fs.writeFileSync(REPORT_FILE, md, 'utf8');
  saveState(state);
}

function startDashboardServer(state) {
  const lanIp = getLocalLanIp();
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', `http://localhost:${DASHBOARD_PORT}`);
    if (urlObj.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ perp: state, spot: loadSpotPortfolioSummary() }));
      return;
    }
    if (urlObj.pathname === '/api/test-email') {
      const toEmail = loadEnv().ALERT_EMAIL_TO || 'berkeakdemir5855@gmail.com';
      const lastWin = (state.profitMails || [])[0] || {
        symbol: 'ERAUSDT',
        side: 'LONG',
        leverage: 6,
        type: 'TAM HEDEF HASADI (TP)',
        netPnlTry: 23.23,
        spotTransferTry: 11.62,
        roePct: 30.19,
        entryPrice: 0.07446,
        exitPrice: 0.07834,
      };
      try {
        await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(toEmail)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: `http://localhost:${DASHBOARD_PORT}`,
            Referer: `http://localhost:${DASHBOARD_PORT}/`,
          },
          body: JSON.stringify({
            _subject: `💰 [KÂR & SPOT RAPORU] ${lastWin.symbol} (${lastWin.leverage}x ${lastWin.side}) -> +${lastWin.netPnlTry} TL Kazandın!`,
            _template: 'table',
            _captcha: 'false',
            Kazandiran_Coin: `${lastWin.symbol} (${lastWin.leverage}x ${lastWin.side})`,
            Islem_Turu: lastWin.type,
            Net_Kazanc: `+${lastWin.netPnlTry} TL (+%${lastWin.roePct} ROE)`,
            Spot_Cuzdana_Atilan: `+${lastWin.spotTransferTry || 11.62} TL (Toplam Spot Kâr Kasası: +${toTL(state.spotVaultUsdt || 0)} TL)`,
            Fiyat_Hareketi: `$${lastWin.entryPrice} -> $${lastWin.exitPrice}`,
            Aktif_Kaldirac_Kasasi: `${toTL(state.totalEquityUsdt)} TL (Max 300 TL Sabit Ana Para)`,
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        // ignore transient error
      }
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    if (urlObj.pathname === '/api/save-gmail') {
      const inputVal = (urlObj.searchParams.get('pass') || '').trim();
      if (inputVal && fs.existsSync(ENV_FILE)) {
        let envText = fs.readFileSync(ENV_FILE, 'utf8');
        if (inputVal.includes('@')) {
          if (envText.includes('ALERT_EMAIL_TO=')) {
            envText = envText.replace(/ALERT_EMAIL_TO=.*/, `ALERT_EMAIL_TO=${inputVal}`);
          } else {
            envText += `\nALERT_EMAIL_TO=${inputVal}\n`;
          }
        } else if (inputVal.length >= 20) {
          if (envText.includes('COMPOSIO_API_KEY=')) {
            envText = envText.replace(/COMPOSIO_API_KEY=.*/, `COMPOSIO_API_KEY=${inputVal}`);
          } else {
            envText += `\nCOMPOSIO_API_KEY=${inputVal}\n`;
          }
        } else {
          if (envText.includes('GMAIL_APP_PASSWORD=')) {
            envText = envText.replace(/GMAIL_APP_PASSWORD=.*/, `GMAIL_APP_PASSWORD=${inputVal}`);
          } else {
            envText += `\nGMAIL_APP_PASSWORD=${inputVal}\n`;
          }
        }
        fs.writeFileSync(ENV_FILE, envText, 'utf8');
        saveState(state);
      }
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    const pos = state.openPosition;
    const spot = loadSpotPortfolioSummary();
    const cfg = loadEnv();
    const rawPass = (cfg.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const emailConfigured = Boolean((rawPass && !rawPass.includes('@')) || cfg.COMPOSIO_API_KEY);
    const spotVaultTry = toTL(state.spotVaultUsdt || 0);
    const combinedEquityTry = Number(
      (toTL(state.totalEquityUsdt) + spotVaultTry + (spot ? spot.totalEquityTry : 0)).toFixed(2)
    );
    const mobileUrl = `http://${lanIp}:${DASHBOARD_PORT}`;
    const activeLev = pos?.leverage || state.leverage || LEVERAGE;

    const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#080c14" />
  <meta http-equiv="refresh" content="6" />
  <title>⚡ Mobil Komuta Merkezi (300 TL Anti-İğne Kaldıraç + Otomatik Spot Kâr Kasası)</title>
  <style>
    * { box-sizing:border-box; }
    body { background:#080c14; color:#f1f5f9; font-family:system-ui,-apple-system,sans-serif; margin:0; padding:14px; max-width:1100px; margin-inline:auto; }
    .topbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px; background:#0f172a; border:1px solid #1e293b; border-radius:16px; padding:14px 16px; margin-bottom:14px; }
    .title { font-size:18px; font-weight:800; letter-spacing:-0.3px; }
    .sub { font-size:12px; color:#94a3b8; margin-top:3px; }
    .pill { background:#1e293b; border:1px solid #334155; color:#38bdf8; padding:6px 10px; border-radius:10px; font-size:12px; font-family:monospace; font-weight:700; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:10px; margin-bottom:14px; }
    .card { background:#0f172a; border:1px solid #1e293b; border-radius:14px; padding:13px; }
    .lbl { font-size:11.5px; color:#94a3b8; font-weight:600; text-transform:uppercase; }
    .val { font-size:21px; font-weight:800; margin-top:5px; font-family:monospace; }
    .green { color:#10b981; } .red { color:#f43f5e; } .amber { color:#f59e0b; } .cyan { color:#38bdf8; }
    .section-card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; padding:14px; margin-bottom:14px; overflow-x:auto; }
    h3 { margin:0 0 10px 0; font-size:15px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; }
    table { width:100%; border-collapse:collapse; min-width:520px; }
    th, td { padding:9px 10px; border-bottom:1px solid #1e293b; text-align:left; font-size:12.5px; }
    th { color:#94a3b8; font-weight:600; background:#131c31; }
    .badge { padding:3px 7px; border-radius:6px; font-weight:700; font-size:11px; display:inline-block; }
    .long { background:#064e3b; color:#34d399; } .short { background:#7f1d1d; color:#fca5a5; }
    .pos-box { background:#131c31; border:1px solid #2dd4bf44; border-radius:12px; padding:12px; margin-bottom:10px; }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <div class="title">⚡ Yırtıcı Konsey v8.5 — 300 TL Anti-İğne Kaldıraç (3x–4x) + Otomatik Spot Kâr Kasası</div>
      <div class="sub">Kaldıraçta Max 300 TL İle Oynar (900-1.200 TL Güç) + Kârları Otomatik Spot Cüzdana Atar + Doğrudan Mail/WhatsApp</div>
    </div>
    <div class="pill">📱 Telefon Wi-Fi: ${mobileUrl}</div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="lbl">⚡ Kaldıraç Kasası (Max 300 TL)</div>
      <div class="val ${state.totalPnlUsdt >= 0 ? 'green' : 'red'}">${toTL(state.totalEquityUsdt)} TL</div>
      <div class="sub">Tavan: 300.00 TL (3x-4x Güç: ${toTL(state.totalEquityUsdt * activeLev)}-${toTL(state.totalEquityUsdt * MAX_CONVICTION_LEVERAGE)} TL)</div>
    </div>
    <div class="card" style="border-color:#10b98166;">
      <div class="lbl">🏦 Spot'a Atılan Kâr Kasası</div>
      <div class="val green">+${spotVaultTry} TL</div>
      <div class="sub">Kaldıraçtan Spot'a Aktarılan Dokunulmaz Kâr</div>
    </div>
    <div class="card">
      <div class="lbl">💰 1.000 TL Spot Kasa</div>
      <div class="val ${spot && spot.totalPnlTry >= 0 ? 'green' : 'cyan'}">${spot ? spot.totalEquityTry : '992.13'} TL</div>
      <div class="sub">Nakit: ${spot ? spot.cashTry : '934.59'} TL | ${spot ? spot.winCount : 21}W/${spot ? spot.lossCount : 17}L</div>
    </div>
    <div class="card">
      <div class="lbl">🏛️ Toplam Birleşik Varlık</div>
      <div class="val amber">${combinedEquityTry} TL</div>
      <div class="sub">📲 WhatsApp & Doğrudan Mail Aktif</div>
    </div>
  </div>

  <div class="section-card">
    <h3><span>🔥 1. Açık Kaldıraçlı İşlem (Sadece Max 300 TL İle Oynar — 3x / 3.5x / 4x Anti-İğne)</span><span class="sub">${state.winCount} Kazanç / ${state.lossCount} Stop</span></h3>
    ${
      !pos
        ? '<div class="sub">Şu an açık vadeli işlem yok — 100+ Yüksek Hızlı Kontrat içinde Skor >= 78/99 olan LONG veya SHORT avlanıyor.</div>'
        : `<div class="pos-box">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div><b style="font-size:16px;">${pos.symbol}USDT</b> <span class="badge ${pos.side === 'LONG' ? 'long' : 'short'}">${pos.leverage || LEVERAGE}x ${pos.side}</span></div>
              <div class="${pos.unrealizedPnlTry >= 0 ? 'green' : 'red'}" style="font-size:17px;font-weight:800;font-family:monospace;">
                ${pos.unrealizedPnlTry >= 0 ? '+' : ''}${pos.unrealizedPnlTry} TL (ROE %${pos.roePct})
              </div>
            </div>
            <div style="font-size:12.5px;color:#cbd5e1;margin-bottom:6px;">
              Teminat: <b>${pos.marginTry} TL</b> (${pos.leverage || LEVERAGE}x Büyüklük: <b>${pos.notionalTry} TL</b>) | Giriş: <b>$${pos.entryPrice}</b> -> Güncel: <b>$${pos.currentPrice}</b>
            </div>
            <div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">
              🛑 Stop: <b>$${pos.stopPrice}</b> | 💰 TP1 (%35 Cebellezi): <b>${pos.tp1Done ? 'ALINDI ✅' : '+%1.25'}</b> | 🎯 Hedef: <b>$${pos.tpPrice}</b> | 💀 Likidasyon: <b>$${pos.liqPrice}</b>
            </div>
            <div style="font-size:12px;color:#38bdf8;">${pos.thesis}</div>
          </div>`
    }
  </div>

  <div class="section-card">
    <h3>
      <span>📧 2. Hangi Coinden Ne Kadar Kazandım & Spot Cüzdana Ne Kadar Atıldı?</span>
      <span class="sub">Toplam Spot'a Atılan: <b class="green">+${spotVaultTry} TL</b> | Doğrudan Mail: <b>${cfg.ALERT_EMAIL_TO || 'berkeakdemir5855@gmail.com'}</b></span>
    </h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;background:#131c31;padding:10px;border-radius:10px;align-items:center;justify-content:space-between;">
      <span style="font-size:12px;color:#cbd5e1;">📧 <b>berkeakdemir5855@gmail.com</b> doğrudan mail + 📲 WhatsApp (+905301613459) + 🏦 Spot Kâr Sifonu <b>AKTİF</b>!</span>
      <a href="/api/test-email" style="background:#38bdf8;color:#080c14;text-decoration:none;padding:6px 12px;border-radius:8px;font-weight:800;font-size:12px;">📨 Şimdi Mailime Gönder</a>
    </div>
    <table>
      <tr><th>Tarih / Saat</th><th>Kazandıran Coin</th><th>İşlem Türü</th><th>Net Kazanç (TL & ROE)</th><th>🏦 Spot Cüzdana Atılan</th><th>Giriş -> Çıkış</th><th>Durum</th></tr>
      ${(state.profitMails || [])
        .map(
          m => `<tr>
          <td>${m.time}</td>
          <td><b>${m.symbol}</b> <span class="badge ${m.side === 'LONG' ? 'long' : 'short'}">${m.leverage}x ${m.side}</span></td>
          <td>${m.type}</td>
          <td class="green"><b>+${m.netPnlTry} TL (+%${m.roePct})</b></td>
          <td class="green"><b>🏦 +${m.spotTransferTry !== undefined ? m.spotTransferTry : m.netPnlTry} TL</b></td>
          <td>$${m.entryPrice} -> $${m.exitPrice}</td>
          <td>${m.deliveryStatus}</td>
        </tr>`
        )
        .join('')}
    </table>
  </div>

  <div class="section-card">
    <h3><span>💰 3. Açık Spot İşlemler (1.000 TL Binance TR Kasası)</span><span class="sub">Port 3847 Senkronize</span></h3>
    ${
      !spot || !spot.openPositions || spot.openPositions.length === 0
        ? `<div class="sub">${spot?.noBuyShort || 'Şu an açık spot işlem yok — 14 haber kaynağı ve Binance TR tahtası taranıyor.'}</div>`
        : spot.openPositions
            .map(
              p => `<div class="pos-box">
              <b>${p.symbol}_TRY</b> | Yatırılan: ${p.costTry} TL | Net Kâr: <b class="${p.pnlTry >= 0 ? 'green' : 'red'}">${p.pnlTry >= 0 ? '+' : ''}${p.pnlTry} TL (%${p.pnlPct})</b> | Stop: $${p.stopPrice} | Hedef: $${p.tpPrice}
            </div>`
            )
            .join('')
    }
  </div>

  <div class="section-card">
    <h3><span>📡 4. Canlı Yüksek Hızlı Vadeli Radar (100+ Kontrat İçinden En Güçlü 8 Aday)</span></h3>
    <table>
      <tr><th>Kontrat</th><th>Yön, Skor & Kaldıraç</th><th>Fonlama</th><th>Balina Makası</th><th>OI (1s)</th><th>16 Katmanlı Yırtıcı Konsey Tezi</th></tr>
      ${(state.topCandidates || [])
        .map(
          c => `<tr>
          <td><b>${c.symbol}USDT</b></td>
          <td><b>${c.side}</b> (${c.score}/99 -> <b>${c.convictionLeverage || 3}x</b>)</td>
          <td class="${c.fundingRatePct < 0 ? 'green' : c.fundingRatePct > 0.02 ? 'red' : ''}">%${c.fundingRatePct}</td>
          <td class="${c.whaleRetailSpread >= 4 ? 'green' : c.whaleRetailSpread <= -4 ? 'red' : ''}"><b>${c.whaleRetailSpread >= 0 ? '+' : ''}%${c.whaleRetailSpread}</b> (${c.whaleLongPct}L/${c.retailLongPct}L)</td>
          <td>%${c.oiDelta1hPct}</td>
          <td>${c.thesis}</td>
        </tr>`
        )
        .join('')}
    </table>
  </div>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.on('error', () => {});
  // Bind to 0.0.0.0 so both localhost (PC) and 192.168.x.x (Mobile Phone on Wi-Fi) can connect!
  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    console.log(`🌐 300 TL (3x-4x Anti-İğne Kaldıraç) & Spot Kâr Kasalı Mobil Panel Aktif:`);
    console.log(`   💻 Bilgisayar: http://localhost:${DASHBOARD_PORT}`);
    console.log(`   📱 Telefon (Aynı Wi-Fi): http://${lanIp}:${DASHBOARD_PORT}`);
  });
}

async function runCycle(state) {
  if (isPositionCycleBusy && Date.now() - busySinceMs < 25000) return;
  isPositionCycleBusy = true;
  busySinceMs = Date.now();
  try {
    const candidates = await scanPerpUniverse(state);
    await manageOpenPosition(state, candidates);
    await tryOpenPosition(state, candidates);
    updateAccountingAndReport(state);
  } finally {
    isPositionCycleBusy = false;
  }
}

async function main() {
  loadEnv();
  const isDaemon = process.argv.includes('--daemon');
  const state = loadState();
  state.version = 'Mutlak-Yapi-v8.5-300TL-LowRisk-SpotVault';
  console.log('================================================================================');
  console.log(`⚡ 300 TL SABİT ANA PARA (3x–4x ANTİ-İĞNE KALDIRAÇ) + SPOT CÜZDAN KÂR SİFONU (v8.5)`);
  console.log(`   Max Ana Para: ${toTL(state.initialBankrollUsdt)} TL | Aktif Kasa: ${toTL(state.totalEquityUsdt)} TL | Spot Kâr Kasası: +${toTL(state.spotVaultUsdt || 0)} TL`);
  console.log('================================================================================');

  await runCycle(state);
  if (!isDaemon) return;

  startDashboardServer(state);
  setInterval(async () => {
    if (isPositionCycleBusy && Date.now() - busySinceMs < 25000) return;
    isPositionCycleBusy = true;
    busySinceMs = Date.now();
    try {
      if (state.openPosition) {
        await manageOpenPosition(state, state.topCandidates || []);
        updateAccountingAndReport(state);
      }
    } catch {
      // ignore transient network error
    } finally {
      isPositionCycleBusy = false;
    }
  }, 4000);

  setInterval(async () => {
    try {
      await runCycle(state);
    } catch {
      // ignore transient network error
    }
  }, 30000);
}

main();
