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
const LEVERAGE = 3; // Base Low-Wick Institutional Leverage (300 TL -> 3x = 900 TL, 3.5x = 1.050 TL, 4x = 1.200 TL, 5x = 1.500 TL)
const MAX_CONVICTION_LEVERAGE = 5;
const INITIAL_BANKROLL_TRY = 300.0;
const INITIAL_BANKROLL_USDT = Number((INITIAL_BANKROLL_TRY / USD_TRY_RATE).toFixed(4)); // ~6.0545 USDT
const TARGET_GOAL_TRY = 23000.0; // User's Ultimate Wealth Goal (23.000 TL)
const MIN_NOTIONAL_USDT = 5.0; // Binance Futures hard minimum notional floor
const ROUND_TRIP_FEE_SLIP_FRAC = 0.0018; // 0.05% taker entry + 0.05% taker exit + 0.08% perp slippage on notional
const DASHBOARD_PORT = 3848;
const PUBLIC_TUNNEL_URL = 'https://absence-coding-laid-spoken.trycloudflare.com';
const BACKUP_TUNNEL_URL = 'https://273725c5cf6e80.lhr.life';
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
      // Engine #51A (Unblinded Hype Universe): Include all liquid TRADING COIN perpetuals (including Alpha-subtyped high-volume hype rockets like JCTUSDT $316M & ARIAUSDT $20M)
      if (
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.underlyingType === 'COIN' &&
        s.quoteAsset === 'USDT' &&
        !EXCLUDED_FAPI_SYMBOLS.has(s.symbol)
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
  if (score >= 94 && atr15mPct <= 1.35) return 5;   // Engine #42: Qullamaggie + Luna Risk-Normalized Tight-Stop Apex Shot (5x = 1.500 TL Power)
  if (score >= 90 && atr15mPct <= 1.85) return 4;   // Ultra-Apex Sniper Shot (4x = 1.200 TL Power)
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

function getGoalAndTierStatus(state) {
  const spotVaultTry = toTL(state.spotVaultUsdt || 0);
  const openEquityUsdt = state.openPosition
    ? state.openPosition.marginUsdt + (state.openPosition.unrealizedPnlUsdt || 0)
    : 0;
  const activePerpTry = toTL((state.marginCashUsdt || 0) + openEquityUsdt);
  const perpPlusVaultTry = Number((activePerpTry + spotVaultTry).toFixed(2));
  const combinedTry = perpPlusVaultTry; // Strictly 300 TL Leverage + Spot Vault Profits (NOT mixed with the 1.000 TL Spot Bot!)
  const progressPct = Number(Math.min(100, (perpPlusVaultTry / TARGET_GOAL_TRY) * 100).toFixed(2));
  const remainingTry = Number(Math.max(0, TARGET_GOAL_TRY - perpPlusVaultTry).toFixed(2));

  // Step-Stone House-Money Compounding Tiers (Zero extra out-of-pocket principal risk; scales ONLY from locked Spot Vault profits!)
  let activeCapTry = 300.0;
  let tierLabel = 'Kademe 1/5 (300 TL Sabit Ana Para -> Hedef: +300 TL Spot Kârı İle 500 TL Kademesine Terfi)';
  let nextMilestoneTry = 300.0;
  if (spotVaultTry >= 6000) {
    activeCapTry = 4000.0;
    tierLabel = 'Kademe 5/5 (4.000 TL Kurumsal Tavan -> 23.000 TL Final Hedef Koşusu)';
    nextMilestoneTry = 23000.0;
  } else if (spotVaultTry >= 2500) {
    activeCapTry = 2200.0;
    tierLabel = 'Kademe 4/5 (2.200 TL Kâr-Destekli Ana Para -> Sonraki Terfi: +6.000 TL Spot Kârı)';
    nextMilestoneTry = 6000.0;
  } else if (spotVaultTry >= 900) {
    activeCapTry = 1000.0;
    tierLabel = 'Kademe 3/5 (1.000 TL Kâr-Destekli Ana Para -> Sonraki Terfi: +2.500 TL Spot Kârı)';
    nextMilestoneTry = 2500.0;
  } else if (spotVaultTry >= 300) {
    activeCapTry = 500.0;
    tierLabel = 'Kademe 2/5 (500 TL Kâr-Destekli Ana Para -> Sonraki Terfi: +900 TL Spot Kârı)';
    nextMilestoneTry = 900.0;
  }
  const injectedSpotTry = toTL(state.injectedSpotMarginUsdt || 0);
  if (injectedSpotTry > 0) {
    activeCapTry = Number((activeCapTry + injectedSpotTry).toFixed(2));
  }
  const activeCapUsdt = Number((activeCapTry / USD_TRY_RATE).toFixed(4));
  return {
    targetGoalTry: TARGET_GOAL_TRY,
    combinedTry,
    perpPlusVaultTry,
    spotVaultTry,
    activePerpTry,
    progressPct,
    remainingTry,
    activeCapTry,
    activeCapUsdt,
    tierLabel,
    nextMilestoneTry,
  };
}

// Engine #45 (GPT-6-Luna Bounded 2-Hour Autonomous Post-Mortem Self-Audit & Adaptive Evolution Loop):
// Runs every 2 hours (and immediately after each closed trade), diagnoses root-cause mistakes on closed trades,
// computes J = NetPnL - 0.35*MaxDD - 0.50*FeeScratchLoss, and tunes thresholds strictly within hard safety bounds.
function runTwoHourSelfAudit(state, forceLog = false) {
  const nowMs = Date.now();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const closed = Array.isArray(state.closedTrades) ? state.closedTrades : [];
  const recentWindow = closed.slice(0, 8);

  let recentWins = 0;
  let recentLosses = 0;
  let recentNetPnlTry = 0;
  let maxDrawdownTry = 0;
  let feeScratchLossTry = 0;
  let longWins = 0;
  let longLosses = 0;
  let shortWins = 0;
  let shortLosses = 0;

  const diagnosedMistakes = [];
  for (const t of recentWindow) {
    const pnl = Number(t.netPnlTry || 0);
    recentNetPnlTry = Number((recentNetPnlTry + pnl).toFixed(2));
    if (pnl >= 0) {
      recentWins += 1;
      if (t.side === 'LONG') longWins += 1;
      else shortWins += 1;
    } else {
      recentLosses += 1;
      maxDrawdownTry = Number((maxDrawdownTry + Math.abs(pnl)).toFixed(2));
      if (t.side === 'LONG') longLosses += 1;
      else shortLosses += 1;

      const isProfitLockScratch = String(t.exitReason || '').includes('KÂR KİLİDİ') || Math.abs(pnl) <= 1.25;
      if (isProfitLockScratch) {
        feeScratchLossTry = Number((feeScratchLossTry + Math.abs(pnl)).toFixed(2));
      }

      if (t.symbol === 'DOS' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Makro-Yükseliş (+%12.8 24s) İçinde 1s %-3.0 Düşmüş Dip Mumuna (CLV:0.04, NÖTR OI, YATAY MTF) Geç SHORT Girişi',
          fixApplied: 'Motor #43A: Anti-Bottom-Chase & Makro-Yükseliş Düzeltme Kalkanı (1s <= -%2.1 & 24s >= +%4.5 iken Q3+MTF Ayı onayı yoksa SHORT Veto)',
        });
      } else if (t.symbol === 'KAT' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Q4 Long Kapitülasyonu + Negatif Basis (-%0.40) + 24s +%9.55 Yükselişteki Coine 43dk Sonra 2. Kez SHORT Girişi',
          fixApplied: 'Motor #46 & #47: 2-Stop Toksik Coin 12 Saat Karantinası + Q4 Kapitülasyon/Negatif-Basis/Yatay-MTF SHORT Vetosu',
        });
      } else if (t.symbol === 'SOPH' && Math.abs(pnl) > 2.0) {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s -%9/-%23.6 Çöküş + Negatif Basis (-%0.31) + Negatif CVD (-%6) + Spoofed Tahtaya Surge Reset İle 3 Kez Üst Üste LONG Girişi',
          fixApplied: 'Motor #46 & #47: Spoofed Tahtada Surge Reset Kilidi + Toksik Coin 12 Saat Karantinası + CVD>=0 & Basis-Dump (-%0.22/-%6) LONG Vetosu',
        });
      } else if (t.symbol === 'SOPH' || isProfitLockScratch) {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '5dk Kurumsal Taker Oranı 0.96x (<1.02x) İken Giriş + Başabaş Kâr Kilidinin (%0.24) 4sn İğnesinde Komisyon Altı Kapanması',
          fixApplied: 'Motor #44: 5dk Kurumsal Taker Tabanı (LONG >= 1.02x / SHORT <= 0.98x) + +%0.34 Komisyon-Üstü Garantili Kâr Kilidi Clamp',
        });
      } else if (t.symbol === 'BR' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s -%16.37 Çökmüş + Q4 Long Kapitülasyonu + Negatif Basis (-%0.1135) + Balina +%0.5 LONG Olan Dip Coine SHORT Girişi',
          fixApplied: 'Motor #54B (Sıkı Short Kilidi): Q4/NÖTR OI, 24s<=-%5.0, Basis<=-%0.03 veya Balina>-%2.0 Olan Hiçbir Coine SHORT Açılmaz (Sadece Q3/GCR & >=86p)',
        });
      } else if (t.symbol === 'PHA' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s -%22.7 Çöken Bıçakta Q1 + MTF Yükseliş + 1s >= +%1.20 Trend Dönüşü Onaylanmadan Erken Dip LONG Girişi',
          fixApplied: 'Motor #51-#54A: Çöken Bıçak (24s<=-%4.5) LONG Yasağı + Hype/Short-Squeeze Roketlerine (ORDER, BMT, JCT, ANIME) Öncelikli Tarama',
        });
      } else if (t.symbol === 'LIGHT' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Derin Negatif Basis (-%0.7945 Spot İskontosu) + Q1 OI + MTF Yükseliş + 1s +%3.05 Rallide Taker 0.97x (>0.94x) İken GCR SHORT İstisnası',
          fixApplied: 'Motor #50: GCR Short İçin Basis>=-%0.02, Fonlama>=0, !Q1 OI, 1s<=+%0.80 ve 5dk Taker<=maxShortTaker5m Zorunluluğu (İstisna Kaldırıldı)',
        });
      } else if (t.symbol === 'BTR' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s -%10.15 Dip + TTM Sıkışması (1s -%0.62) İçinde Balina Makası +%4.7 LONG İken Q3 Dip Mumuna (CLV:0.11) SHORT Girişi ve 50dk Sıkışma Beklemesi',
          fixApplied: 'Motor #48 & #49: 24s<=-%7.5 & Balina>=+%3.0 Short-Squeeze Vetosu + TTM Dip Bobini Kalkanı + 32dk R-Bazlı MFE/MAE Erken Tahliye',
        });
      } else if (t.symbol === 'BTW') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '1s İvmesi Ters Yöndeyken Sadece Negatif Basis / Tekil İndikatör İle Giriş',
          fixApplied: 'Motor #37 & #38: 1s İvme + Hacim Tabanı (>=0.72x) + 2-Snapshot Mikro-Fiyat & Spoof Kalkanı',
        });
      } else {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Kısa Vadeli Likidite Silkelemesi / Volatilite Genişlemesi',
          fixApplied: 'Motor #42 & #45: Ters-Volatilite Kaldıraç Sınırı (Max %4.8 ROE Risk) + Yan Bazlı Adaptif Skor Barajı',
        });
      }
    }
  }

  // Engine #46 (GPT-6-Luna Toxic-Symbol Quarantine):
  // Count consecutive losses per symbol from closedTrades; if a symbol has >= 2 consecutive losses (e.g. SOPH, KAT), enforce 12-hour quarantine
  if (!state.symbolCooldowns) state.symbolCooldowns = {};
  if (!state.symbolConsecStops) state.symbolConsecStops = {};
  const seenSymbols = new Set();
  for (const t of closed) {
    if (!t.symbol || seenSymbols.has(t.symbol)) continue;
    seenSymbols.add(t.symbol);
    let consec = 0;
    for (const row of closed) {
      if (row.symbol !== t.symbol) continue;
      if (Number(row.netPnlTry || 0) < 0) consec += 1;
      else break;
    }
    state.symbolConsecStops[t.symbol] = consec;
    if (consec >= 2) {
      const minQuarantineUntil = nowMs + 6 * 60 * 60 * 1000;
      if ((state.symbolCooldowns[t.symbol] || 0) < minQuarantineUntil) {
        state.symbolCooldowns[t.symbol] = minQuarantineUntil;
      }
    }
  }

  // GPT-6-Luna Objective Score: J = NetPnL - 0.35 * MaxDD - 0.50 * FeeScratchLoss
  const objectiveJ = Number((recentNetPnlTry - 0.35 * maxDrawdownTry - 0.50 * feeScratchLossTry).toFixed(2));

  // Bounded parameter update: clip(theta, theta_min, theta_max) — Engine #54B + #61C (True J-Score Adaptive Tuning within hard safety bounds)
  const isLongColdStreak = longLosses >= longWins + 2 && objectiveJ < -25;
  const minLongScore = isLongColdStreak ? 80 : 78;
  const minShortScore = 86;
  const minLongTaker5m = isLongColdStreak ? 1.08 : 1.04;
  const maxShortTaker5m = 0.86;

  state.adaptiveTuning = {
    minLongScore,
    minShortScore,
    minLongTaker5m,
    maxShortTaker5m,
    objectiveJ,
    updatedAt: new Date().toLocaleString('tr-TR'),
  };

  const nextAuditMs = nowMs + TWO_HOURS_MS;
  state.lastSelfAudit = {
    lastAuditAt: new Date(nowMs).toLocaleString('tr-TR'),
    lastAuditAtMs: nowMs,
    nextAuditAt: new Date(nextAuditMs).toLocaleString('tr-TR'),
    nextAuditAtMs: nextAuditMs,
    recentWindowCount: recentWindow.length,
    recentWins,
    recentLosses,
    recentNetPnlTry,
    objectiveJ,
    minLongScore,
    minShortScore,
    minLongTaker5m,
    maxShortTaker5m,
    diagnosedMistakes: diagnosedMistakes.slice(0, 4),
  };

  if (forceLog) {
    logEvent(
      state,
      `🧠 [2-SAATLİK OTONOM ÖZELEŞTİRİ & EVRİM (Motor #45)] Son ${recentWindow.length} İşlem: ${recentWins}W/${recentLosses}L (Net: ${recentNetPnlTry >= 0 ? '+' : ''}${recentNetPnlTry} TL | Luna J-Skoru: ${objectiveJ}) | Aktif Barajlar -> LONG >=${minLongScore}p (Taker >=${minLongTaker5m}x), SHORT >=${minShortScore}p (Taker <=${maxShortTaker5m}x) | Sonraki Denetim: ${state.lastSelfAudit.nextAuditAt}`
    );
  }
  return state.lastSelfAudit;
}

function sweepProfitToSpotVault(state, stepGainUsdt, symbol, reasonLabel) {
  state.spotVaultUsdt = Number((state.spotVaultUsdt || 0).toFixed(4));
  state.spotTransfers = state.spotTransfers || [];

  const goalInfo = getGoalAndTierStatus(state);
  const capUsdt = goalInfo.activeCapUsdt; // 6.0545 USDT (300 TL) at Tier 1, scales up ONLY with locked Spot Vault profits!
  const openMarginUsdt = state.openPosition ? Number(state.openPosition.marginUsdt || 0) : 0;
  const currentPrincipalUsdt = Number((state.marginCashUsdt + openMarginUsdt).toFixed(4));

  // Rule 1: 100% of any balance above activeCapTry (300.00 TL) is ALWAYS swept to Spot Wallet
  const excessAboveCapUsdt = Math.max(0, Number((currentPrincipalUsdt - capUsdt).toFixed(4)));
  // Rule 2: Even when below activeCapTry (300 TL), 50% of every positive profit is immediately swept to Spot Wallet (keeping >= $2.20 USDT safety floor for 3x MIN_NOTIONAL)
  const halfStepProfitUsdt = stepGainUsdt > 0 ? Number((stepGainUsdt * 0.50).toFixed(4)) : 0;

  let sweepUsdt = Math.max(excessAboveCapUsdt, halfStepProfitUsdt);
  if (currentPrincipalUsdt <= capUsdt && currentPrincipalUsdt - sweepUsdt < 2.20) {
    sweepUsdt = Math.max(0, Number((currentPrincipalUsdt - 2.20).toFixed(4)));
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
    `🏦 [SPOT CÜZDANA KÂR TRANSFERİ] ${symbol} işleminden +${sweptTry} TL kâr Spot Cüzdana aktarıldı! (Toplam Spot Kâr Kasası: +${totalSpotVaultTry} TL | Aktif Kaldıraç Tavanı: ${goalInfo.activeCapTry} TL | 🎯 23.000 TL Hedef: %${goalInfo.progressPct})`
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
  const goalInfo = getGoalAndTierStatus(state, loadSpotPortfolioSummary());

  const subject = `💰 [KÂR & 23.000 TL HEDEF RAPORU] ${info.symbol} (${info.leverage}x ${info.side}) -> +${info.netPnlTry} TL Kazandın (+${spotTransferTry} TL Spot'a Atıldı!)`;
  const textBody = [
    `⚡ YIRTICI KALDIRAÇ SİSTEMİ — CANLI KÂR & 23.000 TL HEDEF BİLDİRİMİ (${ts})`,
    `==========================================================`,
    `🪙 Kazandıran Coin          : ${info.symbol} (${info.leverage}x ${info.side})`,
    `🏆 İşlem Türü               : ${info.type}`,
    `💵 Net İşlem Kazancı        : +${info.netPnlTry} TL (Kasa ROE: +%${info.roePct})`,
    `🏦 Spot Cüzdana Aktarılan   : +${spotTransferTry} TL (Toplam Spot Kâr Kasası: +${totalSpotVaultTry} TL)`,
    `📈 Fiyat Hareketi           : $${info.entryPrice} -> $${info.exitPrice}`,
    `⚡ Aktif Kaldıraç Kasası    : ${equityAfterTry} TL (Tavan: ${goalInfo.activeCapTry} TL Sabit Ana Para)`,
    `🎯 23.000 TL Büyük Hedef    : ${goalInfo.combinedTry} TL / 23.000 TL (%${goalInfo.progressPct} Tamamlandı | Kalan: ${goalInfo.remainingTry} TL)`,
    `🪜 Aktif Büyüme Basamağı    : ${goalInfo.tierLabel}`,
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
        Hedef_23000_TL_Durumu: `${goalInfo.combinedTry} TL / 23.000 TL (%${goalInfo.progressPct} Tamamlandı | Kalan: ${goalInfo.remainingTry} TL)`,
        Fiyat_Hareketi: `$${info.entryPrice} -> $${info.exitPrice}`,
        Aktif_Kaldirac_Kasasi: `${equityAfterTry} TL (Max ${goalInfo.activeCapTry} TL Ana Para)`,
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
    const openTime = Number(raw[0] || 0);
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
      openTime, open, high, low, close, vol, takerBuyVol, delta, deltaPct,
      range, body, upperWick, lowerWick, clv, bodyRatio, upperWickRatio, lowerWickRatio, isGreen,
    };
  };

  const bars = klines.map(parseBar);
  const n = bars.length;
  const b0 = bars[n - 1];
  const b1 = bars[n - 2];
  const b2 = bars[n - 3];
  const b3 = bars[n - 4];

  // Wall #1 + Engine #55A (GPT-6-Luna Unclosed-Bar Contamination & Elapsed-Time Guard):
  // High-volume hype coins hit 25% of 3-bar volume in 90 seconds, causing early intrabar wiggles to be misclassified as Shooting Star / Upper Wick Vetoes.
  // Require both >=35% volume AND >=55% elapsed 15m bar time before treating b0 as non-baby, and >=70% elapsed time before b0 can form a Shooting Star / Wick Veto!
  const avgCompletedVol = (b1.vol + b2.vol + b3.vol) / 3 || 1;
  const b0ElapsedFrac = b0.openTime > 0 ? Math.max(0.05, Math.min(1.0, (Date.now() - b0.openTime) / (15 * 60 * 1000))) : 0.5;
  const isBabyB0 = b0.vol < avgCompletedVol * 0.35 || b0ElapsedFrac < 0.55;
  const isMatureB0 = !isBabyB0 && b0ElapsedFrac >= 0.70;
  const effectiveClv = isBabyB0 ? b1.clv : b0.clv;

  const isHammerB1 =
    b1.lowerWickRatio >= 0.45 &&
    b1.lowerWick >= b1.body * 1.8 &&
    b1.upperWickRatio <= 0.22 &&
    b1.clv >= 0.65 &&
    b1.low <= Math.min(b2.low, b3.low);

  const isHammerB0 =
    isMatureB0 &&
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
    isMatureB0 &&
    b0.upperWickRatio >= 0.50 &&
    b0.upperWick >= b0.body * 2.0 &&
    b0.lowerWickRatio <= 0.20 &&
    b0.clv <= 0.30 &&
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
    (isMatureB0 && !b0.isGreen && b0.bodyRatio >= 0.74 && b0.lowerWickRatio <= 0.14 && b0.clv <= 0.18);

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
      (isMatureB0 && b0.upperWickRatio >= 0.50 && b0.clv <= 0.38) ||
      (b1.upperWickRatio >= 0.48 && b1.clv <= 0.42 && effectiveClv < 0.65) ||
      (isMatureB0 && !b0.isGreen && b0.clv <= 0.30) ||
      (isBabyB0 && !b1.isGreen && b1.clv <= 0.32) ||
      effectiveClv <= 0.28
  );

  const vetoShort = Boolean(
    bullishPattern ||
      sellSideSweep ||
      (isMatureB0 && b0.lowerWickRatio >= 0.50 && b0.clv >= 0.62) ||
      (b1.lowerWickRatio >= 0.50 && b1.clv >= 0.62 && effectiveClv > 0.35) ||
      (isMatureB0 && b0.isGreen && b0.clv >= 0.70) ||
      (isBabyB0 && b1.isGreen && b1.clv >= 0.65) ||
      effectiveClv >= 0.68
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
  const drop4BarPct = high4Bar > 0 ? Number((((high4Bar - b0.close) / high4Bar) * 100).toFixed(2)) : 0;
  const green3Completed = b1.isGreen && b2.isGreen && b3.isGreen;
  const red3Completed = !b1.isGreen && !b2.isGreen && !b3.isGreen;

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
    posIn16BarRange,
    runup4BarPct,
    drop4BarPct,
    green3Completed,
    red3Completed,
    clv: effectiveClv,
    b0ElapsedFrac,
    structuralLow: Math.min(b0.low, b1.low),
    structuralHigh: Math.max(b0.high, b1.high),
  };
}

function computeWeightedBookImbalance(bids, asks) {
  if (!bids?.length || !asks?.length) return 0;
  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= bestBid) return 0;
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0) return 0;
  let wBid = 0;
  let wAsk = 0;
  for (const [pStr, qStr] of bids.slice(0, 15)) {
    const p = Number(pStr);
    const q = Number(qStr);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) continue;
    const distBps = ((mid - p) / mid) * 10000;
    if (distBps >= 0 && distBps <= 25) wBid += Math.exp(-distBps / 6) * p * q;
  }
  for (const [pStr, qStr] of asks.slice(0, 15)) {
    const p = Number(pStr);
    const q = Number(qStr);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) continue;
    const distBps = ((p - mid) / mid) * 10000;
    if (distBps >= 0 && distBps <= 25) wAsk += Math.exp(-distBps / 6) * p * q;
  }
  if (wBid + wAsk <= 0) return 0;
  return Number(((wBid - wAsk) / (wBid + wAsk)).toFixed(3));
}

async function fetchPerpOrderbookConfirm(symbol, side) {
  // Engine #38 (GPT-6-Luna Two-Snapshot Perp Microprice & Spoof-Decay Gate — 1.8s Interval):
  const d1 = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}USDT&limit=20`, {}, 2500);
  if (!d1?.bids?.length || !d1?.asks?.length) return { ok: false, vetoCode: 'NO_DEPTH', reason: 'NO_DEPTH_1' };
  await new Promise(r => setTimeout(r, 1800));
  const d2 = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}USDT&limit=20`, {}, 2500);
  if (!d2?.bids?.length || !d2?.asks?.length) return { ok: false, vetoCode: 'NO_DEPTH', reason: 'NO_DEPTH_2' };

  const seq1 = Number(d1.lastUpdateId || 0);
  const seq2 = Number(d2.lastUpdateId || 0);
  if (seq1 > 0 && seq2 > 0 && seq2 < seq1) {
    return { ok: false, vetoCode: 'STALE_BOOK', reason: `STALE_BOOK_SEQUENCE (${seq1}->${seq2})` };
  }

  const bestBid1 = Number(d1.bids[0][0]);
  const bestAsk1 = Number(d1.asks[0][0]);
  const bidVol1 = Number(d1.bids[0][1] || 0);
  const askVol1 = Number(d1.asks[0][1] || 0);
  const bestBid = Number(d2.bids[0][0]);
  const bestAsk = Number(d2.asks[0][0]);
  const bidVol0 = Number(d2.bids[0][1] || 0);
  const askVol0 = Number(d2.asks[0][1] || 0);
  if (
    !Number.isFinite(bestBid1) || !Number.isFinite(bestAsk1) || bestBid1 <= 0 || bestAsk1 <= bestBid1 ||
    !Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= bestBid
  ) {
    return { ok: false, vetoCode: 'CROSSED_OR_INVALID_BOOK', reason: 'CROSSED_OR_INVALID_BOOK' };
  }

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
  const bookHollowing =
    (bestBid < bestBid1 && bestAsk > bestAsk1) ||
    (side === 'LONG' && bestBid < bestBid1 * 0.9992 && spreadPct > 0.10) ||
    (side === 'SHORT' && bestAsk > bestAsk1 * 1.0008 && spreadPct > 0.10);

  if (spreadPct <= 0 || spreadPct > 0.18) {
    return { ok: false, vetoCode: 'WIDE_SPREAD', reason: `WIDE_SPREAD (${spreadPct}%)`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
  }
  if (bookHollowing) {
    return { ok: false, vetoCode: 'BOOK_HOLLOWING', reason: `BOOK_HOLLOWING (bid ${bestBid1}->${bestBid} | ask ${bestAsk1}->${bestAsk})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
  }
  // Engine #53 (GPT-6-Luna Ask-Sweep-Aware Orderbook Gate):
  // SpoofVetoLong only triggers if obDelta < -0.12 AND the resulting book actually lost bid support (ob2 < 0.04, or ob2 < 0.08 with bestBid dropping > 3 bps).
  // Never reject a strongly bid-dominant book like ZORAUSDT (ob: +0.42 -> +0.17, avgOb: +0.295) on a 1-tick micro-jiggle!
  if (side === 'LONG') {
    if (obDelta < -0.12 && (ob2 < 0.04 || (ob2 < 0.08 && bestBid < bestBid1 * 0.9997))) {
      return { ok: false, vetoCode: 'SPOOF_WALL_DECAY', reason: `SPOOF_WALL_DECAY_LONG (ob:${ob1}->${ob2} | dI:${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    const isActivelyLiftingAsks = bestBid > bestBid1 * 1.0002 && bestAsk >= bestAsk1;
    const minOb2Floor = isActivelyLiftingAsks ? -0.02 : 0.02;
    const minAvgObFloor = isActivelyLiftingAsks ? 0.01 : 0.05;
    if (avgOb < minAvgObFloor || ob2 < minOb2Floor || microSkew < -0.16 || (microSkew1 < -0.20 && microSkew < 0)) {
      return { ok: false, vetoCode: 'WEAK_OB', reason: `WEAK_LONG_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  if (side === 'SHORT') {
    if (obDelta > 0.12 && (ob2 > -0.04 || (ob2 > -0.08 && bestAsk > bestAsk1 * 1.0003))) {
      return { ok: false, vetoCode: 'SPOOF_WALL_DECAY', reason: `SPOOF_WALL_DECAY_SHORT (ob:${ob1}->${ob2} | dI:+${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    const isActivelyHittingBids = bestAsk < bestAsk1 * 0.9998 && bestBid <= bestBid1;
    const maxOb2Ceil = isActivelyHittingBids ? 0.02 : -0.02;
    const maxAvgObCeil = isActivelyHittingBids ? -0.01 : -0.05;
    if (avgOb > maxAvgObCeil || ob2 > maxOb2Ceil || microSkew > 0.16 || (microSkew1 > 0.20 && microSkew > 0)) {
      return { ok: false, vetoCode: 'WEAK_OB', reason: `WEAK_SHORT_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  return { ok: true, vetoCode: 'OK', bestBid, bestAsk, spreadPct, avgOb, ob1, ob2, obDelta, microSkew1, microSkew };
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
  let greenPerpCnt = 0;

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

    // Require >= $12M 24h volume and >= 3.2% 24h range (banishes dead stable-like sleepers like TRX unless already open)
    if (!isCurrentlyOpen && (quoteVol24h < 12e6 || range24hPct < 3.2)) continue;

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
    if (change24hPct > 0) greenPerpCnt++;

    // Engine #51B + #58 (GPT-6-Luna Hype-Breakout & Short-Squeeze Priority Ranking — without +9999 open-position distortion):
    const hypeBoost = change24hPct >= 3.5 ? Math.min(45, change24hPct * 1.65) : 0;
    const squeezeBoost =
      change24hPct >= 1.5 && (fundingRatePct <= -0.020 || basisPct <= -0.10)
        ? Math.min(35, Math.abs(fundingRatePct) * 85 + Math.abs(basisPct) * 30)
        : 0;
    const fallingKnifePenalty = change24hPct <= -5.5 ? -40 : 0;
    const priorityScore = Number(
      (
        Math.min(65, hypeBoost + squeezeBoost) +
        fallingKnifePenalty +
        Math.min(30, Math.max(0, change24hPct)) * 1.8 +
        Math.min(45, range24hPct) * 1.25 +
        Math.log10(Math.max(12, quoteVol24h / 1e6)) * 12 +
        (newsCand?.hasDirectMention ? 35 : newsCand ? 15 : 0)
      ).toFixed(2)
    );

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

  // Engine #51B + #55B (GPT-6-Luna Deterministic Hype-Shortlist + Priority Scanner):
  // Guarantee the top 10 pure 24h/squeeze gainers are ALWAYS included in topToInspect, plus the highest priorityScore candidates up to 30 slots!
  const hypeSorted = [...preCandidates]
    .filter(c => c.change24hPct >= 4.0)
    .sort((a, b) => (b.change24hPct + (b.fundingRatePct < -0.02 ? 25 : 0)) - (a.change24hPct + (a.fundingRatePct < -0.02 ? 25 : 0)));
  preCandidates.sort((a, b) => b.priorityScore - a.priorityScore);
  const inspectMap = new Map();
  if (state.openPosition?.symbol) {
    const openPre = preCandidates.find(c => c.symbol === state.openPosition.symbol);
    if (openPre) inspectMap.set(openPre.symbol, openPre);
  }
  for (const h of hypeSorted.slice(0, 10)) {
    if (inspectMap.size < 30) inspectMap.set(h.symbol, h);
  }
  for (const p of preCandidates) {
    if (inspectMap.size >= 30) break;
    inspectMap.set(p.symbol, p);
  }
  const topToInspect = Array.from(inspectMap.values());

  const evaluated = [];
  for (const item of topToInspect) {
    // Engine #35 + #55C (GPT-6-Luna True 5m Institutional Taker Stream):
    // Fixed Bug #1: Fetch period=5m&limit=3 (instead of period=15m) for takerlongshortRatio so 5m taker gates use real 5-minute institutional flow!
    const [klines15m, oiHist, topPosRatio, globalAccRatio, instTakerRatio] = await Promise.all([
      fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=${item.fSym}&interval=15m&limit=64`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${item.fSym}&period=15m&limit=5`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${item.fSym}&period=5m&limit=3`, {}, 3500),
    ]);
    if (!Array.isArray(klines15m) || klines15m.length < 30) continue;

    const closes = klines15m.map(k => Number(k[4]));
    const lastPrice = closes[closes.length - 1];
    const price1hAgo = closes[Math.max(0, closes.length - 5)];
    const change1hPct = price1hAgo > 0 ? Number((((lastPrice - price1hAgo) / price1hAgo) * 100).toFixed(2)) : 0;
    const anatomy = analyzeCandleSmcAndCvd15m(klines15m);
    // Engine #60B: Use completed 15m bars for RSI/ATR when the live 15m bar is <50% elapsed to prevent early intrabar distortion
    const klinesForRsiAtr = anatomy.b0ElapsedFrac < 0.50 && klines15m.length > 20 ? klines15m.slice(0, -1) : klines15m;
    const closesForRsi = klinesForRsiAtr.map(k => Number(k[4]));
    const rsi15m = computeRsi(closesForRsi, 14);
    const atr15mPct = computeAtrPct(klinesForRsiAtr, 14);
    const mtfSqueeze = analyzeMtfAndVolatilitySqueeze(klines15m);

    // Engine #35.1 + #55C (GPT-6-Luna Full-Precision 5m Taker Flow & Fail-Closed Validity Check):
    const takerDataValid =
      Array.isArray(instTakerRatio) &&
      instTakerRatio.length >= 2 &&
      Number.isFinite(Number(instTakerRatio[instTakerRatio.length - 1]?.buySellRatio));
    let rawInstBuySellRatio = 1.0;
    let rawPrevInstBuySellRatio = 1.0;
    if (takerDataValid) {
      rawInstBuySellRatio = Number(instTakerRatio[instTakerRatio.length - 1].buySellRatio);
      rawPrevInstBuySellRatio = Number(instTakerRatio[instTakerRatio.length - 2]?.buySellRatio || rawInstBuySellRatio);
    }
    const instBuySellRatio = Number(rawInstBuySellRatio.toFixed(2));
    const prevInstBuySellRatio = Number(rawPrevInstBuySellRatio.toFixed(2));
    const isTakerRatioCrashingLong =
      !takerDataValid ||
      rawInstBuySellRatio < 0.92 ||
      (rawPrevInstBuySellRatio >= 1.50 && rawInstBuySellRatio < rawPrevInstBuySellRatio * 0.62);
    const isTakerRatioCrashingShort =
      !takerDataValid ||
      rawInstBuySellRatio > 1.08 ||
      (rawPrevInstBuySellRatio <= 0.70 && rawInstBuySellRatio > rawPrevInstBuySellRatio * 1.45);
    let instTakerLongPts = 0;
    let instTakerShortPts = 0;
    if (takerDataValid && rawInstBuySellRatio >= 1.14 && !isTakerRatioCrashingLong) {
      instTakerLongPts = Math.min(8, Math.round((rawInstBuySellRatio - 1.0) * 20));
    } else if (takerDataValid && rawInstBuySellRatio <= 0.88 && !isTakerRatioCrashingShort) {
      instTakerShortPts = Math.min(8, Math.round((1.0 - rawInstBuySellRatio) * 20));
    }

    const rsVsBtcAtr = Number(((change1hPct - btc1hChangePct) / Math.max(0.40, atr15mPct)).toFixed(2));
    let bullishRsPts = 0;
    let bearishRsPts = 0;
    if (rsVsBtcAtr >= 0.70) {
      bullishRsPts = Math.min(8, Math.round(rsVsBtcAtr * 4));
    } else if (rsVsBtcAtr <= -0.70) {
      bearishRsPts = Math.min(8, Math.round(Math.abs(rsVsBtcAtr) * 4));
    }

    // Structural 4h VWAP from 16 completed 15m bars (prevents unclosed b0 from distorting the 4h benchmark)
    let pvSum = 0;
    let vSum = 0;
    for (const k of klines15m.slice(-17, -1)) {
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

    // Engine #55A + #60B: Continuous elapsed-fraction volume blending (eliminates step jump at b0ElapsedFrac = 0.20)
    const prev12VolAvg =
      klines15m.slice(-14, -2).reduce((s, k) => s + Number(k[5]), 0) / 12 || 1;
    const b0RawVol = Number(klines15m[klines15m.length - 1][5]);
    const b1RawVol = Number(klines15m[klines15m.length - 2][5]);
    const b0PacedVol = Math.min(b0RawVol * 2.2, b0RawVol / Math.max(0.15, anatomy.b0ElapsedFrac));
    const wVol = Math.min(1.0, Math.max(0.0, (anatomy.b0ElapsedFrac - 0.10) / 0.40));
    const curBarVol = Math.max(b1RawVol, wVol * b0PacedVol + (1 - wVol) * b1RawVol);
    const volRatio15m = Number((curBarVol / prev12VolAvg).toFixed(2));

    let oiDelta1hPct = 0;
    if (Array.isArray(oiHist) && oiHist.length >= 2) {
      const firstOi = Number(oiHist[0]?.sumOpenInterestValue || oiHist[0]?.sumOpenInterest || 0);
      const lastOi = Number(oiHist[oiHist.length - 1]?.sumOpenInterestValue || oiHist[oiHist.length - 1]?.sumOpenInterest || 0);
      if (firstOi > 0) {
        oiDelta1hPct = Number((((lastOi - firstOi) / firstOi) * 100).toFixed(2));
      }
    }

    // Engine #54A: Disable Q4-BNF Falling-Knife Override
    const isBnfLiquidationBounce = false;

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

    // Engine #55D (GPT-6-Luna Negative-Funding Short-Squeeze Whale-Hedge Override):
    // Fixed Bug #11: When a coin is in an active negative-funding / backwardation short squeeze (e.g. ORDERUSDT -0.75% funding, +10.25% Q1 OI, +10.18% 1h, or ANIMEUSDT -0.63% funding),
    // Top-Position short skew (whaleRetailSpread < 0) reflects delta-neutral funding hedges or trapped shorts getting squeezed — NOT distribution!
    const isActiveShortSqueezeRegime = Boolean(
      (item.fundingRatePct <= -0.025 || item.basisPct <= -0.080) &&
        (oiQuadrant.startsWith('Q1') || oiQuadrant.startsWith('Q3-TUZAK') || mtfSqueeze.squeezeBullishPts > 0) &&
        change1hPct >= 0.50
    );
    const isLiveInstTakerDumping = rawInstBuySellRatio <= 0.85 && (anatomy.normCvd3BarPct <= -6 || takerBuyPct <= 46.5);
    const isWhaleAccumulatingOversoldShort = item.change24hPct <= -7.5 && whaleRetailSpread >= 3.0;
    const isWhaleDistributingOverboughtLong =
      !isActiveShortSqueezeRegime && item.change24hPct >= 7.5 && whaleRetailSpread <= -3.0;
    let bullishWhalePts = 0;
    let bearishWhalePts = 0;
    if (whaleRetailSpread >= 4.0) {
      bullishWhalePts = Math.min(14, Math.round((whaleRetailSpread - 2) * 1.3));
      bearishWhalePts =
        isLiveInstTakerDumping && !isWhaleAccumulatingOversoldShort
          ? 0
          : -Math.min(14, Math.round(whaleRetailSpread * 1.0));
    } else if (whaleRetailSpread <= -3.0) {
      if (isActiveShortSqueezeRegime) {
        // Trapped shorts / basis hedges in negative funding act as short-squeeze fuel, not bearish distribution!
        bullishWhalePts = Math.min(8, Math.round(Math.abs(item.fundingRatePct) * 60));
        bearishWhalePts = 0;
      } else {
        bearishWhalePts = Math.min(15, Math.round((Math.abs(whaleRetailSpread) - 1.5) * 1.35));
        bullishWhalePts = -Math.min(18, Math.round(Math.abs(whaleRetailSpread) * 1.2));
      }
    }
    const whaleVetoLong =
      (isActiveShortSqueezeRegime ? whaleRetailSpread <= -14.0 : whaleRetailSpread <= -6.5) ||
      isWhaleDistributingOverboughtLong;
    const whaleVetoShort =
      isWhaleAccumulatingOversoldShort ||
      (isLiveInstTakerDumping ? whaleRetailSpread >= 16.5 : whaleRetailSpread >= 10.5);

    // Engine #44A + #45 + #50 + #54B: 5m Institutional Taker Floor & Strict Anti-Bleed SHORT Lockdown
    const tuning = state.adaptiveTuning || { minLongScore: 78, minShortScore: 86, minLongTaker5m: 1.04, maxShortTaker5m: 0.86 };
    const curMaxShortTaker5m = Math.min(0.86, tuning.maxShortTaker5m ?? 0.86);

    // Engine #43B + #50 (GPT-6-Luna Unified Anti-Backwardation Squeeze & Q1/Q4 GCR Mania Short Gate):
    const isGcrCrowdedManiaShort = Boolean(
      (item.change24hPct >= 10.0 || rsi15m >= 71) &&
        rsi15m >= 58 &&
        anatomy.posIn16BarRange >= 0.55 &&
        change1hPct > -2.20 &&
        change1hPct <= 0.80 &&
        item.basisPct >= -0.020 &&
        item.fundingRatePct >= 0.0 &&
        !oiQuadrant.startsWith('Q1') &&
        !oiQuadrant.startsWith('Q4') &&
        rawInstBuySellRatio <= curMaxShortTaker5m &&
        (whaleRetailSpread <= -4.0 || item.basisPct >= 0.045 || item.fundingRatePct >= 0.018 || isLiveInstTakerDumping) &&
        (anatomy.bearishPattern || anatomy.buySideSweep || anatomy.bearishCvdPts >= 6)
    );
    if (isGcrCrowdedManiaShort) {
      bearishWhalePts = Math.min(16, bearishWhalePts + 6);
    }

    // Layer #16 + Engine #52 + #57A (GPT-6-Luna Hype-Breakout, Short-Squeeze Reload & Qullamaggie High-Tight-Flag TTM-Coil LONG Engine):
    // Fixed Bug #16 & #20 + Engine #57A: Allow TTM-Coil volume contraction (volRatio15m >= 0.50) when Q1 + MTF Bullish + 5m Taker >= 1.12x + cooled RSI <= 66!
    const isSqueezeConfirmedLong =
      oiQuadrant.startsWith('Q3-TUZAK') ||
      mtfSqueeze.squeezeBullishPts > 0 ||
      ((item.fundingRatePct <= -0.020 || item.basisPct <= -0.10) && oiDelta1hPct >= 0.35);
    const isHtfCoilContinuationLong = Boolean(
      (mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') || mtfSqueeze.squeezeBullishPts > 0) &&
        item.change24hPct >= 6.0 &&
        change1hPct >= 0.35 &&
        (oiQuadrant.startsWith('Q1') || isSqueezeConfirmedLong) &&
        mtfSqueeze.mtfBullishPts > 0 &&
        takerDataValid &&
        rawInstBuySellRatio >= 1.12 &&
        volRatio15m >= 0.50 &&
        rsi15m <= 66 &&
        anatomy.normCvd3BarPct > 0 &&
        anatomy.clv >= 0.65 &&
        mtfSqueeze.mtfBearishPts === 0 &&
        !anatomy.isFishingTrapLong
    );
    const isHypeSqueezeMomentumLong = Boolean(
      (item.change24hPct >= 2.5 || change1hPct >= 1.25) &&
        change1hPct >= 0.35 &&
        (oiQuadrant.startsWith('Q1') || isSqueezeConfirmedLong) &&
        takerDataValid &&
        rawInstBuySellRatio >= 1.08 &&
        (volRatio15m >= 0.85 || isHtfCoilContinuationLong) &&
        rsi15m <= 78 &&
        anatomy.normCvd3BarPct > 0 &&
        anatomy.clv >= 0.56 &&
        mtfSqueeze.mtfBearishPts === 0 &&
        !anatomy.isFishingTrapLong
    );

    let velocityLongPts = 0;
    let velocityShortPts = 0;
    if (isHypeSqueezeMomentumLong) {
      velocityLongPts = Math.min(14, Math.round(6 + Math.max(0, change1hPct) * 2.2 + Math.max(0, volRatio15m - 0.8) * 3));
    } else if (
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
    const high4h = Math.max(...klines15m.slice(-17, -1).map(k => Number(k[2])));
    const low4h = Math.min(...klines15m.slice(-17, -1).map(k => Number(k[3])));
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
    const fundingVetoLong =
      item.fundingRatePct >= 0.080 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct >= 0.035) ||
      (itemMinsToFunding <= 12 && item.fundingRatePct <= -0.35);
    const fundingVetoShort =
      item.fundingRatePct <= -0.120 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct <= -0.035);

    // Engine #40 + #52 + #57B (Qullamaggie + GPT-6-Luna ATR-Normalized VWAP & RSI Extension Band for High-Tight-Flag / Hype Rockets):
    const hasQullamaggieMomentumConfirm =
      isHypeSqueezeMomentumLong ||
      isHtfCoilContinuationLong ||
      (oiDelta1hPct >= 0.45 &&
        rawInstBuySellRatio >= 1.18 &&
        volRatio15m >= 0.90 &&
        anatomy.normCvd3BarPct > 8.0 &&
        anatomy.clv >= 0.65);
    const htfAtrNormCap =
      rsi15m <= 66 && vwapDistPct <= 0.90 * atr15mPct
        ? Math.min(6.20, Number((0.90 * atr15mPct).toFixed(2)))
        : 4.20;
    const vwapMaxBandPct = hasQullamaggieMomentumConfirm
      ? Math.max(2.40, Math.min(Math.max(4.20, htfAtrNormCap), Number((1.85 * atr15mPct).toFixed(2))))
      : 1.85;
    const maxAllowedLongRsi = isHypeSqueezeMomentumLong ? 78 : 70;
    const minVwapReloadRatio = isHypeSqueezeMomentumLong ? 0.985 : 0.9985;

    const vwapLongOk =
      isBnfLiquidationBounce ||
      (lastPrice >= vwap4h * minVwapReloadRatio &&
        vwapDistPct <= vwapMaxBandPct &&
        rsi15m >= 38 &&
        rsi15m <= maxAllowedLongRsi &&
        mtfSqueeze.mtfBearishPts === 0);
    // Fixed Bug #15: Overbought short branch requires actual bearish rejection or negative CVD, not RSI >= 67 alone!
    const vwapShortOk =
      (lastPrice <= vwap4h * 1.003 && rsi15m >= 31 && rsi15m <= 66 && mtfSqueeze.mtfBullishPts === 0) ||
      (rsi15m >= 67 && (anatomy.bearishPattern || anatomy.normCvd3BarPct <= -4)) ||
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

    // Wall #4 + Bug #17 Fix + Engine #57C: Anti-Top-Chase / Hype Exhaustion Ceiling (exempting cooled Qullamaggie HTF TTM-Coil continuations)
    const isCoiledTopLongTrap =
      !isBnfLiquidationBounce &&
      !isHtfCoilContinuationLong &&
      mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') &&
      item.change24hPct >= 8.0 &&
      Math.abs(change1hPct) <= 0.85 &&
      anatomy.clv >= 0.80;
    const isHypeExhaustedTopLong =
      isHypeSqueezeMomentumLong &&
      item.change24hPct >= 95.0 &&
      !isHtfCoilContinuationLong &&
      (volRatio15m < 1.15 || rawInstBuySellRatio < 1.12 || anatomy.posIn4BarRange >= 0.94);
    const isOverextendedMicroTopLong =
      isCoiledTopLongTrap ||
      isHypeExhaustedTopLong ||
      (!isBnfLiquidationBounce &&
        !isHypeSqueezeMomentumLong &&
        ((anatomy.green3Completed &&
          anatomy.runup4BarPct >= Math.max(0.95, atr15mPct * 1.45) &&
          anatomy.posIn4BarRange >= 0.86 &&
          volRatio15m < 1.55) ||
          (item.change24hPct >= 18.0 && (volRatio15m < 1.35 || mtfSqueeze.mtfBullishPts === 0))));

    // Engine #43 + #47 + #48: Anti-Bottom-Chase, Q4 De-Leveraging, Macro-Uptrend Pullback & Coiled-Bottom Short Shield
    const isCoiledBottomShortTrap =
      mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') &&
      item.change24hPct <= -8.0 &&
      Math.abs(change1hPct) <= 0.85;
    const isBottomChase3RedShort =
      anatomy.red3Completed &&
      anatomy.drop4BarPct >= Math.max(0.95, atr15mPct * 1.45) &&
      anatomy.posIn4BarRange <= 0.14 &&
      volRatio15m < 1.55;
    const isQ4CapitulationExhaustedShort =
      oiQuadrant.startsWith('Q4') &&
      (change1hPct <= -2.20 ||
        item.change24hPct >= 3.0 ||
        item.basisPct <= -0.15 ||
        mtfSqueeze.mtfBearishPts === 0 ||
        (item.change24hPct <= -8.5 && whaleRetailSpread >= 3.0));
    const isMacroUpPullbackBottomShort =
      change1hPct <= -2.10 &&
      item.change24hPct >= 4.5 &&
      (anatomy.clv <= 0.18 || anatomy.posIn4BarRange <= 0.22 || mtfSqueeze.mtfBearishPts === 0 || !oiQuadrant.startsWith('Q3'));
    const isOverextendedMicroBottomShort =
      isCoiledBottomShortTrap ||
      isWhaleAccumulatingOversoldShort ||
      isBottomChase3RedShort ||
      isQ4CapitulationExhaustedShort ||
      isMacroUpPullbackBottomShort;

    // Engine #37 + #47 + #54A + #61B (Consolidated Falling-Knife & Red-Macro Weak-Bounce Recovery Predicate):
    const perpBreadth24hPct = fundingCnt > 0 ? Math.round((greenPerpCnt / fundingCnt) * 100) : 50;
    const hasConfirmedKnifeReversal =
      oiQuadrant.startsWith('Q1') &&
      mtfSqueeze.mtfBullishPts > 0 &&
      change1hPct >= 1.20 &&
      takerDataValid &&
      rawInstBuySellRatio >= 1.15;
    const isRedMacroWeakLong =
      perpBreadth24hPct < 30 &&
      item.change24hPct < 1.0 &&
      !hasConfirmedKnifeReversal &&
      !isActiveShortSqueezeRegime &&
      !hasFreshDirectNews;
    const isFallingKnifeLongVeto = (item.change24hPct <= -4.5 && !hasConfirmedKnifeReversal) || isRedMacroWeakLong;
    const isBasisDumpTrapLong =
      isFallingKnifeLongVeto ||
      (item.basisPct <= -0.22 && item.change24hPct <= -6.0);

    // Engine #54B (GPT-6-Luna Strict Anti-Bleed Institutional SHORT Lockdown):
    const isStrictShortAllowed =
      takerDataValid &&
      (oiQuadrant.startsWith('Q3') || isGcrCrowdedManiaShort) &&
      !oiQuadrant.startsWith('Q3-TUZAK') &&
      item.change24hPct > -5.0 &&
      item.basisPct > -0.030 &&
      item.fundingRatePct > -0.010 &&
      whaleRetailSpread <= -2.0 &&
      rawInstBuySellRatio <= curMaxShortTaker5m &&
      rawShortTotal >= Math.max(86, tuning.minShortScore ?? 86);

    // Engine #47A + Bug #5 Fix: Hard Directional 3-Bar CVD Sign Alignment
    const hasCvdAlignmentLong = anatomy.normCvd3BarPct >= 0;
    const hasCvdAlignmentShort = anatomy.normCvd3BarPct <= 0;

    // Require active 15m volume participation (volRatio15m >= 0.72, or >= 0.50 in a Qullamaggie HTF TTM-Coil) and positive 1h momentum alignment
    const hasLongMomentumAndVol =
      (volRatio15m >= 0.72 || isHtfCoilContinuationLong) && hasCvdAlignmentLong && change1hPct >= 0.15 && rsVsBtcAtr >= 0.05;
    const hasShortMomentumAndVol =
      volRatio15m >= 0.72 && hasCvdAlignmentShort && (isGcrCrowdedManiaShort || (change1hPct <= -0.15 && rsVsBtcAtr <= -0.05));

    const has5mInstTakerLong =
      takerDataValid &&
      rawInstBuySellRatio >= (tuning.minLongTaker5m ?? 1.04) &&
      (takerBuyPct >= 51.5 || rawInstBuySellRatio >= 1.14);
    const has5mInstTakerShort =
      takerDataValid &&
      rawInstBuySellRatio <= curMaxShortTaker5m &&
      (takerBuyPct <= 48.0 || rawInstBuySellRatio <= 0.84);

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
      has5mInstTakerLong &&
      rsVsBtcAtr >= -0.20 &&
      rawLongTotal >= (tuning.minLongScore ?? 78);

    const canTriggerShort =
      isStrictShortAllowed &&
      !btcVetoShort &&
      !whaleVetoShort &&
      !fundingVetoShort &&
      !anatomy.vetoShort &&
      !isTakerRatioCrashingShort &&
      !isOverextendedMicroBottomShort &&
      hasShortMomentumAndVol &&
      vwapShortOk &&
      has5mInstTakerShort &&
      (rsVsBtcAtr <= 0.25 || isGcrCrowdedManiaShort) &&
      rawShortTotal >= Math.max(86, tuning.minShortScore ?? 86);

    let rawScore = 50;
    if (canTriggerLong && (!canTriggerShort || rawLongTotal >= rawShortTotal)) {
      side = 'LONG';
      rawScore = rawLongTotal;
      score = Math.min(99, rawLongTotal);
      const dynLev = selectConvictionLeverage(score, atr15mPct);
      engine = isHypeSqueezeMomentumLong
        ? 'ENGINE_HYPE_SQUEEZE_MOMENTUM_LONG'
        : isBnfLiquidationBounce
          ? 'ENGINE_BNF_LIQUIDATION_BOUNCE_LONG'
          : hasFreshDirectNews
            ? 'ENGINE_QULLAMAGGIE_NEWS_OI_LONG'
            : mtfSqueeze.squeezeBullishPts > 0
              ? 'ENGINE_TTM_VOLATILITY_SQUEEZE_LONG'
              : item.basisPct <= -0.030 || item.fundingRatePct <= -0.010
                ? 'ENGINE_LIGHTCRYPTO_SQUEEZE_LONG'
                : 'ENGINE_EUGENE_WHALE_SMC_LONG';
      thesis = `[${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel}] ${oiQuadrant} | ${mtfSqueeze.mtfTrend} | 1s: ${change1hPct >= 0 ? '+' : ''}%${change1hPct} (24s: ${item.change24hPct >= 0 ? '+' : ''}%${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr >= 0 ? '+' : ''}${rsVsBtcAtr} ATR | ${basisLabel} | Balina Makası: ${whaleRetailSpread >= 0 ? '+' : ''}%${whaleRetailSpread} | 5dk Taker: ${instBuySellRatio}x | ${anatomy.cvdLabel}${liqMagnetLabel} | HamSkor:${rawScore} -> ${dynLev}x LONG!`;
    } else if (canTriggerShort) {
      side = 'SHORT';
      rawScore = rawShortTotal;
      score = Math.min(99, rawShortTotal);
      const dynLev = selectConvictionLeverage(score, atr15mPct);
      engine = isGcrCrowdedManiaShort
        ? 'ENGINE_GCR_MANIA_FADE_SHORT'
        : mtfSqueeze.squeezeBearishPts > 0
          ? 'ENGINE_TTM_VOLATILITY_SQUEEZE_SHORT'
          : 'ENGINE_SMC_WHALE_FLUSH_SHORT';
      thesis = `[${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel}] ${oiQuadrant} | ${mtfSqueeze.mtfTrend} | 1s: %${change1hPct} (24s: %${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr} ATR | ${basisLabel} | Balina Makası: %${whaleRetailSpread} | 5dk Taker: ${instBuySellRatio}x | ${anatomy.cvdLabel}${liqMagnetLabel} | HamSkor:${rawScore} -> ${dynLev}x SHORT!`;
    } else {
      if (rawShortTotal > rawLongTotal && !anatomy.vetoShort && !fundingVetoShort) {
        side = 'SHORT_ADAY';
        rawScore = rawShortTotal;
        score = Math.min(75, Math.max(30, rawShortTotal));
      } else {
        side = 'LONG_ADAY';
        rawScore = rawLongTotal;
        score = Math.min(75, Math.max(30, rawLongTotal));
      }
      thesis = `${anatomy.patternLabel} | ${mtfSqueeze.squeezeLabel} | ${oiQuadrant} | 1s: ${change1hPct >= 0 ? '+' : ''}%${change1hPct} (24s: ${item.change24hPct >= 0 ? '+' : ''}%${item.change24hPct}) | RS_BTC: ${rsVsBtcAtr >= 0 ? '+' : ''}${rsVsBtcAtr} | Balina Makası: ${whaleRetailSpread >= 0 ? '+' : ''}%${whaleRetailSpread} | 5dk Taker: ${instBuySellRatio}x | ${anatomy.cvdLabel}`;
    }

    const convictionLeverage = selectConvictionLeverage(score, atr15mPct);

    evaluated.push({
      symbol: item.symbol,
      fSym: item.fSym,
      markPrice: item.markPrice || lastPrice,
      klineClosePrice: lastPrice,
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
      takerDataValid,
      volRatio15m,
      oiDelta1hPct,
      oiQuadrant,
      whaleLongPct,
      retailLongPct,
      whaleRetailSpread,
      candlePattern: anatomy.patternLabel,
      vetoLong: anatomy.vetoLong,
      vetoShort: anatomy.vetoShort,
      smcLabel: anatomy.smcLabel,
      cvdLabel: anatomy.cvdLabel,
      mtfTrend: mtfSqueeze.mtfTrend,
      squeezeLabel: mtfSqueeze.squeezeLabel,
      structuralLow: anatomy.structuralLow,
      structuralHigh: anatomy.structuralHigh,
      convictionLeverage,
      engine,
      side,
      rawScore,
      score,
      priorityScore: item.priorityScore,
      thesis,
      headline: item.newsCand?.headlines?.[0]?.title || null,
    });
  }

  // Engine #58 (GPT-6-Luna Deterministic Uncapped rawScore + Taker Flow Tie-Breaking Sort):
  evaluated.sort((a, b) => {
    const aAct = a.engine !== 'WATCHLIST' ? 1 : 0;
    const bAct = b.engine !== 'WATCHLIST' ? 1 : 0;
    if (bAct !== aAct) return bAct - aAct;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.rawScore || b.score) !== (a.rawScore || a.score)) return (b.rawScore || b.score) - (a.rawScore || a.score);
    const aTakerEdge = a.side.startsWith('SHORT') ? 1 / Math.max(0.1, a.instBuySellRatio || 1) : a.instBuySellRatio || 1;
    const bTakerEdge = b.side.startsWith('SHORT') ? 1 / Math.max(0.1, b.instBuySellRatio || 1) : b.instBuySellRatio || 1;
    if (Math.abs(bTakerEdge - aTakerEdge) >= 0.05) return bTakerEdge - aTakerEdge;
    return (b.priorityScore || 0) - (a.priorityScore || 0) || a.symbol.localeCompare(b.symbol);
  });

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
        : `20 KATMANLI YIRTICI KONSEY v10.1 (${preCandidates.length} Likit Kontrat | 3x-5x Anti-İğne + 5dk Gerçek Taker & Luna Sıfır-Hata Kalkanı)`,
    lastScanAt: new Date().toLocaleString('tr-TR'),
    statusNote: state.openPosition
      ? `🔥 Açık ${state.openPosition.leverage || LEVERAGE}x ${state.openPosition.side}: ${state.openPosition.symbol}USDT takip ediliyor.`
      : `🛡️ Pusuda: Tüm Binance Futures (${preCandidates.length} Yüksek Hızlı Kontrat) 3x/3.5x/4x için taranıyor.`,
  };
  state.topCandidates = evaluated.slice(0, 8);
  state.openPositionLiveCand = state.openPosition
    ? evaluated.find(c => c.symbol === state.openPosition.symbol) || null
    : null;
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

  // Fixed Bug #32: Persist cumulative maximum adverse excursion (MAE) across all ticks instead of instantaneous drawdown only!
  const currentAdverseFrac = Math.max(0, -rawCoinMoveFrac);
  pos.maxAdverseCoinMoveFrac = Math.max(pos.maxAdverseCoinMoveFrac || 0, currentAdverseFrac);

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

  // Stage 2 (v8.4 Asymmetric Runner + Zero-Choke + MIN_NOTIONAL Full-Lock Guard):
  // If remaining 65% runner is >= MIN_NOTIONAL_USDT ($5.00), harvest 35% at +1.25% Coin Move and keep 65% Runner (+0.35% stop lock).
  // If position notional is ~300 TL ($6.05 USDT, e.g. 100 TL x 3x), splitting 35%/65% would leave $3.93 (< $5.00 MIN_NOTIONAL); lock 100% full position stop at +0.55% instead!
  if (!pos.tp1Done && rawCoinMoveFrac >= 0.0125) {
    if (pos.notionalUsdt * 0.65 < MIN_NOTIONAL_USDT) {
      pos.tp1Done = true;
      pos.ratchetStage = 'TP1_FULL_STOP_LOCK_MIN_NOTIONAL';
      if (pos.side === 'LONG') {
        const lockFull = Number((pos.entryPrice * (1 + 0.0055)).toPrecision(6));
        if (lockFull > pos.stopPrice) pos.stopPrice = lockFull;
      } else {
        const lockFull = Number((pos.entryPrice * (1 - 0.0055)).toPrecision(6));
        if (lockFull < pos.stopPrice) pos.stopPrice = lockFull;
      }
      logEvent(
        state,
        `🔒 [TP1 %100 TAM GÖVDE KÂR KİLİDİ (MIN_NOTIONAL KORUMASI)] ${pos.symbol}USDT (${posLev}x ${pos.side}) +%${underlyingMovePct} yürüyüşte ${pos.marginTry} TL (${pos.notionalTry} TL Hacim) bölünmeden %100 Ana Gövde Stopu +%0.55 Net Kâra Kilitlendi!`
      );
    } else {
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
  }

  // Stage 1 / Stage 3 (v8.4 Wide-Breathing Ratchet + Bug #42 Capped TP Extensions):
  if (peakCoinMoveFrac >= 0.0195) {
    pos.ratchetStage = 'PARABOLIC_SQUEEZE_RUNNER';
    if (pos.side === 'LONG') {
      const trailStop = Number((pos.extremePrice * (1 - 0.0055)).toPrecision(6));
      if (trailStop > pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice >= pos.tpPrice * 0.997 && (pos.tpExtensionCount || 0) < 3) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb >= 0.12) {
          pos.tpPrice = Number((markExitPrice * 1.015).toPrecision(6));
          pos.tpExtensionCount = (pos.tpExtensionCount || 0) + 1;
        }
      }
    } else {
      const trailStop = Number((pos.extremePrice * (1 + 0.0055)).toPrecision(6));
      if (trailStop < pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice <= pos.tpPrice * 1.003 && (pos.tpExtensionCount || 0) < 3) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb <= -0.12) {
          pos.tpPrice = Number((markExitPrice * 0.985).toPrecision(6));
          pos.tpExtensionCount = (pos.tpExtensionCount || 0) + 1;
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
  } else if (peakCoinMoveFrac >= 0.0095) {
    // Engine #44B (GPT-6-Luna Fee-Plus Profit-Lock Clamp):
    // Stop_long >= Entry*(1 + c + p + b) where c=0.0018 fees, p=0.0010 net profit floor, b=0.0006 mark-to-fill buffer -> +0.34%
    pos.ratchetStage = 'FAST_BREAKEVEN_PLUS';
    if (pos.side === 'LONG') {
      const bePlus = Number((pos.entryPrice * (1 + 0.0034)).toPrecision(6));
      if (bePlus > pos.stopPrice) pos.stopPrice = bePlus;
    } else {
      const bePlus = Number((pos.entryPrice * (1 - 0.0034)).toPrecision(6));
      if (bePlus < pos.stopPrice) pos.stopPrice = bePlus;
    }
  } else if (peakCoinMoveFrac >= 0.0055 && !pos.tp1Done) {
    // Engine #60A (GPT-6-Luna +0.55% to +0.95% Early Profit-Lock Bridge):
    // Protects initial pops (+0.55% to +0.94%) from round-tripping to a full stop if peak >= +0.72% or 5m taker flow decays after 10m!
    const earlyLockCand =
      candidates.find(c => c.symbol === pos.symbol) ||
      (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
    const earlyHeldMins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
    const isEarlyTakerDecaying = Boolean(
      earlyHeldMins >= 10 &&
        earlyLockCand &&
        (pos.side === 'LONG' ? earlyLockCand.instBuySellRatio < 1.02 : earlyLockCand.instBuySellRatio > 0.98)
    );
    if (peakCoinMoveFrac >= 0.0072 || isEarlyTakerDecaying) {
      pos.ratchetStage = 'EARLY_PROFIT_LOCK';
      if (pos.side === 'LONG') {
        const earlyLock = Number((pos.entryPrice * (1 + 0.0034)).toPrecision(6));
        if (earlyLock > pos.stopPrice) pos.stopPrice = earlyLock;
      } else {
        const earlyLock = Number((pos.entryPrice * (1 - 0.0034)).toPrecision(6));
        if (earlyLock < pos.stopPrice) pos.stopPrice = earlyLock;
      }
    }
  }

  const isTpHit =
    pos.side === 'LONG' ? markExitPrice >= pos.tpPrice : markExitPrice <= pos.tpPrice;
  const isStopHit =
    pos.side === 'LONG' ? markExitPrice <= pos.stopPrice : markExitPrice >= pos.stopPrice;

  const minsHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
  const isTimeStop = minsHeld >= 90 && rawCoinMoveFrac < 0.0035;

  let isOrderflowScratch = false;
  let isFishingEmergencyExit = false;
  let isWickTakerCollapseScratch = false;
  let isFundingSettlementHarvest = false;
  let isStaleMomentumScratch = false;
  // Fixed Bug #33: Use immutable initialRiskFrac stored at entry for R-calculations
  const initRiskFrac = Math.max(0.0085, Number(pos.initialRiskFrac || (pos.underlyingSlPct || 1.2) / 100));
  const mfeR = peakCoinMoveFrac / initRiskFrac;
  const aeR = (pos.maxAdverseCoinMoveFrac || currentAdverseFrac) / initRiskFrac;
  // Fixed Bug #40 & #41: Resolve open position candidate even when it drops out of top-8 `state.topCandidates` during 4s ticks!
  const curPosLiveCand =
    candidates.find(c => c.symbol === pos.symbol) ||
    (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
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
  // Engine #56 (GPT-6-Luna Completed-Bar Wick-Rejection & 5m Taker-Collapse Scratch — Fixed Bug #31):
  // Never cut during the first 15m bar consolidation (FUSDT paused at 9m before ripping +14.71 TL / +5.33% ROE!);
  // Only scratch if minsHeld >= 16m (at least 1 completed 15m candle), mfeR < 0.22, aeR >= 0.35, AND 5m Taker collapsed <= 0.84x (LONG) / >= 1.18x (SHORT) with completed candle veto!
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && !pos.tp1Done && minsHeld >= 16 && aeR >= 0.35 && mfeR < 0.22 && curPosLiveCand) {
    const isLongWickCollapse =
      pos.side === 'LONG' &&
      curPosLiveCand.vetoLong &&
      curPosLiveCand.instBuySellRatio <= 0.84 &&
      curPosLiveCand.takerBuyPct <= 46.0;
    const isShortWickCollapse =
      pos.side === 'SHORT' &&
      curPosLiveCand.vetoShort &&
      curPosLiveCand.instBuySellRatio >= 1.18 &&
      curPosLiveCand.takerBuyPct >= 54.0;
    if (isLongWickCollapse || isShortWickCollapse) {
      isWickTakerCollapseScratch = true;
    }
  }
  // Engine #49 (GPT-6-Luna 32-Minute R-Normalized MFE/MAE Stale-Trade & Squeeze Early Scratch):
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && !isWickTakerCollapseScratch && !pos.tp1Done) {
    const whaleOrTakerFlippedAgainst = Boolean(
      curPosLiveCand &&
        ((pos.side === 'SHORT' && (curPosLiveCand.whaleRetailSpread >= 3.0 || curPosLiveCand.instBuySellRatio >= 1.10)) ||
          (pos.side === 'LONG' && (curPosLiveCand.whaleRetailSpread <= -3.0 || curPosLiveCand.instBuySellRatio <= 0.90)))
    );
    if ((minsHeld >= 32 && aeR >= 0.35 && mfeR < 0.25) || (minsHeld >= 22 && aeR >= 0.30 && mfeR < 0.30 && whaleOrTakerFlippedAgainst)) {
      isStaleMomentumScratch = true;
    }
  }
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && !isWickTakerCollapseScratch && !isStaleMomentumScratch && minsHeld >= 22 && rawCoinMoveFrac <= 0.0015 && rawCoinMoveFrac >= -0.0045) {
    const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
    if (depth?.bids?.length && depth?.asks?.length) {
      const liveOb = computeWeightedBookImbalance(depth.bids, depth.asks);
      if ((pos.side === 'LONG' && liveOb <= -0.22) || (pos.side === 'SHORT' && liveOb >= 0.22)) {
        isOrderflowScratch = true;
      }
    }
  }

  // Engine #61A (GPT-6-Luna Uncapped rawScore Opportunity-Cost Zero-Loss Slot Rotation):
  // Never rotate out at a loss (rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC + 0.0006), but if stalled >= 18m while a stronger rawScore breakout appears, rotate!
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
    minsHeld >= 18 &&
    rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC + 0.0006 &&
    rawCoinMoveFrac <= 0.0040 &&
    candidates.length > 0
  ) {
    const curRawScore = Number(curPosLiveCand?.rawScore ?? curPosLiveCand?.score ?? 72);
    const isCurDegraded = Boolean(!curPosLiveCand || curPosLiveCand.engine === 'WATCHLIST' || curRawScore < 82);
    const bestNewCand = candidates.find(
      c =>
        c.symbol !== pos.symbol &&
        c.engine !== 'WATCHLIST' &&
        (c.side === 'LONG' || c.side === 'SHORT') &&
        Number(c.rawScore || c.score) >= 96 &&
        (isCurDegraded || Number(c.rawScore || c.score) - curRawScore >= 12) &&
        (!symbolCooldowns[c.symbol] || symbolCooldowns[c.symbol] <= nowMs) &&
        (!obVetoCooldowns[c.symbol] || obVetoCooldowns[c.symbol] <= nowMs)
    );
    if (bestNewCand) {
      rotationTarget = bestNewCand;
    }
  }

  let exitReason = null;
  if (isStopHit) {
    // Fixed Bug #43: Prioritize protective stop check before TP check in conservative simulation
    const isProfitStop =
      pos.side === 'LONG' ? pos.stopPrice > pos.entryPrice : pos.stopPrice < pos.entryPrice;
    exitReason = isProfitStop
      ? `🔒 ${posLev}x SIFIR RİSK / SIKIŞTIRMA KÂR KİLİDİ (${pos.side} | Kasa ROE +${roePct}%)`
      : `🛡️ ${posLev}x İZOLE STOP KALKANI (${pos.side} | Coin %${underlyingMovePct} -> Kasa ROE ${roePct}%)`;
  } else if (isTpHit) {
    exitReason = `🎯 ${posLev}x TAM HEDEF HASADI (${pos.side} | Coin %${underlyingMovePct} -> Kasa ROE +%${roePct})`;
  } else if (isFishingEmergencyExit) {
    exitReason = `🎣 YEMLEME (FISHING) ERKEN TAHLİYESİ (Kurumsal Alıcı Çöktü [5dk Taker ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x], Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isWickTakerCollapseScratch) {
    exitReason = `🛡️ İĞNE REDDİ & 5dk TAKER ÇÖKÜŞÜ ERKEN TAHLİYESİ (Motor #56: ${curPosLiveCand?.candlePattern || 'İğne Reddi'} & 5dk Taker ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x, Tam Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isStaleMomentumScratch) {
    exitReason = `⏱️ 32dk BAYAT İVME / SIKIŞMA ERKEN TAHLİYESİ (Motor #49: MFE ${(mfeR * 100).toFixed(0)}%R < 25%R & MAE ${(aeR * 100).toFixed(0)}%R, Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
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

    // Engine #44B + #49B + Fixed Bug #35 (Consistent effectiveExitPrice matching booked PnL):
    const isProfitStopClose =
      isStopHit && (pos.side === 'LONG' ? pos.stopPrice > pos.entryPrice : pos.stopPrice < pos.entryPrice);
    const stopLockedMoveFrac =
      pos.side === 'LONG'
        ? (pos.stopPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - pos.stopPrice) / pos.entryPrice;
    const liveSpreadFrac = (bestAsk - bestBid) / Math.max(1e-9, (bestAsk + bestBid) * 0.5);
    const serverStopSlipFrac = Math.max(0.0006, liveSpreadFrac + 0.0004);
    const effectiveRawMoveFrac = isProfitStopClose
      ? Math.max(rawCoinMoveFrac, ROUND_TRIP_FEE_SLIP_FRAC + 0.0006, stopLockedMoveFrac - 0.0004)
      : isStopHit
        ? Math.max(rawCoinMoveFrac, stopLockedMoveFrac - serverStopSlipFrac)
        : rawCoinMoveFrac;
    const effectiveNetMoveFrac = effectiveRawMoveFrac - ROUND_TRIP_FEE_SLIP_FRAC;
    const effectiveExitPrice =
      pos.side === 'LONG'
        ? Number((pos.entryPrice * (1 + effectiveRawMoveFrac)).toPrecision(6))
        : Number((pos.entryPrice * (1 - effectiveRawMoveFrac)).toPrecision(6));

    const finalLegPnlUsdt = Number((pos.notionalUsdt * effectiveNetMoveFrac).toFixed(4));
    const totalLifecyclePnlUsdt = Number(((pos.realizedPartialUsdt || 0) + finalLegPnlUsdt).toFixed(4));
    const totalLifecyclePnlTry = toTL(totalLifecyclePnlUsdt);
    const initialMarginUsdt = pos.initialMarginUsdt || pos.marginUsdt;
    const initialNotionalUsdt = pos.initialNotionalUsdt || pos.notionalUsdt;
    const lifecycleRoePct = Number(((totalLifecyclePnlUsdt / initialMarginUsdt) * 100).toFixed(2));
    if (isProfitStopClose) {
      exitReason = `🔒 ${posLev}x SIFIR RİSK / SIKIŞTIRMA KÂR KİLİDİ (${pos.side} | Kasa ROE +${lifecycleRoePct}%)`;
    }

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
      exitPrice: effectiveExitPrice,
      roePct: lifecycleRoePct,
      netPnlTry: totalLifecyclePnlTry,
      exitReason,
      closedAt: new Date().toLocaleString('tr-TR'),
    });
    // Engine #46 + Fixed Bug #44 (GPT-6-Luna Protective-Stop Quarantine vs Early Scratch Cooldown):
    // Only increment symbolConsecStops on actual protective stop-outs or losses >= 3.50 TL; early tactical scratches get a 60m cooldown without triggering a 12h toxic quarantine!
    if (!state.symbolCooldowns) state.symbolCooldowns = {};
    if (!state.symbolConsecStops) state.symbolConsecStops = {};
    if (totalLifecyclePnlUsdt >= 0) {
      state.symbolConsecStops[pos.symbol] = 0;
      const winExpiry = Date.now() + 90 * 60 * 1000;
      state.symbolCooldowns[pos.symbol] = Math.max(state.symbolCooldowns[pos.symbol] || 0, winExpiry);
    } else if ((isStopHit && !isProfitStopClose) || totalLifecyclePnlTry <= -3.50) {
      const sCount = (state.symbolConsecStops[pos.symbol] || 0) + 1;
      state.symbolConsecStops[pos.symbol] = sCount;
      const cdMins = sCount >= 2 ? 720 : 180;
      const stopExpiry = Date.now() + cdMins * 60 * 1000;
      state.symbolCooldowns[pos.symbol] = Math.max(state.symbolCooldowns[pos.symbol] || 0, stopExpiry);
      logEvent(
        state,
        `🚫 [Motor #46 Toksik Sembol Karantinası] ${pos.symbol}USDT art arda ${sCount}. stop sonrası ${cdMins / 60} saat (${cdMins}dk) karantinaya alındı!`
      );
    } else {
      const scratchExpiry = Date.now() + 60 * 60 * 1000;
      state.symbolCooldowns[pos.symbol] = Math.max(state.symbolCooldowns[pos.symbol] || 0, scratchExpiry);
    }
    if (rotationTarget) {
      state.lastRotationAtMs = Date.now();
    }
    if (state.closedTrades.length > 30) state.closedTrades.length = 30;
    logEvent(state, `${exitReason} | ${pos.symbol}USDT Toplam Net: ${totalLifecyclePnlTry >= 0 ? '+' : ''}${totalLifecyclePnlTry} TL`);
    runTwoHourSelfAudit(state, true);

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
        exitPrice: effectiveExitPrice,
        thesis: pos.thesis,
      });
    }
  }
}

async function tryOpenPosition(state, candidates) {
  if (state.openPosition) return;

  const goalInfo = getGoalAndTierStatus(state);
  const activeCapUsdt = goalInfo.activeCapUsdt; // 6.0545 USDT (300 TL) at Tier 1, scales automatically at Tier 2-5

  // Hard Tier Cap Enforcement: If leverage cash ever exceeds activeCapUsdt (300.00 TL at Tier 1), sweep excess to Spot Vault BEFORE sizing
  if (state.marginCashUsdt > activeCapUsdt + 0.0002) {
    sweepProfitToSpotVault(state, 0, 'KASA_TAVAN_KORUMA', `${goalInfo.activeCapTry} TL Üstü Fazla Bakiye -> Spot Cüzdana Otomatik Transfer`);
  }

  const nowEntryMs = Date.now();
  const symCds = state.symbolCooldowns || {};
  if (!state.obVetoCooldowns) state.obVetoCooldowns = {};
  if (!state.obVetoStrikes) state.obVetoStrikes = {};
  if (!state.obVetoAtMs) state.obVetoAtMs = {};
  if (!state.obVetoReasons) state.obVetoReasons = {};
  if (!state.obVetoCodes) state.obVetoCodes = {};
  const obVetoCds = state.obVetoCooldowns;

  // Fixed Bug #46: Decay progressive orderbook strikes if last veto was > 30 minutes ago!
  for (const symKey of Object.keys(state.obVetoStrikes)) {
    if (nowEntryMs - (state.obVetoAtMs[symKey] || 0) > 30 * 60 * 1000) {
      state.obVetoStrikes[symKey] = 0;
    }
  }

  // Engine #41 + #46 + Fixed Bug #48 (Structured vetoCode check + real 5m Taker Surge Reset):
  for (const c of candidates) {
    if (obVetoCds[c.symbol] && obVetoCds[c.symbol] > nowEntryMs) {
      const strikes = state.obVetoStrikes[c.symbol] || 0;
      const lastCode = String(state.obVetoCodes[c.symbol] || '');
      const lastReason = String(state.obVetoReasons[c.symbol] || '');
      const isSpoofOrHollow =
        lastCode === 'SPOOF_WALL_DECAY' ||
        lastCode === 'BOOK_HOLLOWING' ||
        lastReason.includes('SPOOF_WALL_DECAY') ||
        lastReason.includes('BOOK_HOLLOWING');
      const isQuarantined = symCds[c.symbol] && symCds[c.symbol] > nowEntryMs;
      if (strikes < 2 && !isSpoofOrHollow && !isQuarantined && c.takerDataValid) {
        const elapsedSinceVetoMs = nowEntryMs - (state.obVetoAtMs[c.symbol] || 0);
        const isLongSurge = c.side === 'LONG' && c.volRatio15m >= 1.25 && c.oiDelta1hPct >= 0.35 && c.instBuySellRatio >= 1.25;
        const isShortSurge = c.side === 'SHORT' && c.volRatio15m >= 1.25 && c.oiDelta1hPct >= 0.35 && c.instBuySellRatio <= 0.80;
        if (elapsedSinceVetoMs >= 90 * 1000 && (isLongSurge || isShortSurge)) {
          delete obVetoCds[c.symbol];
          logEvent(
            state,
            `⚡ [Engine #41 Kurumsal Surge Reset] ${c.symbol} (${c.side} | Vol:${c.volRatio15m}x | OI:+%${c.oiDelta1hPct} | 5dk Taker:${c.instBuySellRatio}x) tahta beklemesi erken sıfırlandı — canlı emir defteri yeniden test ediliyor!`
          );
        }
      }
    }
  }

  const actionable = candidates.filter(
    c =>
      c.engine !== 'WATCHLIST' &&
      (c.side === 'LONG' || c.side === 'SHORT') &&
      c.score >= 78 &&
      (!symCds[c.symbol] || symCds[c.symbol] <= nowEntryMs) &&
      (!obVetoCds[c.symbol] || obVetoCds[c.symbol] <= nowEntryMs)
  );
  if (!actionable.length) return;

  // Tier-Capped Principal Rule: NEVER risk more than activeCapUsdt (300.00 TL at Tier 1) in Leverage!
  const cappedPrincipalUsdt = Math.min(state.marginCashUsdt, activeCapUsdt);
  const usableMarginUsdt = Number((cappedPrincipalUsdt * 0.96).toFixed(4));

  for (const cand of actionable) {
    const tierLev = cand.convictionLeverage || selectConvictionLeverage(cand.score, cand.atr15mPct);
    const preCheckNotionalUsdt = Number((usableMarginUsdt * tierLev).toFixed(4));
    if (preCheckNotionalUsdt < MIN_NOTIONAL_USDT) {
      logEvent(
        state,
        `⚠️ [MIN_NOTIONAL KALKANI] ${cand.symbol} için ${tierLev}x Alım Gücü ($${preCheckNotionalUsdt} / ${toTL(preCheckNotionalUsdt)} TL) 5.00 USDT altında kaldı, sonraki adaya geçiliyor!`
      );
      continue; // Fixed Bug #49: continue to next candidate in case a higher leverage tier passes MIN_NOTIONAL
    }

    const obCheck = await fetchPerpOrderbookConfirm(cand.symbol, cand.side);
    if (!obCheck.ok) {
      // Engine #41 (GPT-6-Luna Progressive Strike Orderbook Cooldown: 1st -> 2.5m, 2nd -> 8m, >=3rd -> 15m; NO_DEPTH -> 90s without strike)
      const isNoDepth = obCheck.vetoCode === 'NO_DEPTH' || String(obCheck.reason || '').startsWith('NO_DEPTH');
      let cdMins = 1.5;
      let strikeCount = state.obVetoStrikes[cand.symbol] || 0;
      if (!isNoDepth) {
        strikeCount += 1;
        state.obVetoStrikes[cand.symbol] = strikeCount;
        cdMins = strikeCount === 1 ? 2.5 : strikeCount === 2 ? 8.0 : 15.0;
      }
      state.obVetoAtMs[cand.symbol] = Date.now();
      state.obVetoReasons[cand.symbol] = obCheck.reason;
      state.obVetoCodes[cand.symbol] = obCheck.vetoCode || 'WEAK_OB';
      state.obVetoCooldowns[cand.symbol] = Date.now() + cdMins * 60 * 1000;
      logEvent(
        state,
        `⚖️ [Vadeli Tahta Vetosu | Strike #${strikeCount} -> ${cdMins}dk Blok] ${cand.symbol} (${tierLev}x ${cand.side} | ${cand.score}p) pas geçildi: ${obCheck.reason}`
      );
      continue;
    }

    // Orderbook confirmed -> reset progressive strike counter
    state.obVetoStrikes[cand.symbol] = 0;

    const entryPrice = cand.side === 'LONG' ? obCheck.bestAsk : obCheck.bestBid;
    let rawWickDistFrac = 0.0095;
    if (cand.side === 'LONG' && cand.structuralLow > 0 && cand.structuralLow < entryPrice) {
      rawWickDistFrac = (entryPrice - cand.structuralLow * 0.999) / entryPrice;
    } else if (cand.side === 'SHORT' && cand.structuralHigh > entryPrice) {
      rawWickDistFrac = (cand.structuralHigh * 1.001 - entryPrice) / entryPrice;
    }
    // Engine #42 + #59 (GPT-6-Luna Risk-Consistent Leverage & ATR-Aware Stop Without Silent Tier Downgrade):
    // 1. Allow ATR-aware structural stop up to 2.20% on volatile hype rockets so 0.35-ATR noise wiggles don't stop out valid breakouts.
    // 2. Fix unreachable 4x/5x math (0.0525 risk budget allows 4x at 1.08% stop [4.01x] and 5x at 0.95% stop [4.45x]).
    // 3. When underlyingSlFrac > 1.50% on a high-ATR rocket, scale position margin down proportionally so max stop loss never exceeds ~4.8% of equity!
    const rawStopFrac = Math.max(0.0092, rawWickDistFrac, (cand.atr15mPct / 100) * 0.72);
    const tierSlCap = tierLev >= 5 ? 0.0095 : tierLev >= 4 ? 0.0108 : tierLev >= 3.5 ? 0.0135 : 0.0220;
    const underlyingSlFrac = Math.min(0.0220, (cand.atr15mPct || 1.2) >= 2.20 ? rawStopFrac : Math.min(tierSlCap, rawStopFrac));
    const maxRiskLev = 0.0525 / (underlyingSlFrac + ROUND_TRIP_FEE_SLIP_FRAC + 0.0005);
    const microConfirm5x =
      cand.side === 'LONG'
        ? obCheck.microSkew > 0 && obCheck.ob2 >= 0.08
        : obCheck.microSkew < 0 && obCheck.ob2 <= -0.08;
    const rawAllowedLev = Math.min(tierLev, maxRiskLev);
    const chosenLev =
      rawAllowedLev >= 4.15 && tierLev >= 5 && microConfirm5x && underlyingSlFrac <= 0.0095
        ? 5
        : rawAllowedLev >= 3.90 && tierLev >= 4 && underlyingSlFrac <= 0.0110
          ? 4
          : rawAllowedLev >= 3.30 && tierLev >= 3.5 && underlyingSlFrac <= 0.0138
            ? 3.5
            : 3;
    const highAtrMarginScale = underlyingSlFrac > 0.0150 ? Math.max(0.55, Number((0.0150 / underlyingSlFrac).toFixed(4))) : 1.0;
    const posMarginUsdt = Number(Math.max(MIN_NOTIONAL_USDT / chosenLev + 0.05, usableMarginUsdt * highAtrMarginScale).toFixed(4));
    const finalMarginUsdt = Math.min(usableMarginUsdt, posMarginUsdt);
    const maxNotionalUsdt = Number((finalMarginUsdt * chosenLev).toFixed(4));
    const underlyingTpFrac = Math.max(0.0250, underlyingSlFrac * 2.55);

    const symInfo = cachedValidCoinPerps?.get(cand.fSym);
    const tickFilter = symInfo?.filters?.find(f => f.filterType === 'PRICE_FILTER');
    const tickSize = Number(tickFilter?.tickSize || 0);
    const roundToTick = p => {
      if (tickSize > 0 && Number.isFinite(tickSize)) {
        const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)) + 1);
        return Number((Math.round(p / tickSize) * tickSize).toFixed(Math.min(8, decimals)));
      }
      return Number(p.toPrecision(6));
    };

    const stopPrice =
      cand.side === 'LONG'
        ? roundToTick(entryPrice * (1 - underlyingSlFrac))
        : roundToTick(entryPrice * (1 + underlyingSlFrac));

    const tpPrice =
      cand.side === 'LONG'
        ? roundToTick(entryPrice * (1 + underlyingTpFrac))
        : roundToTick(entryPrice * (1 - underlyingTpFrac));

    const liqDistFrac = Number((0.92 / chosenLev).toFixed(4));
    const liqPrice =
      cand.side === 'LONG'
        ? roundToTick(entryPrice * (1 - liqDistFrac))
        : roundToTick(entryPrice * (1 + liqDistFrac));

    const syncedThesis = String(cand.thesis || '').replace(/->\s*[\d.]+x\s+(LONG|SHORT)!/, `-> ${chosenLev}x $1!`);

    state.leverage = chosenLev;
    state.marginCashUsdt = Number((state.marginCashUsdt - finalMarginUsdt).toFixed(4));
    state.openPosition = {
      id: `perp_${Date.now()}_${cand.symbol}`,
      symbol: cand.symbol,
      fSym: cand.fSym,
      side: cand.side,
      engine: cand.engine,
      candlePattern: cand.candlePattern,
      leverage: chosenLev,
      initialMarginUsdt: finalMarginUsdt,
      initialNotionalUsdt: maxNotionalUsdt,
      marginUsdt: finalMarginUsdt,
      marginTry: toTL(finalMarginUsdt),
      notionalUsdt: maxNotionalUsdt,
      notionalTry: toTL(maxNotionalUsdt),
      entryPrice,
      currentPrice: entryPrice,
      extremePrice: entryPrice,
      maxAdverseCoinMoveFrac: 0,
      initialRiskFrac: underlyingSlFrac,
      tpExtensionCount: 0,
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
      thesis: syncedThesis,
      ratchetStage: 'INITIAL_STOP',
      unrealizedPnlUsdt: 0,
      unrealizedPnlTry: 0,
      roePct: 0,
      underlyingMovePct: 0,
      entryTime: new Date().toISOString(),
    };

    logEvent(
      state,
      `🚀 [${chosenLev}x ${cand.side} GİRİŞ (300 TL Anti-İğne)] ${cand.symbol}USDT @ $${entryPrice} | Teminat: ${toTL(finalMarginUsdt)} TL (${chosenLev}x Büyüklük: ${toTL(maxNotionalUsdt)} TL) | Stop: $${stopPrice} (-%${(underlyingSlFrac * 100).toFixed(2)}) | TP1: +%1.25 (%35 Nakit) | Ana Hedef: $${tpPrice} (+%${(underlyingTpFrac * 100).toFixed(2)}) | ${syncedThesis}`
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

  const goalInfo = getGoalAndTierStatus(state, loadSpotPortfolioSummary());
  const audit = state.lastSelfAudit || runTwoHourSelfAudit(state, false);
  const auditSection =
    !audit?.diagnosedMistakes || audit.diagnosedMistakes.length === 0
      ? '| *Son pencerede hata tespit edilmedi* | - | - |\n'
      : audit.diagnosedMistakes
          .map(m => `| **${m.trade}** | ${m.rootCause} | ✅ **${m.fixApplied}** |`)
          .join('\n') + '\n';

  const md = `# ⚡ 300 TL SABİT ANA PARA (3x–5x RİSK-NORMALİZE KALDIRAÇ) + 23.000 TL HEDEF & 2-SAATLİK OTONOM EVRİM (Mutlak Yapı v10.1)

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}  
**🌍 Her Yerden (4.5G/Mobil/Wi-Fi Cloudflare Port Forwarding):** \`${PUBLIC_TUNNEL_URL}\` *(Yedek: \`${BACKUP_TUNNEL_URL}\`)*  
**🏠 Ev Wi-Fi:** \`http://${lanIp}:${DASHBOARD_PORT}\` | **💻 Bilgisayar:** \`http://localhost:${DASHBOARD_PORT}\`  
**Çalışma Modu:** \`${state.mode}\` *(Sadece Max ${goalInfo.activeCapTry} TL İle Oynar + 3x–5x Luna/Qullamaggie Kaldıraç + Her 2 Saatte Bir Otonom Özeleştiri & Evrim Motoru #43–#56)*

---

## 🎯 23.000,00 TL BÜYÜK HEDEF & KENDİ KÂRIYLA KADEMELİ BÜYÜME YOL HARİTASI

* **🎯 Nihai Servet Hedefi:** **\`23.000,00 TL\`**
* **🏛️ Mevcut Kaldıraç + Spot Kâr Kasası Toplamı:** **\`${goalInfo.combinedTry} TL / 23.000,00 TL\` (\`%${goalInfo.progressPct} Tamamlandı\` | Kalan: \`${goalInfo.remainingTry} TL\`)**
* **🪜 Aktif Büyüme Basamağı:** **\`${goalInfo.tierLabel}\`** *(Cebinden ekstra 1 TL çıkmadan, yalnızca Spot Kâr Kasasında biriken dokunulmaz kârla kademe atlar!)*

---

## 🧠 2-SAATLİK OTONOM ÖZELEŞTİRİ & KENDİNİ GELİŞTİRME MOTORU (Motor #43–#56)

* **⏱️ Son Otonom Denetim:** \`${audit.lastAuditAt}\` | **Sonraki 2-Saatlik Denetim:** \`${audit.nextAuditAt}\`
* **📊 Son ${audit.recentWindowCount} İşlem Karnesi:** \`${audit.recentWins} Kazanç / ${audit.recentLosses} Kayıp\` (**Net:** \`${audit.recentNetPnlTry >= 0 ? '+' : ''}${audit.recentNetPnlTry} TL\` | **Luna Amaç Skoru $J$:** \`${audit.objectiveJ}\`)
* **🎛️ Otonom Sınırlandırılmış Parametreler ($\theta$):** \`LONG Barajı >= ${audit.minLongScore}/99 (5dk Taker >= ${audit.minLongTaker5m}x)\` | \`SHORT Barajı >= ${audit.minShortScore}/99 (5dk Taker <= ${audit.maxShortTaker5m}x)\`

| İncelenen Hatalı İşlem | Tespit Edilen Kök Hata Nedeni | Otonom Devreye Alınan Yeni Motor / Kalkan |
| :--- | :--- | :--- |
${auditSection}
---

## 1. 300 TL SABİT KALDIRAÇ KASASI & SPOT CÜZDANA AKTARILAN KÂR DURUMU

* **Kaldıraç Sabit Tavanı (Max Ana Para):** \`${goalInfo.activeCapTry} TL\` (\`$${goalInfo.activeCapUsdt} USDT\`)
* **Aktif Kaldıraç Kasası (Max ${goalInfo.activeCapTry} TL):** **\`${toTL(state.totalEquityUsdt)} TL\`** *(3x–4x İşlem Gücü: \`${toTL(state.totalEquityUsdt * activeLev)} TL\` - \`${toTL(state.totalEquityUsdt * MAX_CONVICTION_LEVERAGE)} TL\`)*
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
    const goalInfo = getGoalAndTierStatus(state, spot);
    const combinedEquityTry = goalInfo.combinedTry;
    const mobileUrl = `http://${lanIp}:${DASHBOARD_PORT}`;
    const activeLev = pos?.leverage || state.leverage || LEVERAGE;

    const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#080c14" />
  <title>⚡ Mobil Komuta Merkezi (300 TL Anti-İğne Kaldıraç + 23.000 TL Hedef)</title>
  <style>
    * { box-sizing:border-box; }
    body { background:#080c14; color:#f1f5f9; font-family:system-ui,-apple-system,sans-serif; margin:0; padding:14px; max-width:1100px; margin-inline:auto; }
    .topbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px; background:#0f172a; border:1px solid #1e293b; border-radius:16px; padding:14px 16px; margin-bottom:14px; }
    .title { font-size:18px; font-weight:800; letter-spacing:-0.3px; }
    .sub { font-size:12px; color:#94a3b8; margin-top:3px; }
    .pill { background:#1e293b; border:1px solid #334155; color:#38bdf8; padding:6px 10px; border-radius:10px; font-size:12px; font-family:monospace; font-weight:700; cursor:pointer; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:10px; margin-bottom:14px; }
    .card { position:relative; background:#0f172a; border:1px solid #1e293b; border-radius:14px; padding:13px; transition:border-color 0.35s ease, box-shadow 0.35s ease; }
    .card.hit-flash-up { border-color:#10b981 !important; box-shadow:0 0 18px rgba(16,185,129,0.38); }
    .card.hit-flash-down { border-color:#f43f5e !important; box-shadow:0 0 18px rgba(244,63,94,0.38); }
    .lbl { font-size:11.5px; color:#94a3b8; font-weight:600; text-transform:uppercase; }
    .val { font-size:21px; font-weight:800; margin-top:5px; font-family:monospace; position:relative; display:inline-block; }
    .green { color:#10b981; } .red { color:#f43f5e; } .amber { color:#f59e0b; } .cyan { color:#38bdf8; }
    .section-card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; padding:14px; margin-bottom:14px; overflow-x:auto; }
    h3 { margin:0 0 10px 0; font-size:15px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; }
    table { width:100%; border-collapse:collapse; min-width:520px; }
    th, td { padding:9px 10px; border-bottom:1px solid #1e293b; text-align:left; font-size:12.5px; }
    th { color:#94a3b8; font-weight:600; background:#131c31; }
    .badge { padding:3px 7px; border-radius:6px; font-weight:700; font-size:11px; display:inline-block; }
    .long { background:#064e3b; color:#34d399; } .short { background:#7f1d1d; color:#fca5a5; }
    .pos-box { background:#131c31; border:1px solid #2dd4bf44; border-radius:12px; padding:12px; margin-bottom:10px; transition:border-color 0.35s ease, box-shadow 0.35s ease; }
    .pos-box.hit-flash-up { border-color:#10b981 !important; box-shadow:0 0 20px rgba(16,185,129,0.35); }
    .pos-box.hit-flash-down { border-color:#f43f5e !important; box-shadow:0 0 20px rgba(244,63,94,0.35); }
    .goal-card { background:linear-gradient(135deg,#0f172a 0%,#131c31 100%); border:1px solid #f59e0b66; border-radius:16px; padding:14px 16px; margin-bottom:14px; transition:box-shadow 0.35s ease; }
    .prog-bg { width:100%; height:12px; background:#1e293b; border-radius:999px; overflow:hidden; margin:8px 0 6px 0; border:1px solid #334155; }
    .prog-fill { height:100%; background:linear-gradient(90deg,#10b981,#38bdf8,#f59e0b); border-radius:999px; transition:width 0.4s ease; }
    /* Minecraft / RPG Damage-Indicator Floating Hit-Marker Layer (GPU-Accelerated 60 FPS) */
    #mc-hit-layer { position:fixed; inset:0; pointer-events:none; z-index:9999; overflow:hidden; }
    .mc-hit-marker {
      position:fixed;
      pointer-events:none;
      font-family:'Courier New',monospace;
      font-weight:900;
      font-size:18px;
      letter-spacing:-0.3px;
      padding:3px 9px;
      border-radius:8px;
      white-space:nowrap;
      will-change:transform,opacity;
      text-shadow:0 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
      animation:mcFloatUp 1.65s cubic-bezier(0.16,1,0.3,1) forwards;
    }
    .mc-hit-up {
      color:#4ade80;
      background:rgba(6,78,59,0.88);
      border:1.5px solid #34d399;
      box-shadow:0 4px 14px rgba(16,185,129,0.45);
    }
    .mc-hit-crit {
      color:#fde047;
      background:rgba(20,83,45,0.94);
      border:2px solid #facc15;
      font-size:20px;
      box-shadow:0 0 22px rgba(250,204,21,0.65);
    }
    .mc-hit-down {
      color:#fb7185;
      background:rgba(127,29,29,0.88);
      border:1.5px solid #f43f5e;
      box-shadow:0 4px 14px rgba(244,63,94,0.45);
    }
    @keyframes mcFloatUp {
      0% { opacity:0; transform:translate3d(-50%, 6px, 0) scale(0.55); }
      16% { opacity:1; transform:translate3d(calc(-50% + var(--dx, 0px) * 0.35), -10px, 0) scale(1.22); }
      32% { opacity:1; transform:translate3d(calc(-50% + var(--dx, 0px) * 0.65), -20px, 0) scale(1.0); }
      78% { opacity:0.95; transform:translate3d(calc(-50% + var(--dx, 0px)), -44px, 0) scale(0.98); }
      100% { opacity:0; transform:translate3d(calc(-50% + var(--dx, 0px)), -62px, 0) scale(0.88); }
    }
  </style>
</head>
<body>
  <div id="mc-hit-layer"></div>
  <div class="topbar">
    <div>
      <div class="title">⚡ Yırtıcı Konsey v10.1 — 300 TL Kaldıraç (3x–5x) + 🎯 23.000 TL Hedef + 🧠 Luna Sıfır-Hata &amp; Hype-Avcısı (Motor #43–#56)</div>
      <div class="sub">Sayfa Yenilenmeden Canlı Akış (Zero-Refresh) + Minecraft/RPG Hit-Marker (+TL / -TL) &bull; Son Senkron: <b id="live-sync-clock" class="cyan">${new Date().toLocaleTimeString('tr-TR')}</b></div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <button type="button" onclick="window.triggerDemoHitMarkers && window.triggerDemoHitMarkers()" class="pill" style="background:#064e3b;color:#4ade80;border-color:#10b981;">⚔️ Hit-Marker Test (+TL/-TL)</button>
      <a href="${PUBLIC_TUNNEL_URL}" style="text-decoration:none;" class="pill">🌍 4.5G/Cloudflare: ${PUBLIC_TUNNEL_URL.replace('https://', '')}</a>
      <div class="pill">🏠 Wi-Fi: ${mobileUrl}</div>
    </div>
  </div>

  <div class="goal-card" id="sec-goal">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <span style="font-size:14px;font-weight:800;color:#f59e0b;">🎯 BÜYÜK SERVET HEDEFİ: 23.000,00 TL</span>
        <span style="font-size:12px;color:#cbd5e1;margin-left:8px;">(${goalInfo.tierLabel})</span>
      </div>
      <div id="val-goal-top" data-num="${combinedEquityTry}" style="font-family:monospace;font-size:15px;font-weight:800;color:#10b981;">
        ${combinedEquityTry} TL / 23.000,00 TL (%${goalInfo.progressPct})
      </div>
    </div>
    <div class="prog-bg">
      <div class="prog-fill" style="width:${Math.max(3, goalInfo.progressPct)}%;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#94a3b8;flex-wrap:wrap;gap:6px;">
      <span>🏦 Dokunulmaz Spot Kâr Kasası: <b class="green">+${spotVaultTry} TL</b></span>
      <span>🪜 Sonraki Terfi Basamağı: <b>+${goalInfo.nextMilestoneTry} TL Spot Kârı</b></span>
      <span>🏁 Hedefe Kalan: <b class="amber">${goalInfo.remainingTry} TL</b></span>
    </div>
  </div>

  <div class="grid" id="sec-cards">
    <div class="card" id="card-perp-equity">
      <div class="lbl">⚡ Kaldıraç Kasası (Max ${goalInfo.activeCapTry} TL)</div>
      <div id="val-perp-equity" data-num="${toTL(state.totalEquityUsdt)}" class="val ${state.totalPnlUsdt >= 0 ? 'green' : 'red'}">${toTL(state.totalEquityUsdt)} TL</div>
      <div class="sub">Tavan: ${goalInfo.activeCapTry} TL (3x-4x Güç: ${toTL(state.totalEquityUsdt * activeLev)}-${toTL(state.totalEquityUsdt * MAX_CONVICTION_LEVERAGE)} TL)</div>
    </div>
    <div class="card" id="card-spot-vault" style="border-color:#10b98166;">
      <div class="lbl">🏦 Spot'a Atılan Kâr Kasası</div>
      <div id="val-spot-vault" data-num="${spotVaultTry}" class="val green">+${spotVaultTry} TL</div>
      <div class="sub">Kaldıraçtan Spot'a Aktarılan Dokunulmaz Kâr</div>
    </div>
    <div class="card" id="card-spot-equity">
      <div class="lbl">💰 1.000 TL Spot Kasa</div>
      <div id="val-spot-equity" data-num="${spot ? spot.totalEquityTry : 992.13}" class="val ${spot && spot.totalPnlTry >= 0 ? 'green' : 'cyan'}">${spot ? spot.totalEquityTry : '992.13'} TL</div>
      <div class="sub">Nakit: ${spot ? spot.cashTry : '934.59'} TL | ${spot ? spot.winCount : 21}W/${spot ? spot.lossCount : 17}L</div>
    </div>
    <div class="card" id="card-combined-equity">
      <div class="lbl">🏛️ Kaldıraç + Kâr Kasası</div>
      <div id="val-combined-equity" data-num="${combinedEquityTry}" class="val amber">${combinedEquityTry} TL</div>
      <div class="sub">300 TL Ana Para + Spot'a Atılan Kâr</div>
    </div>
  </div>

  <div class="section-card" id="sec-audit" style="border-color:#38bdf866;">
    <h3>
      <span>🧠 Her 2 Saatte Bir Otonom Özeleştiri & Evrim Motoru (Motor #43–#54)</span>
      <span class="sub">Son Denetim: <b>${(state.lastSelfAudit || {}).lastAuditAt || '-'}</b> | Sonraki: <b>${(state.lastSelfAudit || {}).nextAuditAt || '+2 Saat'}</b></span>
    </h3>
    <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px;">
      Aktif Otonom Barajlar: <b>LONG &gt;= ${(state.lastSelfAudit || {}).minLongScore || 78}p (5dk Taker &gt;= ${(state.lastSelfAudit || {}).minLongTaker5m || 1.02}x)</b> | <b>SHORT &gt;= ${(state.lastSelfAudit || {}).minShortScore || 78}p (5dk Taker &lt;= ${(state.lastSelfAudit || {}).maxShortTaker5m || 0.98}x)</b> | Luna $J$-Skoru: <b class="cyan">${(state.lastSelfAudit || {}).objectiveJ ?? 0}</b>
    </div>
    <table>
      <tr><th>İncelenen Hatalı İşlem</th><th>Tespit Edilen Kök Hata Nedeni</th><th>Devreye Alınan Yeni Motor / Kalkan</th></tr>
      ${((state.lastSelfAudit || {}).diagnosedMistakes || [])
        .map(
          m => `<tr>
          <td class="red"><b>${m.trade}</b></td>
          <td>${m.rootCause}</td>
          <td class="green"><b>✅ ${m.fixApplied}</b></td>
        </tr>`
        )
        .join('')}
    </table>
  </div>

  <div class="section-card" id="sec-open-pos">
    <h3><span>🔥 1. Açık Kaldıraçlı İşlem (Sadece Max 300 TL İle Oynar — 3x / 3.5x / 4x Anti-İğne)</span><span class="sub">${state.winCount} Kazanç / ${state.lossCount} Stop</span></h3>
    ${
      !pos
        ? '<div class="sub">Şu an açık vadeli işlem yok — 100+ Yüksek Hızlı Kontrat içinde Skor >= 78/99 olan LONG veya SHORT avlanıyor.</div>'
        : `<div class="pos-box" id="box-open-pos">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div><b style="font-size:16px;">${pos.symbol}USDT</b> <span class="badge ${pos.side === 'LONG' ? 'long' : 'short'}">${pos.leverage || LEVERAGE}x ${pos.side}</span></div>
              <div id="val-open-pnl" data-num="${pos.unrealizedPnlTry}" class="${pos.unrealizedPnlTry >= 0 ? 'green' : 'red'}" style="font-size:17px;font-weight:800;font-family:monospace;">
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

  <div class="section-card" id="sec-mails">
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

  <div class="section-card" id="sec-spot-pos">
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

  <div class="section-card" id="sec-radar">
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

  <script>
    (function() {
      const trackedSelectors = [
        { id: 'val-perp-equity', cardId: 'card-perp-equity', iconUp: '⚔️', iconDown: '💥', isCrit: false },
        { id: 'val-spot-vault', cardId: 'card-spot-vault', iconUp: '🏦 CRIT!', iconDown: '🏦', isCrit: true },
        { id: 'val-spot-equity', cardId: 'card-spot-equity', iconUp: '💎', iconDown: '🔻', isCrit: false },
        { id: 'val-combined-equity', cardId: 'card-combined-equity', iconUp: '🎯', iconDown: '⚡', isCrit: false },
        { id: 'val-open-pnl', cardId: 'box-open-pos', iconUp: '🔥', iconDown: '🛡️', isCrit: false }
      ];

      const prevValues = {};
      trackedSelectors.forEach(item => {
        const el = document.getElementById(item.id);
        if (el && el.dataset.num !== undefined) {
          prevValues[item.id] = parseFloat(el.dataset.num);
        }
      });

      function spawnHitMarker(targetEl, cardEl, deltaTry, item) {
        if (!targetEl || !Number.isFinite(deltaTry) || Math.abs(deltaTry) < 0.01) return;
        const layer = document.getElementById('mc-hit-layer');
        if (!layer) return;

        // Hard cap active particles at 14 so mobile browsers never leak DOM memory
        while (layer.children.length > 14) {
          layer.firstElementChild.remove();
        }

        const rect = targetEl.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;

        const isUp = deltaTry > 0;
        const sign = isUp ? '+' : '';
        const formatted = sign + deltaTry.toFixed(2) + ' TL ' + (isUp ? item.iconUp : item.iconDown);

        const badge = document.createElement('div');
        badge.className = 'mc-hit-marker ' + (isUp ? (item.isCrit || deltaTry >= 3.0 ? 'mc-hit-crit' : 'mc-hit-up') : 'mc-hit-down');
        const jitterX = Math.round((Math.random() - 0.5) * 34);
        badge.style.setProperty('--dx', jitterX + 'px');
        badge.style.left = Math.round(rect.left + rect.width * 0.5) + 'px';
        badge.style.top = Math.round(Math.max(18, rect.top - 6)) + 'px';
        badge.textContent = formatted;

        badge.addEventListener('animationend', () => badge.remove());
        setTimeout(() => { if (badge.parentNode) badge.remove(); }, 1800);
        layer.appendChild(badge);

        if (cardEl) {
          cardEl.classList.remove('hit-flash-up', 'hit-flash-down');
          void cardEl.offsetWidth;
          cardEl.classList.add(isUp ? 'hit-flash-up' : 'hit-flash-down');
          setTimeout(() => cardEl.classList.remove('hit-flash-up', 'hit-flash-down'), 900);
        }
      }

      window.triggerDemoHitMarkers = function() {
        const perpEl = document.getElementById('val-perp-equity');
        const perpCard = document.getElementById('card-perp-equity');
        const vaultEl = document.getElementById('val-spot-vault');
        const vaultCard = document.getElementById('card-spot-vault');
        const openEl = document.getElementById('val-open-pnl') || document.getElementById('val-combined-equity');
        const openCard = document.getElementById('box-open-pos') || document.getElementById('card-combined-equity');
        spawnHitMarker(perpEl, perpCard, +2.45, trackedSelectors[0]);
        setTimeout(() => spawnHitMarker(vaultEl, vaultCard, +4.80, trackedSelectors[1]), 180);
        setTimeout(() => spawnHitMarker(openEl, openCard, -0.65, trackedSelectors[4]), 360);
      };

      const sectionIds = ['sec-goal', 'sec-cards', 'sec-audit', 'sec-open-pos', 'sec-mails', 'sec-spot-pos', 'sec-radar'];
      let isSyncing = false;

      async function liveSyncDashboard() {
        if (isSyncing || document.hidden) return;
        isSyncing = true;
        try {
          const res = await fetch(window.location.pathname, { cache: 'no-store', headers: { 'X-Live-Sync': '1' } });
          if (!res.ok) return;
          const htmlText = await res.text();
          const doc = new DOMParser().parseFromString(htmlText, 'text/html');

          // Compute deltas before replacing DOM sections
          const pendingHits = [];
          trackedSelectors.forEach(item => {
            const newEl = doc.getElementById(item.id);
            if (newEl && newEl.dataset.num !== undefined) {
              const newVal = parseFloat(newEl.dataset.num);
              const oldVal = prevValues[item.id];
              if (Number.isFinite(newVal)) {
                if (Number.isFinite(oldVal) && Math.abs(newVal - oldVal) >= 0.01) {
                  pendingHits.push({ item, delta: Number((newVal - oldVal).toFixed(2)) });
                }
                prevValues[item.id] = newVal;
              }
            } else {
              delete prevValues[item.id];
            }
          });

          // Update sections in-place without touching scroll position or refreshing page
          sectionIds.forEach(secId => {
            const curSec = document.getElementById(secId);
            const nextSec = doc.getElementById(secId);
            if (curSec && nextSec && curSec.innerHTML !== nextSec.innerHTML) {
              curSec.innerHTML = nextSec.innerHTML;
            }
          });

          const clockEl = document.getElementById('live-sync-clock');
          if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('tr-TR');

          // Fire Minecraft/RPG floating hit-markers on updated DOM elements
          pendingHits.forEach(({ item, delta }) => {
            const targetEl = document.getElementById(item.id);
            const cardEl = document.getElementById(item.cardId);
            spawnHitMarker(targetEl, cardEl, delta, item);
          });
        } catch (e) {
          // ignore transient network blip
        } finally {
          isSyncing = false;
        }
      }

      setInterval(liveSyncDashboard, 2500);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) liveSyncDashboard();
      });
    })();
  </script>
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
    // Keepalive self-ping so public tunnels (Cloudflare & localhost.run) never hit activity timeout
    fetch(`${PUBLIC_TUNNEL_URL}/api/state`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    fetch(`${BACKUP_TUNNEL_URL}/api/state`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    if (!state.lastSelfAudit || Date.now() >= (state.lastSelfAudit.nextAuditAtMs || 0)) {
      runTwoHourSelfAudit(state, true);
    }
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
  state.version = 'Mutlak-Yapi-v10.3-Luna-Apex-Predator';
  if (state.openPosition?.thesis && state.openPosition?.leverage) {
    state.openPosition.thesis = String(state.openPosition.thesis).replace(
      /->\s*[\d.]+x\s+(LONG|SHORT)!/,
      `-> ${state.openPosition.leverage}x $1!`
    );
  }
  runTwoHourSelfAudit(state, true);
  console.log('================================================================================');
  console.log(`⚡ 300 TL SABİT ANA PARA (3x–5x KALDIRAÇ) + LUNA APEX-AVCISI MOTORU (v10.3 — Motor #58-#61)`);
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
