import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import tls from 'tls';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { buildDualAiPartnerConsensus, queryFreebuffCouncil } from './freebuff_council_bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const STATE_FILE = path.join(__dirname, 'leverage_3x_state.json');
const REPORT_FILE = path.join(__dirname, 'KALDIRAC_3X_RAPOR.md');
const NEWS_SIGNALS_FILE = path.join(ROOT_DIR, 'altcoin_news_signals.json');
const SPOT_STATE_FILE = path.join(ROOT_DIR, 'portfolio_state.json');
const ENV_FILE = path.join(ROOT_DIR, '.env');

const FAPI_BASE = 'https://fapi.binance.com';
let USD_TRY_RATE = 49.55;
let lastUsdTrySyncMs = 0;
const LEVERAGE = 3; // Base Low-Wick Institutional Leverage (300 TL -> 3x = 900 TL, 3.5x = 1.050 TL, 4x = 1.200 TL, 5x = 1.500 TL)
const MAX_CONVICTION_LEVERAGE = 5;
const INITIAL_BANKROLL_TRY = 300.0;
const INITIAL_BANKROLL_USDT = Number((INITIAL_BANKROLL_TRY / USD_TRY_RATE).toFixed(4)); // ~6.0545 USDT
const TARGET_GOAL_TRY = 23000.0; // User's Ultimate Wealth Goal (23.000 TL)
const MIN_NOTIONAL_USDT = 5.0; // Binance Futures hard minimum notional floor
const ROUND_TRIP_FEE_SLIP_FRAC = 0.0018; // 0.05% taker entry + 0.05% taker exit + 0.08% perp slippage on notional
const DASHBOARD_PORT = 3848;
const TUNNEL_LOG_FILE = path.join(__dirname, '.cloudflared_tunnel.log');
let PUBLIC_TUNNEL_URL = 'https://absence-coding-laid-spoken.trycloudflare.com';
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

function roundPriceToTick(fSym, rawPrice, mode = 'nearest') {
  const p = Number(rawPrice || 0);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const symInfo = cachedValidCoinPerps?.get(fSym);
  const tickFilter = symInfo?.filters?.find(f => f.filterType === 'PRICE_FILTER' && Number(f.tickSize || 0) > 0);
  const tickStr = String(tickFilter?.tickSize || '');
  const tickSize = Number(tickStr || 0);
  if (tickSize > 0 && Number.isFinite(tickSize)) {
    const decimals = tickStr.includes('.')
      ? (tickStr.split('.')[1] || '').replace(/0+$/, '').length
      : Math.max(0, -Math.floor(Math.log10(tickSize)));
    const ratio = p / tickSize;
    const steps =
      mode === 'floor'
        ? Math.floor(ratio + 1e-9)
        : mode === 'ceil'
          ? Math.ceil(ratio - 1e-9)
          : Math.round(ratio);
    return Number((steps * tickSize).toFixed(Math.min(12, Math.max(0, decimals))));
  }
  return Number(p.toPrecision(6));
}

function roundQtyToStep(fSym, rawQty) {
  const q = Number(rawQty || 0);
  if (!Number.isFinite(q) || q <= 0) return 0;
  const symInfo = cachedValidCoinPerps?.get(fSym);
  const lotFilter =
    symInfo?.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE' && Number(f.stepSize || 0) > 0) ||
    symInfo?.filters?.find(f => f.filterType === 'LOT_SIZE' && Number(f.stepSize || 0) > 0);
  const stepStr = String(lotFilter?.stepSize || '');
  const stepSize = Number(stepStr || 0);
  const minQty = Number(lotFilter?.minQty || 0);
  const maxQty = Number(lotFilter?.maxQty || 0);
  if (stepSize > 0 && Number.isFinite(stepSize)) {
    const decimals = stepStr.includes('.')
      ? (stepStr.split('.')[1] || '').replace(/0+$/, '').length
      : Math.max(0, -Math.floor(Math.log10(stepSize)));
    const clampedQ = maxQty > 0 ? Math.min(q, maxQty) : q;
    const steps = Math.floor(clampedQ / stepSize + 1e-9);
    const quantized = Number((steps * stepSize).toFixed(Math.min(12, Math.max(0, decimals))));
    return quantized >= minQty ? quantized : 0;
  }
  return Number(q.toPrecision(5));
}

// Engine #65-#72: Real Binance Futures (fapi.binance.com) Signed Execution, Reconciliation & Hardware Stop-Market Engine
let fapiTimeOffsetMs = 0;
let lastFapiTimeSyncMs = 0;
let cachedDualSidePosition = false;

async function syncFapiServerTime(force = false) {
  const now = Date.now();
  if (!force && now - lastFapiTimeSyncMs < 5 * 60 * 1000) return fapiTimeOffsetMs;
  const res = await fetchJson(`${FAPI_BASE}/fapi/v1/time`, {}, 3000);
  if (res && Number.isFinite(Number(res.serverTime))) {
    fapiTimeOffsetMs = Number(res.serverTime) - Date.now();
    lastFapiTimeSyncMs = now;
  }
  return fapiTimeOffsetMs;
}

function getFapiCredentials() {
  const cfg = loadEnv();
  const apiKey = (cfg.BINANCE_FUTURES_API_KEY || cfg.BINANCE_API_KEY || '').trim();
  const secretKey = (cfg.BINANCE_FUTURES_SECRET_KEY || cfg.BINANCE_SECRET_KEY || '').trim();
  const liveEnabled =
    String(cfg.LIVE_FUTURES_TRADING || cfg.LIVE_TRADING || 'true').toLowerCase() !== 'false';
  return { apiKey, secretKey, liveEnabled: Boolean(apiKey && secretKey && liveEnabled) };
}

async function fapiSignedRequest(method, endpoint, paramsObj = {}, timeoutMs = 5500, baseHost = FAPI_BASE) {
  const { apiKey, secretKey, liveEnabled } = getFapiCredentials();
  if (!liveEnabled) return null;
  await syncFapiServerTime();
  const buildSignedUrl = () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsObj)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    params.set('timestamp', String(Date.now() + fapiTimeOffsetMs));
    params.set('recvWindow', '5000');
    const sig = crypto.createHmac('sha256', secretKey).update(params.toString()).digest('hex');
    params.set('signature', sig);
    return `${baseHost}${endpoint}?${params.toString()}`;
  };

  const doRequest = async url => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') {
        json._httpOk = res.ok;
        json._status = res.status;
      }
      return json;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let resp = await doRequest(buildSignedUrl());
  if (resp && resp.code === -1021) {
    // Timestamp outside of recvWindow -> force immediate server time resync and retry once
    await syncFapiServerTime(true);
    resp = await doRequest(buildSignedUrl());
  }
  return resp;
}

async function executeFapiToSpotTransfer(amountUsdt) {
  const amt = Number(Number(amountUsdt || 0).toFixed(4));
  if (amt < 0.10) return { ok: false, reason: 'BELOW_MIN_TRANSFER' };
  const res = await fapiSignedRequest(
    'POST',
    '/sapi/v1/asset/transfer',
    {
      type: 'UMFUTURE_MAIN',
      asset: 'USDT',
      amount: String(amt),
    },
    5000,
    'https://api.binance.com'
  );
  if (res && res.tranId) {
    return { ok: true, tranId: res.tranId };
  }
  return { ok: false, reason: res?.msg || 'TRANSFER_NOT_ENABLED' };
}

async function syncLiveFapiAccount(state) {
  const { liveEnabled } = getFapiCredentials();
  if (!liveEnabled) {
    state.fapiAccountStatus = 'SIM_LIVE_FAPI (Gerçek Binance Futures API Anahtarı Bekleniyor)';
    return { ok: false };
  }
  const [acc, dualRes] = await Promise.all([
    fapiSignedRequest('GET', '/fapi/v2/account', {}, 5000),
    fapiSignedRequest('GET', '/fapi/v1/positionSide/dual', {}, 4000),
  ]);
  if (dualRes && typeof dualRes.dualSidePosition === 'boolean') {
    cachedDualSidePosition = dualRes.dualSidePosition;
  }
  if (acc && Array.isArray(acc.assets)) {
    const usdtAsset = acc.assets.find(a => a.asset === 'USDT');
    const walletUsdt = Number(usdtAsset?.walletBalance || acc.totalWalletBalance || 0);
    const availUsdt = Number(usdtAsset?.availableBalance || acc.availableBalance || 0);

    // Engine #72A (GPT-6-Luna Live Exchange Position Reconciliation):
    // Detect if an on-exchange STOP_MARKET or external close flattened state.openPosition between 4-second bot ticks!
    if (state.openPosition?.isLiveFapiOrder && Array.isArray(acc.positions)) {
      const pos = state.openPosition;
      const exchPos = acc.positions.find(p => {
        if (p.symbol !== pos.fSym) return false;
        if (cachedDualSidePosition) return p.positionSide === pos.side;
        return true;
      });
      const exchAmt = exchPos ? Number(exchPos.positionAmt || 0) : 0;
      const absExchAmt = Math.abs(exchAmt);
      const sameDir =
        cachedDualSidePosition ||
        (pos.side === 'LONG' ? exchAmt > 0 : exchAmt < 0);
      if (!sameDir || absExchAmt <= 1e-8) {
        pos.externallyClosedOnExchange = true;
      } else {
        pos.executedQty = absExchAmt;
      }
    }

    if (walletUsdt >= 5.0 || state.mode === 'LIVE_BINANCE_FAPI') {
      const prevMode = state.mode;
      state.mode = 'LIVE_BINANCE_FAPI';
      const reservedVaultUsdt = Number(state.liveReservedVaultUsdt || 0);
      const usableAvailUsdt = Math.max(0, Number((availUsdt - reservedVaultUsdt).toFixed(4)));
      state.fapiAccountStatus = `Aktif (fapi.binance.com — Gerçek Vadeli USDT: $${walletUsdt.toFixed(2)} [${toTL(walletUsdt)} TL] | Kullanılabilir: $${usableAvailUsdt.toFixed(2)})`;
      if (!state.openPosition && walletUsdt >= 5.0) {
        state.marginCashUsdt = usableAvailUsdt;
      }
      if (prevMode !== 'LIVE_BINANCE_FAPI') {
        logEvent(
          state,
          `🏦 [GERÇEK BINANCE FUTURES CÜZDANI AKTİF] fapi.binance.com bağlantısı doğrulandı! Gerçek Vadeli Bakiye: $${walletUsdt.toFixed(2)} USDT (${toTL(walletUsdt)} TL)`
        );
      }
      return { ok: true, walletUsdt, availUsdt: usableAvailUsdt };
    }
    state.fapiAccountStatus = `API Doğrulandı (fapi.binance.com — Vadeli Cüzdan Bakiyesi: $${walletUsdt.toFixed(2)} USDT; Gerçek Emir İçin >= $5.50 USDT Bekleniyor)`;
    return { ok: false, walletUsdt, availUsdt };
  }
  state.fapiAccountStatus = 'SIM_LIVE_FAPI (Mevcut API Anahtarı Binance TR Spot İçin Geçerli — Global Futures API Bekleniyor)';
  return { ok: false };
}

async function syncFapiHardwareStop(pos, refCurrentPrice = 0) {
  if (!pos || !pos.isLiveFapiOrder || !pos.stopPrice) return { ok: false };
  const qStop = roundPriceToTick(pos.fSym, pos.stopPrice, pos.side === 'LONG' ? 'floor' : 'ceil');
  if (qStop <= 0) return { ok: false };
  if (pos.hwStopOrderId && pos.lastSyncedHwStopPrice === qStop) {
    return { ok: true, orderId: pos.hwStopOrderId, stopPrice: qStop };
  }
  const refPx = Number(refCurrentPrice || pos.currentPrice || pos.entryPrice || 0);
  if (refPx > 0) {
    const alreadyCrossed =
      (pos.side === 'LONG' && qStop >= refPx * 0.9995) ||
      (pos.side === 'SHORT' && qStop <= refPx * 1.0005);
    if (alreadyCrossed) {
      return { ok: false, immediateTrigger: true };
    }
  }
  // Engine #72B (GPT-6-Luna Safe Stop Replacement):
  // Cancel only the bot-owned prior stop orderId (never symbol-wide allOpenOrders) before placing the updated STOP_MARKET
  const prevStopOrderId = pos.hwStopOrderId;
  if (prevStopOrderId) {
    await fapiSignedRequest('DELETE', '/fapi/v1/order', { symbol: pos.fSym, orderId: prevStopOrderId }, 4000);
    pos.hwStopOrderId = null;
  }
  const stopParams = {
    symbol: pos.fSym,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: String(qStop),
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  };
  if (cachedDualSidePosition) {
    stopParams.positionSide = pos.side === 'LONG' ? 'LONG' : 'SHORT';
  }
  let res = await fapiSignedRequest('POST', '/fapi/v1/order', stopParams, 4500);
  if (res && res.code === -4130) {
    // Existing closePosition stop order conflicts -> clear open stop orders on this symbol once and retry
    await fapiSignedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: pos.fSym }, 4000);
    res = await fapiSignedRequest('POST', '/fapi/v1/order', stopParams, 4500);
  }
  if (res && res.orderId) {
    pos.lastSyncedHwStopPrice = qStop;
    pos.hwStopOrderId = res.orderId;
    return { ok: true, orderId: res.orderId, stopPrice: qStop };
  }
  return {
    ok: false,
    immediateTrigger: Boolean(res && res.code === -2021),
    reason: res?.msg || 'STOP_ORDER_FAILED',
  };
}

async function executeFapiRealEntry(state, { fSym, side, chosenLev, notionalUsdt, entryPrice, underlyingSlFrac, underlyingTpFrac }) {
  if (state.mode !== 'LIVE_BINANCE_FAPI') return { isLive: false };
  const intLev = Math.max(1, Math.min(5, Math.round(chosenLev)));
  const marginRes = await fapiSignedRequest('POST', '/fapi/v1/marginType', { symbol: fSym, marginType: 'ISOLATED' }, 4000);
  const isIsolatedConfirmed = Boolean(
    marginRes && (marginRes._httpOk || marginRes.code === 200 || marginRes.code === -4046)
  );
  if (!isIsolatedConfirmed) {
    return { isLive: true, ok: false, reason: `ISOLATED_MARGIN_SET_FAILED (${marginRes?.msg || 'NO_RESP'})` };
  }
  const levRes = await fapiSignedRequest('POST', '/fapi/v1/leverage', { symbol: fSym, leverage: intLev }, 4000);
  if (!levRes || Number(levRes.leverage || 0) !== intLev) {
    return { isLive: true, ok: false, reason: `LEVERAGE_SET_FAILED (${levRes?.msg || 'NO_RESP'})` };
  }
  const qty = roundQtyToStep(fSym, notionalUsdt / entryPrice);
  if (qty <= 0 || qty * entryPrice < MIN_NOTIONAL_USDT) {
    return { isLive: true, ok: false, reason: `INVALID_LOT_OR_MIN_NOTIONAL (qty=${qty})` };
  }
  const orderParams = {
    symbol: fSym,
    side: side === 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: String(qty),
    newOrderRespType: 'RESULT',
  };
  if (cachedDualSidePosition) {
    orderParams.positionSide = side === 'LONG' ? 'LONG' : 'SHORT';
  }
  const ord = await fapiSignedRequest('POST', '/fapi/v1/order', orderParams, 5500);
  if (!ord || !ord.orderId || Number(ord.executedQty || 0) <= 0) {
    return { isLive: true, ok: false, reason: `FAPI_ORDER_REJECTED (${ord?.msg || 'NO_FILL'})` };
  }
  const execQty = Number(ord.executedQty);
  const avgPrice = Number(ord.avgPrice || entryPrice) || entryPrice;
  const execNotionalUsdt = Number((execQty * avgPrice).toFixed(4));
  const usedMarginUsdt = Number((execNotionalUsdt / intLev).toFixed(4));
  const liveStopPrice =
    side === 'LONG'
      ? roundPriceToTick(fSym, avgPrice * (1 - underlyingSlFrac), 'floor')
      : roundPriceToTick(fSym, avgPrice * (1 + underlyingSlFrac), 'ceil');
  const liveTpPrice =
    side === 'LONG'
      ? roundPriceToTick(fSym, avgPrice * (1 + underlyingTpFrac), 'ceil')
      : roundPriceToTick(fSym, avgPrice * (1 - underlyingTpFrac), 'floor');

  const tempPos = {
    fSym,
    side,
    entryPrice: avgPrice,
    currentPrice: avgPrice,
    stopPrice: liveStopPrice,
    executedQty: execQty,
    isLiveFapiOrder: true,
    hwStopOrderId: null,
    lastSyncedHwStopPrice: null,
  };
  let stopSync = await syncFapiHardwareStop(tempPos, avgPrice);
  if (!stopSync.ok) {
    stopSync = await syncFapiHardwareStop(tempPos, avgPrice);
  }
  if (!stopSync.ok || !tempPos.hwStopOrderId) {
    // Engine #72C (GPT-6-Luna Zero-Unprotected-Position Guarantee):
    // Never leave a live position open if exchange STOP_MARKET protection fails to place -> immediately unwind!
    await executeFapiRealExit(tempPos, 1.0);
    return {
      isLive: true,
      ok: false,
      reason: `HW_STOP_PLACEMENT_FAILED_EMERGENCY_UNWOUND (${stopSync.reason || 'NO_STOP_ID'})`,
    };
  }
  return {
    isLive: true,
    ok: true,
    orderId: ord.orderId,
    intLev,
    execQty,
    avgPrice,
    execNotionalUsdt,
    usedMarginUsdt,
    liveStopPrice,
    liveTpPrice,
    hwStopOrderId: tempPos.hwStopOrderId,
    hwStopPrice: tempPos.lastSyncedHwStopPrice,
  };
}

async function executeFapiRealExit(pos, closeFraction = 1.0) {
  if (!pos || !pos.isLiveFapiOrder || !pos.executedQty) return { isLive: false };
  const isFullClose = closeFraction >= 0.99;
  const rawCloseQty = isFullClose ? pos.executedQty : pos.executedQty * closeFraction;
  const closeQty = roundQtyToStep(pos.fSym, rawCloseQty);
  if (closeQty <= 0) return { isLive: true, ok: false, reason: 'CLOSE_QTY_ZERO' };
  const closeParams = {
    symbol: pos.fSym,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: String(closeQty),
    newOrderRespType: 'RESULT',
  };
  if (cachedDualSidePosition) {
    closeParams.positionSide = pos.side === 'LONG' ? 'LONG' : 'SHORT';
  } else {
    closeParams.reduceOnly = 'true';
  }
  const ord = await fapiSignedRequest('POST', '/fapi/v1/order', closeParams, 5500);
  if (ord && Number(ord.executedQty || 0) > 0) {
    const filledQty = Number(ord.executedQty);
    pos.executedQty = Math.max(0, Number((pos.executedQty - filledQty).toFixed(8)));
    if (isFullClose || pos.executedQty <= 1e-8) {
      if (pos.hwStopOrderId) {
        await fapiSignedRequest('DELETE', '/fapi/v1/order', { symbol: pos.fSym, orderId: pos.hwStopOrderId }, 4000);
        pos.hwStopOrderId = null;
      } else {
        await fapiSignedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: pos.fSym }, 4000);
      }
    }
    return {
      isLive: true,
      ok: true,
      filledQty,
      avgExitPrice: Number(ord.avgPrice || 0) || null,
    };
  }
  // If Binance returns -2022 ("ReduceOnly Order is rejected"), the position is already closed on the exchange!
  if (ord && ord.code === -2022) {
    pos.executedQty = 0;
    pos.externallyClosedOnExchange = true;
    return { isLive: true, ok: true, alreadyClosedOnExchange: true, filledQty: closeQty, avgExitPrice: null };
  }
  return { isLive: true, ok: false, reason: ord?.msg || 'CLOSE_ORDER_FAILED' };
}

function selectConvictionLeverage(score, atr15mPct, structuralDistPct = 0, volRatio15m = 1.15, whaleAligned = true) {
  const atr = Number(atr15mPct || 1.2);
  const vol = Number(volRatio15m ?? 1.15);
  const reqSlPct = Math.max(0.92, Number(structuralDistPct || 0), atr * 0.72);
  // Engine #42 + #74A + #77C + #86B + #96A (GPT-6-Luna Volume & Whale-Alignment Gate for 3.5x/4x/5x Leverage):
  // Require minimum 15m ATR velocity (>= 0.82% for 4x/5x, >= 0.72% for 3.5x), real volume participation, and whale alignment so negative-whale setups (like CTUSDT -1.0% whale spread) never get >=3.5x leverage!
  if (score >= 94 && atr >= 0.82 && atr <= 1.35 && reqSlPct <= 0.96 && vol >= 1.15 && whaleAligned) return 5;
  if (score >= 90 && atr >= 0.82 && atr <= 1.85 && reqSlPct <= 1.12 && vol >= 1.05 && whaleAligned) return 4;
  if (score >= 85 && atr >= 0.72 && atr <= 2.40 && reqSlPct <= 1.40 && vol >= 0.85 && whaleAligned) return 3.5;
  return 3;
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

      const isProfitLockScratch = String(t.exitReason || '').includes('KÂR KİLİDİ');
      const isStaleRecoveryScratch = String(t.exitReason || '').includes('BAYAT İVME') && Math.abs(pnl) <= 1.50;
      if (isProfitLockScratch || isStaleRecoveryScratch) {
        feeScratchLossTry = Number((feeScratchLossTry + Math.abs(pnl)).toFixed(2));
      }

      if (isStaleRecoveryScratch) {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Yapısal Destek ($0.08341) Tutup Fiyat Giriş Üstüne ($0.08450) Toparlanırken 24. Dakikada Erken Bayat-İvme Tahliyesi',
          fixApplied: 'Motor #75A & #75B: Giriş Üstü/Başabaş Toparlanan İşlemde Erken Scratch Yasağı + <3.50 TL Scratch İşlemlerde 10s Karantina Muafiyeti',
        });
      } else if (t.symbol === 'ETHFI' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '14.dk Olgunlaşmış (%94) 15dk b0 Mumunda $0.6335 Zirveden -$0.6290 Üst İğne Dönüşü (CLV:0.43, UpperWick:%58 -> 52sn Sonra Shooting Star CLV:0.29) İle Sahte TTM Patlaması Girişi (-9.8 TL Stop Yerine Motor #104C İle -3.12 TL Erken Kurtarış)',
          fixApplied: 'Motor #107A & #107B: Olgunlaşmış (>=%60) Mumda Yeşil Olsa Bile CLV<=0.46 & Üst İğne>=%42 LONG Vetosu + Olgun Mumda CLV<0.52 İken Sahte TTM Patlaması Puanı Yasağı',
        });
      } else if (t.symbol === 'POLYX' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '11.dk Olgunlaşmış Kırmızı 15dk b0 Mumunda ($0.03547 Zirveden -%0.68 Ret -> $0.03523, Erken Dip İğnesi Yüzünden CLV:0.52) Satış Hacminden +8p Velocity + 24s Düşüş (-%3.53) & Negatif Balinada (-%1.6) Fonlama/Basis Çifte Puanlaması (+22p) İle Giriş',
          fixApplied: 'Motor #106A–#106C: Olgunlaşmış (>=%60) Kırmızı b0 Zirve Reddi (>=-%0.45) LONG Vetosu + Satış Mumunda Velocity Puanı Sıfırlama & 24s Düşüş/Negatif Balinada Fonlama+Basis Tavanı + 7-Mumluk 1dk Zirve Reddi Kalkanı',
        });
      } else if (t.symbol === 'ENA' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Q1 Long Girişi Sonrası Balina Makasının Negatife (-%0.7) ve Yapının Q3 (Fiyat↓ OI↑ Ayı Yutan) Yıkımına Dönmesi (-10.30 TL Stop Yerine -4.08 TL Erken Tahliye)',
          fixApplied: 'Motor #98D, #99 & #100: 22dk Derin MAE Watchlist Erken Tahliyesi (-4.08 TL Kurtarış) + [%1.02–%1.25] TP1 Ölü Bölge Sıfırlama & Pullback TP1 Hasadı + Anlık LiveCand Senkronu',
        });
      } else if (t.symbol === 'ARIA' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '🔴 GCR Vadeli Köpüğü (+%0.3071 Basis & +%0.0254 Fonlama) + Zayıf Bağıl Güç (RS_BTC: +0.44 ATR) + Yay Sıkışması & Maksimum Stop (-%2.20) İle 79p Sınır Giriş',
          fixApplied: 'Motor #98A–#98D: GCR Vadeli Köpüğü (>=+%0.18) & Düşük RS (<0.55 ATR) LONG Vetosu + Stop Sonrası 12dk Balina/RS Zorunluluğu + 6dk Q3/Ayı Yutan Yıkım Tahliyesi',
        });
      } else if (t.symbol === 'GRASS' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '1dk +%1.09 Blow-Off Zirve ($0.7145) Sonrası Tam Kırmızı 1dk Döküm Mumunda ($0.7134->$0.7102, CLV:0) Baby-Bar Körlüğü (CLV:1) İle Stop Sonrası YATAY MTF + NÖTR OI Giriş',
          fixApplied: 'Motor #103A–#103D: 3dk Zirve Reddi & Kırmızı 1dk Döküm Mum Vetosu + Baby-Bar Üst İğne Körlüğü Sıfırlama + Stop Sonrası YATAY/NÖTR OI Giriş Yasağı + Karantina Radar/Slot Temizliği',
        });
      } else if (t.symbol === 'CT' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '4s Tepe Direnci Altında Negatif Balina Makası (-%1.0) + Zayıf 1s İvme (+%0.28, RS_BTC: +0.29 ATR) + Sıkışmasız/Formasyonsuz (Alt İğne Tepkisi) Perakende Q1 FOMO Girişi',
          fixApplied: 'Motor #96A–#96D: Sıkışmasız Longlarda 1s >= +%0.55 & RS_BTC >= +0.55 ATR + Pozitif Balina/Boğa Formasyonu Zorunluluğu + Negatif Balina 3x Kaldıraç Tavanı + 3.5dk DOA Erken Tahliye',
        });
      } else if (t.symbol === 'T' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Aşırı Negatif Basis (-%3.40 MM Hedging) + Yay Sıkışması & YATAY MTF İçinde +%0.94 (+%2.83 ROE) Kârdan mfeR>=0.45 Kör Noktası Nedeniyle Geri Dönüş',
          fixApplied: 'Motor #94A–#94D: +%0.82 MFE Başabaş+ Kâr Kilidi + Genişletilmiş [%0.36, %0.52] Pullback Penceresi + Basis<=-%1.20 Sıkışma Vetosu + Başarısız Kırılım (Round-Trip) Tahliyesi',
        });
      } else if (t.symbol === 'QNT' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Yay Sıkışması (TTM Coil — Kırılımsız) + Düşük Bağıl Güç (RS_BTC: +0.49 ATR < 0.58) & Pozitif Basis (+%0.0025) İle 78p Sınır Giriş + +%0.75 Sıçrama Sonrası Düşen Tepe Tepkisinin ($191.06) Kilitlenmemesi',
          fixApplied: 'Motor #101A & #101B: Kırılımsız (TTM Coil/Normal) Longlarda RS_BTC >= +0.58 ATR & 1s >= +%0.65 Zorunluluğu + +%0.52 Sıçrama Sonrası Giriş Altı İnip Tekrar +%0.28 Tepki Veren İşlemde Anlık Başabaş+ Kâr Kilidi',
        });
      } else if (t.symbol === 'ZRO' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'NÖTR OI (+%0.04) İçinde 1 Saatte +%4.30 (+3.59 ATR) Şişmiş Tepeye (Formasyonsuz Alt İğne Tepkisi) Geç Giriş',
          fixApplied: 'Motor #92A & #92B: Q1 OI Olmayan Coinde 1s >= +%3.20 / RS_BTC >= +2.85 ATR Tepe Kovalaması LONG Vetosu + -%0.60 Kör Nokta Kaldırma',
        });
      } else if (t.symbol === 'PONS' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'NÖTR OI + Pozitif Basis (+%0.0075) + Sıkışmasız/Formasyonsuz (Alt İğne Tepkisi) 80p Sınır Skor İle Direnç Altı Giriş',
          fixApplied: 'Motor #91B: NÖTR OI & Sıkışmasız Longlarda Boğa Mum Formasyonu, Negatif Basis/Fonlama veya >=86p Skor Zorunluluğu (-14 TL Stop Yerine -3.74 TL Erken Tahliye)',
        });
      } else if (t.symbol === 'NEAR' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s +%0.089 Yatay Coinde Q2 (Düşen OI) + YATAY MTF + Zayıf Mum Kapanışı (CLV:0.55) İle 3.5x Sıkışma Girişi',
          fixApplied: 'Motor #90A: Q2 (Düşen OI) & Yatay MTF Long İçin 24s >= +%2.80 İvme veya Q1 + MTF Yükseliş Zorunluluğu (-14 TL Stop Yerine -6.75 TL Erken Tahliye)',
        });
      } else if (t.symbol === 'MTL' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '24s +%2.78 Düşük Trendli Coinde 1s +%1.87 Sıçramanın Sahte Short-Squeeze Sayılarak -%11.7 Balina Makası (45.4L/57.1L) ve RSI 75.46 BSL Sweep Tepesinden LONG Açılması',
          fixApplied: 'Motor #88A & #88B: Sıkı 24s >= +%6.5 Squeeze/Hype Zorunluluğu (Balina -%6.5 Veto Korundu) + 8dk BSL Sweep & Balina Dağıtım Erken Tahliyesi (-15 TL Stop Yerine -7.35 TL Kurtarıldı)',
        });
      } else if (t.symbol === 'XMR' && t.side === 'SHORT') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'MTF YÜKSELİŞ (EMA20>50) + NÖTR OI (+%0.04) + Pozitif 1s İvme (+%0.02) + Düşük ATR (%0.52) İçinde Erken GCR Short Girişi',
          fixApplied: 'Motor #77B & #77C: GCR Short İçin 1s<=-%0.15 & Q3/Q2 OI & MTF Ayı Zorunluluğu + Minimum 15dk ATR >= %0.72 Hız Tabanı',
        });
      } else if (t.symbol === 'DASH' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '4s İkili Tepe ($52.92) Direnci Altında (posIn16Bar: 0.88) Düşük Hacimli 3 Yeşil Mum + 24s +%3.98 Coinin Sahte Hype-Squeeze Sayılarak 4x LONG Açılması',
          fixApplied: 'Motor #77A–#77D: Gerçek Hype-Squeeze Barajı (24s>=+%6.5 veya 1s>=+%1.65) + 4s Tepe Direnci (posIn16>=0.84 & 3 Yeşil Mum) LONG Vetosu + 5dk Erken Fishing Tahliyesi',
        });
      } else if (t.symbol === 'DOS' && t.side === 'SHORT') {
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
      } else if (t.symbol === 'BR' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: 'Kırmızı b1 Mum ($0.4869, CLV:0.40) ve 2s Çoklu Üst İğne Direnci ($0.4925–$0.4948) Altında 5.dk Kapanmamış Baby-Bar Sıçramasının ($0.4938) Sahte TTM Patlaması Sayılarak NÖTR OI + YATAY MTF + Formasyonsuz Girişi (-10.3 TL Stop Yerine Motor #104C İle -5.83 TL Erken Kurtarış)',
          fixApplied: 'Motor #105A–#105C: Kırmızı b1 Sonrası 2s Yerel Zirve ($H_8$) Kırılmadan Baby-Bar TTM Patlaması Yasağı + 2-Saatlik (8-Bar) Çoklu İğne Tavanı Vetosu + Stop Sonrası/NÖTR OI YATAY MTF Formasyonsuz Giriş Kilidi',
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
      } else if (t.symbol === 'NIL' && t.side === 'LONG') {
        diagnosedMistakes.push({
          trade: `${t.symbol}USDT (${t.leverage}x ${t.side} | ${pnl} TL)`,
          rootCause: '4s Zirvesinde ($0.09492) 2-Mumluk İkili Tepe Satış Duvarı (b2 Yeşil Zirve -> b1 -%1.28 Kırmızı Döküm CLV:0.27) İçine Düşük Hacimli Retest ($0.09482) + Sahte Likidasyon Mıknatısı (+5p) & Geniş Stop (-%1.87) İle Giriş',
          fixApplied: 'Motor #104A–#104C: 2-Bar İkili Tepe/Dip Arz-Talep Tavanı ($0.09492 Kırılmadan) LONG Vetosu + Kırmızı b1 Mumda Sıkışmasız Likidasyon Mıknatısı & Tepe Retest Yasağı + 8dk Mum-Vetosu/Taker-Çöküşü Erken Tahliyesi',
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

  // Engine #46 + #73A (GPT-6-Luna Toxic-Symbol Quarantine Without Eternal Reset Bug):
  // Anchor quarantine expiry to the actual trade close timestamp (t.closedAtMs / t.closedAt), NEVER nowMs + 6h on every audit!
  const parseClosedAtMs = str => {
    const m = String(str || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (!m) return 0;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  };
  if (!state.symbolCooldowns) state.symbolCooldowns = {};
  if (!state.symbolConsecStops) state.symbolConsecStops = {};
  const seenSymbols = new Set();
  for (const t of closed) {
    if (!t.symbol || seenSymbols.has(t.symbol)) continue;
    seenSymbols.add(t.symbol);
    let consec = 0;
    for (const row of closed) {
      if (row.symbol !== t.symbol) continue;
      const rowPnl = Number(row.netPnlTry || 0);
      if (rowPnl >= 0) break;
      const isMaterialStop = rowPnl <= -3.50 || String(row.exitReason || '').includes('İZOLE STOP KALKANI');
      if (isMaterialStop) consec += 1;
    }
    state.symbolConsecStops[t.symbol] = consec;
    const lastLossMs = Number(t.closedAtMs || parseClosedAtMs(t.closedAt) || 0);
    if (consec >= 2 && lastLossMs > 0) {
      const targetQuarantineUntil = lastLossMs + 10 * 60 * 60 * 1000;
      const maxQuarantineUntil = lastLossMs + 12 * 60 * 60 * 1000;
      if ((state.symbolCooldowns[t.symbol] || 0) > maxQuarantineUntil) {
        // Repair cooldowns that were artificially pushed forward by the old nowMs + 6h reset bug
        state.symbolCooldowns[t.symbol] = targetQuarantineUntil;
      } else if (nowMs < targetQuarantineUntil && (state.symbolCooldowns[t.symbol] || 0) < targetQuarantineUntil) {
        state.symbolCooldowns[t.symbol] = targetQuarantineUntil;
      }
    } else if (consec < 2 && lastLossMs > 0 && (state.symbolCooldowns[t.symbol] || 0) > nowMs + 180 * 60 * 1000) {
      // Engine #75B: Repair false 10-hour quarantines caused by < 3.50 TL tactical scratches
      const isLastRowScratch = Number(t.netPnlTry || 0) > -3.50 && !String(t.exitReason || '').includes('İZOLE STOP KALKANI');
      state.symbolCooldowns[t.symbol] = lastLossMs + (isLastRowScratch ? 20 : 180) * 60 * 1000;
    } else if (
      consec === 0 &&
      lastLossMs > 0 &&
      Number(t.netPnlTry || 0) >= 0 &&
      (String(t.exitReason || '').includes('KÂR KİLİDİ') || String(t.exitReason || '').includes('KÂR HASADI'))
    ) {
      // Engine #80A + #83 + #84A (GPT-6-Luna Post-TP1 Cooldown Integrity & Repeat Micro-Win Churn Guard):
      // Only shorten a win cooldown to 8 minutes if it is a single pre-TP1 micro-profit lock (< 1.25 TL, !t.tp1Done).
      // Any trade with tp1Done === true, netPnlTry >= 1.25 TL (like LUMIAUSDT +3.02 TL), or >= 2 wins on the same symbol within 60m gets the full 45m cooldown!
      const sameSymRecentWins = closed.filter(
        r =>
          r.symbol === t.symbol &&
          Number(r.netPnlTry || 0) >= 0 &&
          Math.abs(lastLossMs - Number(r.closedAtMs || parseClosedAtMs(r.closedAt) || 0)) <= 60 * 60 * 1000
      ).length;
      const isTrueSingleMicroWin = !t.tp1Done && Number(t.netPnlTry || 0) < 1.25 && sameSymRecentWins <= 1;
      if (isTrueSingleMicroWin) {
        const microWinCapMs = lastLossMs + 15 * 60 * 1000;
        if ((state.symbolCooldowns[t.symbol] || 0) > microWinCapMs) {
          state.symbolCooldowns[t.symbol] = microWinCapMs;
        }
      } else {
        const fullWinCooldownMs = lastLossMs + 45 * 60 * 1000;
        if (nowMs < fullWinCooldownMs && (state.symbolCooldowns[t.symbol] || 0) < fullWinCooldownMs) {
          state.symbolCooldowns[t.symbol] = fullWinCooldownMs;
        }
      }
    }
  }

  // GPT-6-Luna Objective Score: J = NetPnL - 0.35 * MaxDD - 0.50 * FeeScratchLoss
  const objectiveJ = Number((recentNetPnlTry - 0.35 * maxDrawdownTry - 0.50 * feeScratchLossTry).toFixed(2));

  // Bounded parameter update: clip(theta, theta_min, theta_max) — Engine #54B + #61C + #63D + #95 (True J-Score Adaptive Tuning without Winning-Trade Sliding-Window Penalty)
  const hasActiveLossStreak = Number(closed[0]?.netPnlTry || 0) < 0 && Number(closed[1]?.netPnlTry || 0) < 0;
  const isLongColdStreak = hasActiveLossStreak && longLosses >= longWins + 2 && objectiveJ < -25;
  // Engine #106A (Loss-Stopper Sniper Floor): Raise LONG floor from 78 -> 84 (86 on cold streak) and 5m Taker from 1.12x -> 1.18x to eliminate mediocre 30m overtrading!
  const minLongScore = isLongColdStreak ? 86 : 84;
  const minShortScore = 86;
  const minLongTaker5m = isLongColdStreak ? 1.22 : 1.18;
  const maxShortTaker5m = 0.84;

  state.adaptiveTuning = {
    minLongScore,
    minShortScore,
    minLongTaker5m,
    maxShortTaker5m,
    objectiveJ,
    updatedAt: new Date().toLocaleString('tr-TR'),
  };

  const dualAiCouncil = buildDualAiPartnerConsensus(state, closed, {
    minLongScore,
    minShortScore,
    objectiveJ,
  });
  if (state.lastSelfAudit?.dualAiCouncil?.liveFreebuffNote) {
    dualAiCouncil.liveFreebuffNote = state.lastSelfAudit.dualAiCouncil.liveFreebuffNote;
  }

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
    dualAiCouncil,
    diagnosedMistakes: diagnosedMistakes.slice(0, 4),
  };

  if (forceLog) {
    logEvent(
      state,
      `🧠 [2-SAATLİK İKİLİ YAPAY ZEKA KONSEYİ (Luna + Freebuff Motor #85)] Son ${recentWindow.length} İşlem: ${recentWins}W/${recentLosses}L (Net: ${recentNetPnlTry >= 0 ? '+' : ''}${recentNetPnlTry} TL | Luna J-Skoru: ${objectiveJ}) | ${dualAiCouncil.consensusAction}`
    );
    // Asynchronous non-blocking Freebuff Partner query on 2-hour audit cycle
    queryFreebuffCouncil(
      `Son ${recentWindow.length} vadeli işlem: ${recentWins}W/${recentLosses}L, Net: ${recentNetPnlTry} TL, Galibiyet Serisi: ${dualAiCouncil.streakWins}, Engellenen Spoof Duvarı: ${dualAiCouncil.spoofVetoCount}. GPT-6-Luna ile ortak çalışan 2. Yapay Zeka (Freebuff) olarak 1 cümlelik Türkçe risk notu ver.`
    )
      .then(fbRes => {
        if (fbRes && fbRes.ok && fbRes.response && state.lastSelfAudit?.dualAiCouncil) {
          state.lastSelfAudit.dualAiCouncil.liveFreebuffNote = `[${fbRes.modelName}] ${fbRes.response.slice(0, 240)}`;
          saveState(state);
        }
      })
      .catch(() => {});
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

  if (state.mode === 'LIVE_BINANCE_FAPI') {
    // Engine #72D (GPT-6-Luna Live Futures-to-Spot Vault Isolation):
    // Reserve sweptUsdt immediately so syncLiveFapiAccount never overwrites swept profit back into active margin risk;
    // if physical UMFUTURE_MAIN Universal Transfer succeeds, release the virtual reservation because exchange availUsdt physically dropped!
    state.liveReservedVaultUsdt = Number(((state.liveReservedVaultUsdt || 0) + sweepUsdt).toFixed(4));
    executeFapiToSpotTransfer(sweepUsdt)
      .then(tr => {
        if (tr && tr.ok) {
          state.liveReservedVaultUsdt = Math.max(0, Number(((state.liveReservedVaultUsdt || 0) - sweepUsdt).toFixed(4)));
        }
      })
      .catch(() => {});
  }

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
    const rawText = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const m = line.replace(/^\uFEFF/, '').match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
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
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : lastClose;

  // Engine #79C (GPT-6-Luna MTF EMA20 Slope & Completed-Bar Confirmation):
  // Prevent a momentary intrabar wick (b0) poking into a falling EMA20 after a bearish completed candle (b1 < ema20, like NILUSDT at 05:39)
  // from flickering mtfBullish to true! Require non-negative EMA20 slope over 3 bars and completed-bar proximity.
  const ema20 = computeEma(closes, 20);
  const ema20Prev3 = closes.length >= 23 ? computeEma(closes.slice(0, -3), 20) : ema20;
  const ema50 = computeEma(closes, Math.min(50, closes.length));
  const mtfBullish =
    lastClose > ema20 &&
    prevClose >= ema20 * 0.9985 &&
    ema20 >= ema20Prev3 * 0.9995 &&
    ema20 >= ema50 * 0.999;
  const mtfBearish =
    lastClose < ema20 &&
    prevClose <= ema20 * 1.0015 &&
    ema20 <= ema20Prev3 * 1.0005 &&
    ema20 <= ema50 * 1.001;

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

  // Motor #105A (GPT-6-Luna Confirmed TTM Squeeze Expansion vs. Unclosed Intrabar Spike After Red b1):
  // An unclosed baby/mid bar b0 spiking into local resistance after a red completed bar b1 (like BRUSDT at 10:05:32: b1 $0.4890->$0.4869 red CLV:0.40, b0 5m spike to $0.4938 below 2h high H8=$0.4948)
  // must NEVER manufacture a fake +6p TTM Squeeze Breakout! Require either completed-bar alignment (b1IsGreen) or an actual breakout above the 8-bar completed high H8 (or below L8 for short).
  const b0Raw = klines[klines.length - 1] || [];
  const b1Raw = klines[klines.length - 2] || [];
  const b0OpenTime = Number(b0Raw[0] || 0);
  const b0ElapsedFrac = b0OpenTime > 0 ? Math.max(0.05, Math.min(1.0, (Date.now() - b0OpenTime) / (15 * 60 * 1000))) : 0.5;
  const b1IsGreen = Number(b1Raw[4] || 0) >= Number(b1Raw[1] || 0);
  const prior8Completed = klines.slice(Math.max(0, klines.length - 9), klines.length - 1);
  const high8Completed = prior8Completed.length ? Math.max(...prior8Completed.map(k => Number(k[2]))) : lastClose;
  const low8Completed = prior8Completed.length ? Math.min(...prior8Completed.map(k => Number(k[3]))) : lastClose;
  const confirmedBreakAboveH8 = lastClose >= high8Completed * 1.0005 || prevClose > prevStats.mean + 1.05 * prevStats.std;
  const confirmedBreakBelowL8 = lastClose <= low8Completed * 0.9995 || prevClose < prevStats.mean - 1.05 * prevStats.std;

  const wasRecentlyCoiled = prevStats.isCoiled || prev2Stats.isCoiled || prevStats.bbWidthPct <= 1.85;
  const rawExpandingUp = wasRecentlyCoiled && lastClose > curStats.mean + 1.15 * curStats.std;
  const rawExpandingDown = wasRecentlyCoiled && lastClose < curStats.mean - 1.15 * curStats.std;
  // Motor #107B (GPT-6-Luna Healthy TTM Squeeze Expansion CLV Gate):
  // A mature 15m candle (b0ElapsedFrac >= 0.50) rolling over into its lower half (b0Clv < 0.52, like ETHFIUSDT at minute 14 with CLV:0.43 before closing as a Shooting Star CLV:0.29)
  // is a failed expansion / upper-wick rejection, NEVER a valid upward TTM breakout!
  const b0High = Number(b0Raw[2] || lastClose);
  const b0Low = Number(b0Raw[3] || lastClose);
  const b0Range = Math.max(1e-9, b0High - b0Low);
  const b0Clv = (lastClose - b0Low) / b0Range;
  const b0HealthyLongExpand = b0ElapsedFrac < 0.50 || b0Clv >= 0.52;
  const b0HealthyShortExpand = b0ElapsedFrac < 0.50 || b0Clv <= 0.48;
  const isExpandingUp = rawExpandingUp && b0HealthyLongExpand && (confirmedBreakAboveH8 || (b1IsGreen && b0ElapsedFrac >= 0.60));
  const isExpandingDown = rawExpandingDown && b0HealthyShortExpand && (confirmedBreakBelowL8 || (!b1IsGreen && b0ElapsedFrac >= 0.60));

  let squeezeLabel = curStats.isCoiled || (wasRecentlyCoiled && (rawExpandingUp || rawExpandingDown) && !isExpandingUp && !isExpandingDown)
    ? 'Yay Sıkışması (TTM Coil)'
    : 'Normal';
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

function analyzeCandleSmcAndCvd15m(klines, atr15mPct = 1.5, change24hPct = 0, isMtfBullish = false) {
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
      isFishingTrapLong: false,
      isVolTakerDecayLong: false,
      isDeadCatBounceIntoSupply: false,
      clv: 0.5,
      b0ElapsedFrac: 0.5,
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

  // Wall #1 + Engine #55A + #82A (GPT-6-Luna Unclosed-Bar Contamination & Active Baby-Bar Reversal Unblinding):
  // High-volume hype coins hit 25% of 3-bar volume in 90 seconds, so small wiggles use b1.clv during b0ElapsedFrac < 0.55.
  // However, if b0 already has a material adverse body (>= max(0.32%, 0.28 * ATR%)) against the trade (like AVAUSDT dropping $0.4433->$0.4415->$0.4367 at 07:04),
  // unblind effectiveClv to b0.clv immediately so a falling red b0 candle is never masked by b1.clv = 0.88!
  const avgCompletedVol = (b1.vol + b2.vol + b3.vol) / 3 || 1;
  const b0ElapsedFrac = b0.openTime > 0 ? Math.max(0.05, Math.min(1.0, (Date.now() - b0.openTime) / (15 * 60 * 1000))) : 0.5;
  const isBabyB0 = b0.vol < avgCompletedVol * 0.35 || b0ElapsedFrac < 0.55;
  const isMatureB0 = !isBabyB0 && b0ElapsedFrac >= 0.70;
  const atrFracForBar = (Number(atr15mPct) || 1.2) / 100;
  const b0BodyFrac = b0.open > 0 ? Math.abs(b0.close - b0.open) / b0.open : 0;
  const b0SpikeUpFrac = b0.open > 0 ? (b0.high - b0.open) / b0.open : 0;
  const b0RejectFromHighFrac = b0.high > 0 ? (b0.high - b0.close) / b0.high : 0;
  const b0SpikeDownFrac = b0.open > 0 ? (b0.open - b0.low) / b0.open : 0;
  const b0BounceFromLowFrac = b0.low > 0 ? (b0.close - b0.low) / b0.low : 0;
  // Motor #103A (GPT-6-Luna Rejected Baby-Bar Blow-Off Unblinding):
  // If b0 has already spiked >= max(0.85%, 0.65 * ATR%) above b0.open and rejected >= 0.38% from b0.high with upperWickRatio >= 0.30
  // (like GRASSUSDT spiking $0.7059->$0.7145 +1.22% and dumping to $0.7109 -0.50% at minute 3 of b0),
  // NEVER mask b0 with b1.clv = 1.00; unblind effectiveClv = b0.clv and invalidate b1 bullish patterns!
  const rejectedBabyLongB0 =
    isBabyB0 &&
    b0.upperWickRatio >= 0.30 &&
    b0SpikeUpFrac >= Math.max(0.0085, 0.65 * atrFracForBar) &&
    b0RejectFromHighFrac >= 0.0038;
  const rejectedBabyShortB0 =
    isBabyB0 &&
    b0.lowerWickRatio >= 0.30 &&
    b0SpikeDownFrac >= Math.max(0.0085, 0.65 * atrFracForBar) &&
    b0BounceFromLowFrac >= 0.0038;
  const materialAdverseLongB0 =
    b0.close < b0.open &&
    b0BodyFrac >= Math.max(0.0032, 0.28 * atrFracForBar) &&
    b0.clv <= 0.38;
  const materialAdverseShortB0 =
    b0.close > b0.open &&
    b0BodyFrac >= Math.max(0.0032, 0.28 * atrFracForBar) &&
    b0.clv >= 0.62;
  // Motor #106A + #107A (GPT-6-Luna Mature Red/Green Bar Peak-Rejection & Upper-Wick Rollover Veto):
  // 1. When b0ElapsedFrac >= 0.60, an early lower wick (like POLYXUSDT dipping to $0.03501 at minute 1, peaking at $0.03547 at minute 9, and dumping -0.68% to $0.03523 below b0.open $0.03535)
  //    artificially inflates b0.clv = 0.52 while the mature 15m candle is RED and actively dumping from its peak!
  // 2. Even if b0 is still slightly green (like ETHFIUSDT at 11:59:08, b0ElapsedFrac = 0.94, CLV: 0.43, upperWickRatio: 0.58, 52s before closing as a Shooting Star CLV:0.29),
  //    any mature candle with b0.clv <= 0.46 and heavy upper wick (upperWickRatio >= 0.42 or b0RejectFromHighFrac >= 0.0045) is actively rolling over and must be vetoed for LONG!
  const isMatureRedPeakRejectionLongB0 =
    b0ElapsedFrac >= 0.60 &&
    ((!b0.isGreen && (b0RejectFromHighFrac >= 0.0045 || b0.clv <= 0.48)) ||
      (b0.clv <= 0.46 && (b0.upperWickRatio >= 0.42 || b0RejectFromHighFrac >= 0.0045)));
  const isMatureGreenTroughBounceShortB0 =
    b0ElapsedFrac >= 0.60 &&
    ((b0.isGreen && (b0BounceFromLowFrac >= 0.0045 || b0.clv >= 0.52)) ||
      (b0.clv >= 0.54 && (b0.lowerWickRatio >= 0.42 || b0BounceFromLowFrac >= 0.0045)));
  const effectiveClv =
    isBabyB0 && !materialAdverseLongB0 && !materialAdverseShortB0 && !rejectedBabyLongB0 && !rejectedBabyShortB0
      ? b1.clv
      : b0.clv;

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

  // Engine #80B + #103A (GPT-6-Luna Completed-Bar Pattern vs. Live-Bar CLV Coherence & Baby-Bar Blow-Off Rejection):
  // Never allow a b1 Bullish Marubozu / 3 Higher Lows to remain active when b0 has collapsed (effectiveClv < 0.56, like USELESSUSDT CLV:0.12)
  // or suffered a baby-bar blow-off upper-wick rejection (rejectedBabyLongB0, like GRASSUSDT $0.7059->$0.7145->$0.7109 at minute 3),
  // and never allow a b1 Bearish Marubozu / 3 Lower Highs to remain active when b0 has bounced (effectiveClv > 0.44, like NEARUSDT CLV:0.58)!
  const liveBarCollapsedBearish = (isMatureB0 && !b0.isGreen && b0.clv <= 0.42) || rejectedBabyLongB0;
  const liveBarReclaimedBullish = (isMatureB0 && b0.isGreen && b0.clv >= 0.58) || rejectedBabyShortB0;

  let bullishPattern = null;
  let bullishCandlePts = 0;
  if (isBullishEngulfing && effectiveClv >= 0.50 && !liveBarCollapsedBearish) {
    bullishPattern = 'Boğa Yutan (Engulfing)';
    bullishCandlePts = 10;
  } else if (((isHammerB1 && effectiveClv >= 0.50) || isHammerB0) && !liveBarCollapsedBearish) {
    bullishPattern = 'Likidite Çekici (Hammer)';
    bullishCandlePts = 10;
  } else if (isMorningStar && effectiveClv >= 0.50 && !liveBarCollapsedBearish) {
    bullishPattern = 'Sabah Yıldızı (Morning Star)';
    bullishCandlePts = 9;
  } else if (isBullishMarubozu && effectiveClv >= 0.56 && !liveBarCollapsedBearish) {
    bullishPattern = 'Boğa Marubozu';
    bullishCandlePts = 8;
  } else if (isThreeHigherLows && effectiveClv >= 0.56 && !liveBarCollapsedBearish) {
    bullishPattern = '3 Yükselen Dip';
    bullishCandlePts = 6;
  } else if (!isBabyB0 && b0.isGreen && b0.clv >= 0.68) {
    bullishCandlePts = 4;
  }

  let bearishPattern = null;
  let bearishCandlePts = 0;
  if (isBearishEngulfing && effectiveClv <= 0.50 && !liveBarReclaimedBullish) {
    bearishPattern = 'Ayı Yutan (Bearish Engulfing)';
    bearishCandlePts = 10;
  } else if (((isShootingStarB1 && effectiveClv <= 0.50) || isShootingStarB0) && !liveBarReclaimedBullish) {
    bearishPattern = 'Kayan Yıldız (Shooting Star)';
    bearishCandlePts = 10;
  } else if (isEveningStar && effectiveClv <= 0.50 && !liveBarReclaimedBullish) {
    bearishPattern = 'Akşam Yıldızı (Evening Star)';
    bearishCandlePts = 9;
  } else if (isBearishMarubozu && effectiveClv <= 0.44 && !liveBarReclaimedBullish) {
    bearishPattern = 'Ayı Marubozu';
    bearishCandlePts = 8;
  } else if (isThreeLowerHighs && effectiveClv <= 0.44 && !liveBarReclaimedBullish) {
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

  // B) Dead-Cat Bounce into Heavy 4h Dump Supply Zone (ATOM 16:00 UTC dump pattern — Engine #63B ATR-scaled & MTF Bullish Uptrend Exempt)
  let maxBearDumpVol = 0;
  let bearDumpOriginHigh = 0;
  const minDumpBodyFrac = Math.max(0.0065, ((Number(atr15mPct) || 1.5) / 100) * 0.80);
  for (let i = Math.max(0, n - 12); i < n - 2; i++) {
    const dBar = bars[i];
    if (!dBar.isGreen && dBar.vol >= avgCompletedVol * 1.15 && (dBar.open - dBar.close) / dBar.open >= minDumpBodyFrac) {
      if (dBar.vol > maxBearDumpVol) {
        maxBearDumpVol = dBar.vol;
        bearDumpOriginHigh = dBar.high;
      }
    }
  }
  const isStrongMtfUptrend = Boolean(isMtfBullish && Number(change24hPct) >= 5.0);
  const isDeadCatBounceIntoSupply =
    !isStrongMtfUptrend &&
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

  // Engine #79B + #81B + #104A (GPT-6-Luna Prior-Bar Supply/Demand Rejection Guard & 2-Bar Twin-Candle Ceiling Veto):
  // 1. When completed 15m candle b1 is a red upper-wick/low-CLV rejection bar (!b1.isGreen && (b1.clv <= 0.34 || b1.upperWickRatio >= 0.44)),
  //    or forms a 2-bar twin-candle supply rejection ceiling at the 4h high (b2.isGreen && !b1.isGreen && b1.clv <= 0.36 && b1.body >= b2.body * 0.72 && max(b1.high, b2.high) >= fullHigh16 * 0.998, like NILUSDT b2 $0.09492 -> b1 $0.09359),
  //    do NOT lift vetoLong on a lower-volume retest just because b0.close ($0.09482) ticked 0.02% above b1.open ($0.09480) without clearing the twin-bar supply high ($0.09492)!
  const isTwinBarBearishSupplyCeiling =
    b2.isGreen &&
    !b1.isGreen &&
    b1.clv <= 0.36 &&
    b1.body >= b2.body * 0.72 &&
    Math.max(b1.high, b2.high) >= fullHigh16 * 0.998;
  const isTwinBarBullishDemandFloor =
    !b2.isGreen &&
    b1.isGreen &&
    b1.clv >= 0.64 &&
    b1.body >= b2.body * 0.72 &&
    Math.min(b1.low, b2.low) <= fullLow16 * 1.002;

  const b0MatureBodyReclaimedB1 =
    isMatureB0 &&
    b0.isGreen &&
    b0.clv >= 0.78 &&
    b0.bodyRatio >= 0.55 &&
    b0.upperWickRatio <= 0.18 &&
    b1.upperWickRatio < 0.40 &&
    !isTwinBarBearishSupplyCeiling &&
    b0.close >= b1.close + (b1.open - b1.close) * 0.65;
  const b0MatureBodyBrokeB1 =
    isMatureB0 &&
    !b0.isGreen &&
    b0.clv <= 0.22 &&
    b0.bodyRatio >= 0.55 &&
    b0.lowerWickRatio <= 0.18 &&
    b1.lowerWickRatio < 0.40 &&
    !isTwinBarBullishDemandFloor &&
    b0.close <= b1.close - (b1.close - b1.open) * 0.65;

  const requiredPriorBearishReclaimLevel = isTwinBarBearishSupplyCeiling
    ? Math.max(b1.high, b2.high) * 0.9995
    : b1.open * 1.001;
  const requiredPriorBullishBreakLevel = isTwinBarBullishDemandFloor
    ? Math.min(b1.low, b2.low) * 1.0005
    : b1.open * 0.999;

  const isPriorBarBearishRejectionUnreclaimed =
    !b1.isGreen &&
    (b1.clv <= 0.34 || b1.upperWickRatio >= 0.44 || isTwinBarBearishSupplyCeiling) &&
    b0.close < requiredPriorBearishReclaimLevel &&
    !b0MatureBodyReclaimedB1;
  const isPriorBarBullishRejectionUnbroken =
    b1.isGreen &&
    (b1.clv >= 0.66 || b1.lowerWickRatio >= 0.44 || isTwinBarBullishDemandFloor) &&
    b0.close > requiredPriorBullishBreakLevel &&
    !b0MatureBodyBrokeB1;

  // Engine #84B + #87C + #104A + #105B (GPT-6-Luna Overhead 4h & 2h Local Multi-Wick / Twin-Bar Supply Room-to-TP1 Gate):
  // 1. Check both the 4h (16-bar) ceiling (fullHigh16) AND the 2h (8-bar) local ceiling (fullHigh8) so an old 3.5h spike (like BRUSDT 04:30 $0.5070)
  //    never blinds the bot to a 2-hour local multi-wick supply ceiling (BRUSDT 05:00..06:45 $0.4925–$0.4948 with 83% and 48% upper wicks on b3/b2)!
  const window8 = bars.slice(-8);
  const fullLow8 = Math.min(...window8.map(b => b.low));
  const fullHigh8 = Math.max(...window8.map(b => b.high));
  const posIn8BarRange = fullHigh8 > fullLow8 ? Number(((b0.close - fullLow8) / (fullHigh8 - fullLow8)).toFixed(2)) : 0.5;
  const prior3UpperRejectCnt = [b1, b2, b3].filter(
    b => b.upperWickRatio >= 0.40 || (!b.isGreen && b.clv <= 0.42 && b.upperWickRatio >= 0.25)
  ).length;
  const prior3LowerRejectCnt = [b1, b2, b3].filter(
    b => b.lowerWickRatio >= 0.40 || (b.isGreen && b.clv >= 0.58 && b.lowerWickRatio >= 0.25)
  ).length;
  const local8BarWickCeilingHigh = Math.max(
    b1.upperWickRatio >= 0.42 ? b1.high : 0,
    b2.upperWickRatio >= 0.42 ? b2.high : 0,
    b3.upperWickRatio >= 0.42 ? b3.high : 0,
    prior3UpperRejectCnt >= 2 ? fullHigh8 : 0
  );
  const local8BarWickFloorLow = Math.min(
    b1.lowerWickRatio >= 0.42 ? b1.low : Infinity,
    b2.lowerWickRatio >= 0.42 ? b2.low : Infinity,
    b3.lowerWickRatio >= 0.42 ? b3.low : Infinity,
    prior3LowerRejectCnt >= 2 ? fullLow8 : Infinity
  );

  const b1OrB2WickCeilingHigh = Math.max(
    b1.upperWickRatio >= 0.42 ? b1.high : 0,
    b2.upperWickRatio >= 0.42 ? b2.high : 0,
    isTwinBarBearishSupplyCeiling ? Math.max(b1.high, b2.high) : 0
  );
  const activeWickCeilingHigh = Math.max(b1OrB2WickCeilingHigh, local8BarWickCeilingHigh);
  const b0ActivelyAbsorbingCeilingLong =
    b0.isGreen &&
    b0.clv >= 0.85 &&
    b0.close >= activeWickCeilingHigh * 0.9985 &&
    b0.deltaPct >= 10 &&
    b0.vol >= Math.max(b1.vol, b2.vol) * 0.85;
  const is4hWickCeilingBlockingTp1Long =
    b1OrB2WickCeilingHigh >= fullHigh16 * 0.998 &&
    b0.close < b1OrB2WickCeilingHigh &&
    !b0ActivelyAbsorbingCeilingLong &&
    posIn16BarRange >= 0.72 &&
    (b1OrB2WickCeilingHigh - b0.close) / Math.max(1e-9, b0.close) < 0.0115;
  const isLocal8BarWickCeilingBlockingTp1Long =
    local8BarWickCeilingHigh >= fullHigh8 * 0.994 &&
    prior3UpperRejectCnt >= 2 &&
    b0.close < fullHigh8 &&
    !b0ActivelyAbsorbingCeilingLong &&
    posIn8BarRange >= 0.76 &&
    (fullHigh8 - b0.close) / Math.max(1e-9, b0.close) < 0.0115;
  const isOverheadWickCeilingBlockingTp1Long =
    is4hWickCeilingBlockingTp1Long || isLocal8BarWickCeilingBlockingTp1Long;

  const b1OrB2WickFloorLow = Math.min(
    b1.lowerWickRatio >= 0.42 ? b1.low : Infinity,
    b2.lowerWickRatio >= 0.42 ? b2.low : Infinity,
    isTwinBarBullishDemandFloor ? Math.min(b1.low, b2.low) : Infinity
  );
  const activeWickFloorLow = Math.min(b1OrB2WickFloorLow, local8BarWickFloorLow);
  const b0ActivelyAbsorbingFloorShort =
    !b0.isGreen &&
    b0.clv <= 0.15 &&
    b0.close <= activeWickFloorLow * 1.0015 &&
    b0.deltaPct <= -10 &&
    b0.vol >= Math.max(b1.vol, b2.vol) * 0.85;
  const is4hWickFloorBlockingTp1Short =
    Number.isFinite(b1OrB2WickFloorLow) &&
    b1OrB2WickFloorLow <= fullLow16 * 1.002 &&
    b0.close > b1OrB2WickFloorLow &&
    !b0ActivelyAbsorbingFloorShort &&
    posIn16BarRange <= 0.28 &&
    (b0.close - b1OrB2WickFloorLow) / Math.max(1e-9, b0.close) < 0.0115;
  const isLocal8BarWickFloorBlockingTp1Short =
    Number.isFinite(local8BarWickFloorLow) &&
    local8BarWickFloorLow <= fullLow8 * 1.006 &&
    prior3LowerRejectCnt >= 2 &&
    b0.close > fullLow8 &&
    !b0ActivelyAbsorbingFloorShort &&
    posIn8BarRange <= 0.24 &&
    (b0.close - fullLow8) / Math.max(1e-9, b0.close) < 0.0115;
  const isUnderfootWickFloorBlockingTp1Short =
    is4hWickFloorBlockingTp1Short || isLocal8BarWickFloorBlockingTp1Short;

  const vetoLong = Boolean(
    bearishPattern ||
      buySideSweep ||
      isFishingTrapLong ||
      materialAdverseLongB0 ||
      rejectedBabyLongB0 ||
      isMatureRedPeakRejectionLongB0 ||
      isPriorBarBearishRejectionUnreclaimed ||
      isOverheadWickCeilingBlockingTp1Long ||
      (isMatureB0 && b0.upperWickRatio >= 0.50 && b0.clv <= 0.38) ||
      (b1.upperWickRatio >= 0.48 && b1.clv <= 0.42 && effectiveClv < 0.65) ||
      (isMatureB0 && !b0.isGreen && b0.clv <= 0.30) ||
      (isBabyB0 && !b1.isGreen && b1.clv <= 0.32) ||
      effectiveClv <= 0.28
  );

  const vetoShort = Boolean(
    bullishPattern ||
      sellSideSweep ||
      materialAdverseShortB0 ||
      rejectedBabyShortB0 ||
      isMatureGreenTroughBounceShortB0 ||
      isPriorBarBullishRejectionUnbroken ||
      isUnderfootWickFloorBlockingTp1Short ||
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
          ? isOverheadWickCeilingBlockingTp1Long
            ? `⚠️ 4s İğne Tavanı Direnci (CLV:${effectiveClv} — LONG Veto)`
            : isPriorBarBearishRejectionUnreclaimed && effectiveClv >= 0.50
              ? `⚠️ Önceki Kırmızı Mum Direnci (CLV:${effectiveClv} — LONG Veto)`
              : buySideSweep && effectiveClv >= 0.50
                ? `⚠️ Tepe Likidite Süpürmesi (CLV:${effectiveClv} — LONG Veto)`
                : `⚠️ Üst İğne Reddi (CLV:${effectiveClv} — LONG Veto)`
          : vetoShort
            ? isUnderfootWickFloorBlockingTp1Short
              ? `⚠️ 4s İğne Tabanı Desteği (CLV:${effectiveClv} — SHORT Veto)`
              : isPriorBarBullishRejectionUnbroken && effectiveClv <= 0.50
                ? `⚠️ Önceki Yeşil Mum Desteği (CLV:${effectiveClv} — SHORT Veto)`
                : `⚠️ Alt İğne Tepkisi (CLV:${effectiveClv} — SHORT Veto)`
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
    isVolTakerDecayLong,
    isDeadCatBounceIntoSupply,
    posIn4BarRange,
    posIn16BarRange,
    runup4BarPct,
    drop4BarPct,
    green3Completed,
    red3Completed,
    clv: effectiveClv,
    b0ElapsedFrac,
    b0IsGreen: b0.isGreen,
    b0MoveFromOpenPct: b0.open > 0 ? Number((((b0.close - b0.open) / b0.open) * 100).toFixed(2)) : 0,
    b1IsRedRejection: Boolean(!b1.isGreen && (b1.clv <= 0.38 || b1.upperWickRatio >= 0.42)),
    b1IsGreenRejection: Boolean(b1.isGreen && (b1.clv >= 0.62 || b1.lowerWickRatio >= 0.42)),
    b1MovePct: b1.open > 0 ? Number((((b1.close - b1.open) / b1.open) * 100).toFixed(2)) : 0,
    b1RangePct: b1.low > 0 ? Number((((b1.high - b1.low) / b1.low) * 100).toFixed(2)) : 0,
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

async function fetchPerpOrderbookConfirm(symbol, side, atr15mPct = 1.5) {
  // Engine #38 + #64A + #72E + #106C (GPT-6-Luna Two-Snapshot Perp Microprice, 7-Bar 1m Peak/Trough Reversal Guard & Passive Maker Fill — 1.8s Interval):
  const [d1, klines1m] = await Promise.all([
    fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}USDT&limit=20`, {}, 2500),
    fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}USDT&interval=1m&limit=7`, {}, 2500),
  ]);
  if (!d1?.bids?.length || !d1?.asks?.length) return { ok: false, vetoCode: 'NO_DEPTH', reason: 'NO_DEPTH_1' };

  // Engine #64A + #72E + #103B + #106C (GPT-6-Luna Rolling 3m/5m Blow-Off Spike & Two-Red-Bar Reversal Guard):
  if (Array.isArray(klines1m) && klines1m.length >= 3) {
    const kNow = klines1m[klines1m.length - 1];
    const kPrev1 = klines1m[klines1m.length - 2];
    const kPrev2 = klines1m[klines1m.length - 3];
    const completed1m = klines1m.slice(0, -1);
    const open2mAgo = Number(kPrev2[1] || 0);
    const closeNow = Number(kNow[4] || 0);
    const highNow = Number(kNow[2] || 0);
    const lowNow = Number(kNow[3] || 0);
    const openNow = Number(kNow[1] || 0);
    const rangeNow = Math.max(1e-9, highNow - lowNow);
    const isMeaningful1mRange = openNow > 0 && rangeNow / openNow >= 0.0035;
    const upperWickNow = isMeaningful1mRange ? (highNow - Math.max(openNow, closeNow)) / rangeNow : 0;
    const lowerWickNow = isMeaningful1mRange ? (Math.min(openNow, closeNow) - lowNow) / rangeNow : 0;
    const recentHigh3m = Math.max(Number(kPrev2[2] || 0), Number(kPrev1[2] || 0), highNow);
    const recentLow3m = Math.min(Number(kPrev2[3] || 9e9), Number(kPrev1[3] || 9e9), lowNow);
    const spike3mPct = open2mAgo > 0 ? Number((((recentHigh3m - open2mAgo) / open2mAgo) * 100).toFixed(2)) : 0;
    const dump3mPct = open2mAgo > 0 ? Number((((recentLow3m - open2mAgo) / open2mAgo) * 100).toFixed(2)) : 0;
    const rejectionFrom3mHighPct = recentHigh3m > 0 ? Number((((recentHigh3m - closeNow) / recentHigh3m) * 100).toFixed(2)) : 0;
    const bounceFrom3mLowPct = recentLow3m > 0 ? Number((((closeNow - recentLow3m) / recentLow3m) * 100).toFixed(2)) : 0;
    const high5mCompleted = completed1m.length ? Math.max(...completed1m.map(k => Number(k[2] || 0))) : recentHigh3m;
    const low5mCompleted = completed1m.length ? Math.min(...completed1m.map(k => Number(k[3] || 9e9))) : recentLow3m;
    const runup5mPct = low5mCompleted > 0 ? Number((((high5mCompleted - low5mCompleted) / low5mCompleted) * 100).toFixed(2)) : 0;
    const dropFrom5mPeakPct = high5mCompleted > 0 ? Number((((high5mCompleted - closeNow) / high5mCompleted) * 100).toFixed(2)) : 0;
    const bounceFrom5mLowPct = low5mCompleted > 0 ? Number((((closeNow - low5mCompleted) / low5mCompleted) * 100).toFixed(2)) : 0;
    const prev1Open = Number(kPrev1[1] || 0);
    const prev1High = Number(kPrev1[2] || 0);
    const prev1Low = Number(kPrev1[3] || 0);
    const prev1Close = Number(kPrev1[4] || 0);
    const prev1Range = Math.max(1e-9, prev1High - prev1Low);
    const prev1Clv = (prev1Close - prev1Low) / prev1Range;
    const prev1BodyPct = prev1Open > 0 ? ((prev1Close - prev1Open) / prev1Open) * 100 : 0;
    const prev2Open = Number(kPrev2[1] || 0);
    const prev2Close = Number(kPrev2[4] || 0);
    const bothPrev2Red = prev1Close < prev1Open && prev2Close < prev2Open;
    const bothPrev2Green = prev1Close > prev1Open && prev2Close > prev2Open;
    const prev1IsRedDump = prev1Close < prev1Open && prev1Clv <= 0.25 && prev1BodyPct <= -0.25;
    const prev1IsGreenSqueeze = prev1Close > prev1Open && prev1Clv >= 0.75 && prev1BodyPct >= 0.25;
    const recentSpikeRejectionLong =
      (spike3mPct >= 0.90 && rejectionFrom3mHighPct >= 0.38 && (prev1IsRedDump || rejectionFrom3mHighPct >= 0.50)) ||
      (runup5mPct >= 0.85 && dropFrom5mPeakPct >= 0.45 && (bothPrev2Red || prev1IsRedDump)) ||
      (prev1BodyPct <= -0.40 && prev1Clv <= 0.20 && closeNow <= prev1Open * 0.999);
    const recentDumpRejectionShort =
      (dump3mPct <= -0.90 && bounceFrom3mLowPct >= 0.38 && (prev1IsGreenSqueeze || bounceFrom3mLowPct >= 0.50)) ||
      (runup5mPct >= 0.85 && bounceFrom5mLowPct >= 0.45 && (bothPrev2Green || prev1IsGreenSqueeze)) ||
      (prev1BodyPct >= 0.40 && prev1Clv >= 0.80 && closeNow >= prev1Open * 1.001);
    const move2mPct = open2mAgo > 0 ? Number((((closeNow - open2mAgo) / open2mAgo) * 100).toFixed(2)) : 0;
    const max2mSpikePct = Number(Math.max(1.15, Math.min(2.40, Number(atr15mPct || 1.5) * 0.78)).toFixed(2));
    if (side === 'LONG' && (move2mPct >= max2mSpikePct || (move2mPct >= 0.65 && upperWickNow >= 0.55) || recentSpikeRejectionLong)) {
      return {
        ok: false,
        vetoCode: 'MICRO_1M_SPIKE',
        reason: `MICRO_1M_SPIKE_WAIT_PULLBACK (2dk:+%${move2mPct}/${max2mSpikePct}% | 3dkZirve:+%${spike3mPct}->Red:-%${rejectionFrom3mHighPct} | 1dk Üstİğne:${(upperWickNow * 100).toFixed(0)}%)`,
      };
    }
    if (side === 'SHORT' && (move2mPct <= -max2mSpikePct || (move2mPct <= -0.65 && lowerWickNow >= 0.55) || recentDumpRejectionShort)) {
      return {
        ok: false,
        vetoCode: 'MICRO_1M_SPIKE',
        reason: `MICRO_1M_DUMP_WAIT_PULLBACK (2dk:%${move2mPct}/-${max2mSpikePct}% | 3dkDip:%${dump3mPct}->Tepki:+%${bounceFrom3mLowPct} | 1dk Altİğne:${(lowerWickNow * 100).toFixed(0)}%)`,
      };
    }
  }

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
  // Engine #53 + #87B + #89D (GPT-6-Luna & Cont-Kukanov-Stoikov OFI Spoof-Wall Decay vs. Active Ask-Lift Gate):
  // A true Spoof Wall Decay (SPOOF_WALL_DECAY) requires an actual directional wall at snapshot 1 (ob1 >= +0.06 for LONG / ob1 <= -0.06 for SHORT)
  // that subsequently collapsed at snapshot 2 (obDelta < -0.18 LONG / > +0.18 SHORT) accompanied by price dropping (LONG) or rising (SHORT).
  if (side === 'LONG') {
    if (ob1 >= 0.08 && obDelta < -0.18 && bestBid < bestBid1 && ob2 < -0.04) {
      return { ok: false, vetoCode: 'SPOOF_WALL_DECAY', reason: `SPOOF_WALL_DECAY_LONG (ob:${ob1}->${ob2} | dI:${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    const isActivelyLiftingAsks = bestBid > bestBid1 * 1.0001 && bestAsk >= bestAsk1;
    const isBidHoldingOrRising = bestBid >= bestBid1 && spreadPct <= 0.12;
    const minOb2Floor = isActivelyLiftingAsks ? -0.14 : isBidHoldingOrRising ? -0.08 : -0.02;
    const minAvgObFloor = isActivelyLiftingAsks ? -0.10 : isBidHoldingOrRising ? -0.06 : 0.00;
    if (avgOb < minAvgObFloor || ob2 < minOb2Floor || (!isActivelyLiftingAsks && microSkew < -0.45 && microSkew1 < -0.45)) {
      return { ok: false, vetoCode: 'WEAK_OB', reason: `WEAK_LONG_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  if (side === 'SHORT') {
    if (ob1 <= -0.08 && obDelta > 0.18 && bestAsk > bestAsk1 && ob2 > 0.04) {
      return { ok: false, vetoCode: 'SPOOF_WALL_DECAY', reason: `SPOOF_WALL_DECAY_SHORT (ob:${ob1}->${ob2} | dI:+${obDelta})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
    const isActivelyHittingBids = bestAsk < bestAsk1 * 0.9999 && bestBid <= bestBid1;
    const isAskHoldingOrFalling = bestAsk <= bestAsk1 && spreadPct <= 0.12;
    const maxOb2Ceil = isActivelyHittingBids ? 0.14 : isAskHoldingOrFalling ? 0.08 : 0.02;
    const maxAvgObCeil = isActivelyHittingBids ? 0.10 : isAskHoldingOrFalling ? 0.06 : 0.00;
    if (avgOb > maxAvgObCeil || ob2 > maxOb2Ceil || (!isActivelyHittingBids && microSkew > 0.45 && microSkew1 > 0.45)) {
      return { ok: false, vetoCode: 'WEAK_OB', reason: `WEAK_SHORT_OB_OR_MICROPRICE (ob:${ob1}->${ob2} | x1:${microSkew1}->x2:${microSkew})`, bestBid, bestAsk, spreadPct, avgOb, microSkew };
    }
  }
  // Engine #64A + GPT-6-Luna Fix #1 (Strict Passive Maker Limit Fill — Only classify as Maker Fill if bestAsk1/bestBid1 was actually traded through during the 1.8s window):
  const isPassiveMakerFill =
    side === 'LONG'
      ? bestAsk <= bestBid1 && ob2 >= 0.08
      : bestBid >= bestAsk1 && ob2 <= -0.08;
  const makerEntryPrice =
    side === 'LONG' ? Math.min(bestBid1, bestAsk) : Math.max(bestAsk1, bestBid);
  return {
    ok: true,
    vetoCode: 'OK',
    bestBid,
    bestAsk,
    isPassiveMakerFill,
    makerEntryPrice,
    spreadPct,
    avgOb,
    ob1,
    ob2,
    obDelta,
    microSkew1,
    microSkew,
  };
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
  const [validMap, premiumList, tickerList, btcKlines15m, btcKlines1m] = await Promise.all([
    getValidCoinPerpMap(),
    fetchJson(`${FAPI_BASE}/fapi/v1/premiumIndex`, {}, 5000),
    fetchJson(`${FAPI_BASE}/fapi/v1/ticker/24hr`, {}, 5000),
    fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=10`, {}, 4000),
    fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=4`, {}, 3500),
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

  let btc2mChangePct = 0;
  let btc15mChangePct = 0;
  let btc1hChangePct = 0;
  if (Array.isArray(btcKlines1m) && btcKlines1m.length >= 3) {
    const b1mLast = Number(btcKlines1m[btcKlines1m.length - 1][4]);
    const b1mPrev2 = Number(btcKlines1m[btcKlines1m.length - 3][1]);
    if (b1mPrev2 > 0) btc2mChangePct = Number((((b1mLast - b1mPrev2) / b1mPrev2) * 100).toFixed(2));
  }
  if (Array.isArray(btcKlines15m) && btcKlines15m.length >= 6) {
    const bLast = Number(btcKlines15m[btcKlines15m.length - 1][4]);
    const bPrev15m = Number(btcKlines15m[btcKlines15m.length - 2][4]);
    const bPrev1h = Number(btcKlines15m[btcKlines15m.length - 5][4]);
    if (bPrev15m > 0) btc15mChangePct = Number((((bLast - bPrev15m) / bPrev15m) * 100).toFixed(2));
    if (bPrev1h > 0) btc1hChangePct = Number((((bLast - bPrev1h) / bPrev1h) * 100).toFixed(2));
  }

  // Engine #64B (Human 1-Minute BTC Reflex — Instant veto if BTC dumps <= -0.28% or spikes >= +0.28% in 2 minutes!):
  const btcVetoLong = btc2mChangePct <= -0.28 || btc15mChangePct <= -0.45 || btc1hChangePct <= -1.10;
  const btcVetoShort = btc2mChangePct >= 0.28 || btc15mChangePct >= 0.45 || btc1hChangePct >= 1.10;

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

  // Engine #51B + #55B + #103D (GPT-6-Luna Deterministic Hype-Shortlist + Quarantine Slot Purge):
  // Guarantee the top 10 pure 24h/squeeze gainers are ALWAYS included in topToInspect, plus the highest priorityScore candidates up to 30 slots,
  // while never wasting API inspection slots on symbols locked in 12-hour quarantine (>20m cooldown)!
  const nowScanMs = Date.now();
  const isQuarantinedSym = sym =>
    sym !== state.openPosition?.symbol &&
    Number(state.symbolCooldowns?.[sym] || 0) - nowScanMs > 20 * 60 * 1000;
  const hypeSorted = [...preCandidates]
    .filter(c => c.change24hPct >= 4.0 && !isQuarantinedSym(c.symbol))
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
    if (isQuarantinedSym(p.symbol)) continue;
    inspectMap.set(p.symbol, p);
  }
  const topToInspect = Array.from(inspectMap.values());

  const evaluated = [];
  for (const item of topToInspect) {
    // Engine #35 + #55C + #83A (GPT-6-Luna Zero-Lag Rolling 5m Kline Taker Stream Replacing 8-13m Delayed /futures/data/takerlongshortRatio):
    // Empirical verification on Binance Futures proved /futures/data/takerlongshortRatio?period=5m is identically kline5m[9] / (kline5m[5] - kline5m[9]),
    // EXCEPT the /futures/data/takerlongshortRatio endpoint lags by 8 to 13 minutes (omitting live 5m bar b0 and delaying closed 5m bar b1 by ~3.5m).
    // Fetching /fapi/v1/klines?interval=5m&limit=4 gives 0ms real-time rolling 5-minute taker buy/sell flow!
    const [klines15m, oiHist, topPosRatio, globalAccRatio, klines5m] = await Promise.all([
      fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=${item.fSym}&interval=15m&limit=64`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${item.fSym}&period=15m&limit=5`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${item.fSym}&period=15m&limit=2`, {}, 3500),
      fetchJson(`${FAPI_BASE}/fapi/v1/klines?symbol=${item.fSym}&interval=5m&limit=4`, {}, 3500),
    ]);
    if (!Array.isArray(klines15m) || klines15m.length < 30) continue;

    const closes = klines15m.map(k => Number(k[4]));
    const lastPrice = closes[closes.length - 1];
    const price1hAgo = closes[Math.max(0, closes.length - 5)];
    const change1hPct = price1hAgo > 0 ? Number((((lastPrice - price1hAgo) / price1hAgo) * 100).toFixed(2)) : 0;
    // Engine #60B + #63B: Compute completed-bar RSI/ATR & MTF first, then pass ATR & MTF context into analyzeCandleSmcAndCvd15m
    const b0OpenTimeMs = Number(klines15m[klines15m.length - 1]?.[0] || 0);
    const b0ElapsedPre = b0OpenTimeMs > 0 ? Math.max(0.05, Math.min(1.0, (Date.now() - b0OpenTimeMs) / (15 * 60 * 1000))) : 0.5;
    const klinesForRsiAtr = b0ElapsedPre < 0.50 && klines15m.length > 20 ? klines15m.slice(0, -1) : klines15m;
    const closesForRsi = klinesForRsiAtr.map(k => Number(k[4]));
    const rsi15m = computeRsi(closesForRsi, 14);
    const atr15mPct = computeAtrPct(klinesForRsiAtr, 14);
    const mtfSqueeze = analyzeMtfAndVolatilitySqueeze(klines15m);
    const anatomy = analyzeCandleSmcAndCvd15m(klines15m, atr15mPct, item.change24hPct, mtfSqueeze.mtfBullishPts > 0);

    // Engine #83A (GPT-6-Luna Zero-Lag Volume-Weighted Rolling 5m Taker Flow & Prior 5m Window):
    const klines5mValid =
      Array.isArray(klines5m) &&
      klines5m.length >= 3 &&
      Date.now() - Number(klines5m[klines5m.length - 1]?.[0] || 0) <= 6 * 60 * 1000;
    let takerDataValid = false;
    let rawInstBuySellRatio = 1.0;
    let rawPrevInstBuySellRatio = 1.0;
    if (klines5mValid) {
      const b0_5m = klines5m[klines5m.length - 1];
      const b1_5m = klines5m[klines5m.length - 2];
      const b2_5m = klines5m[klines5m.length - 3];
      const w0_5m = Math.max(0.0, Math.min(1.0, (Date.now() - Number(b0_5m[0])) / (5 * 60 * 1000)));
      const b0Buy = Math.max(0, Number(b0_5m[9]) || 0);
      const b0Tot = Math.max(b0Buy, Number(b0_5m[5]) || 0);
      const b0Sell = Math.max(0, b0Tot - b0Buy);
      const b1Buy = Math.max(0, Number(b1_5m[9]) || 0);
      const b1Tot = Math.max(b1Buy, Number(b1_5m[5]) || 0);
      const b1Sell = Math.max(0, b1Tot - b1Buy);
      const b2Buy = Math.max(0, Number(b2_5m[9]) || 0);
      const b2Tot = Math.max(b2Buy, Number(b2_5m[5]) || 0);
      const b2Sell = Math.max(0, b2Tot - b2Buy);
      const rolling5mBuy = b0Buy + (1 - w0_5m) * b1Buy;
      const rolling5mSell = b0Sell + (1 - w0_5m) * b1Sell;
      const prev5mBuy = w0_5m * b1Buy + (1 - w0_5m) * b2Buy;
      const prev5mSell = w0_5m * b1Sell + (1 - w0_5m) * b2Sell;
      if (rolling5mBuy + rolling5mSell > 0 && prev5mBuy + prev5mSell > 0) {
        takerDataValid = true;
        rawInstBuySellRatio = Math.max(0.05, Math.min(9.99, rolling5mBuy / Math.max(1e-9, rolling5mSell)));
        rawPrevInstBuySellRatio = Math.max(0.05, Math.min(9.99, prev5mBuy / Math.max(1e-9, prev5mSell)));
      }
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

    // Engine #78A (GPT-6-Luna Pure Coin-Contract Open Interest Delta — eliminates price-contaminated sumOpenInterestValue):
    let oiDelta1hPct = 0;
    if (Array.isArray(oiHist) && oiHist.length >= 2) {
      const firstContractOi = Number(oiHist[0]?.sumOpenInterest || 0);
      const lastContractOi = Number(oiHist[oiHist.length - 1]?.sumOpenInterest || 0);
      if (Number.isFinite(firstContractOi) && Number.isFinite(lastContractOi) && firstContractOi > 0 && lastContractOi > 0) {
        oiDelta1hPct = Number((((lastContractOi - firstContractOi) / firstContractOi) * 100).toFixed(2));
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

    // Engine #55D + #76A + #86A + #88A (GPT-6-Luna & Freebuff Anti-Arbitrage Fake Short-Squeeze Whale Veto):
    // Chronic negative funding on low 24h trend (e.g. MTLUSDT -0.34% funding, +2.78% 24h, -11.7% whale spread, RSI 75.46) is passive spot-perp basis carry + BSL sweep trap, NOT a 24h short squeeze!
    // Require BOTH 24h trend >= +6.5% AND 1h momentum >= +1.50% (with volRatio15m >= 1.15 or TTM upward breakout) before activating isActiveShortSqueezeRegime!
    const isActiveShortSqueezeRegime = Boolean(
      (item.fundingRatePct <= -0.025 ||
        (item.basisPct <= -0.25 && item.change24hPct >= 14.0 && change1hPct >= 1.50 && oiDelta1hPct >= 2.0)) &&
        (volRatio15m >= 1.15 || mtfSqueeze.squeezeBullishPts > 0) &&
        item.change24hPct >= 6.5 &&
        change1hPct >= 1.50 &&
        (oiQuadrant.startsWith('Q1') || oiQuadrant.startsWith('Q3-TUZAK') || mtfSqueeze.squeezeBullishPts > 0)
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
        // Engine #86A: Neutralize bearish whale penalty during confirmed high-volume short squeezes; only award positive squeeze fuel when volume >= 1.35x and 1h >= +2.0%!
        bullishWhalePts =
          volRatio15m >= 1.35 && change1hPct >= 2.0 ? Math.min(6, Math.round(Math.abs(item.fundingRatePct) * 45)) : 0;
        bearishWhalePts = 0;
      } else {
        bearishWhalePts = Math.min(15, Math.round((Math.abs(whaleRetailSpread) - 1.5) * 1.35));
        bullishWhalePts = -Math.min(18, Math.round(Math.abs(whaleRetailSpread) * 1.2));
      }
    }
    const isExplosiveWhaleSqueezeOverride =
      isActiveShortSqueezeRegime &&
      item.change24hPct >= 10.0 &&
      change1hPct >= 2.20 &&
      rawInstBuySellRatio >= 1.35;
    const whaleVetoLong =
      (isExplosiveWhaleSqueezeOverride ? whaleRetailSpread <= -14.0 : whaleRetailSpread <= -6.5) ||
      isWhaleDistributingOverboughtLong;
    const whaleVetoShort =
      isWhaleAccumulatingOversoldShort ||
      (isLiveInstTakerDumping ? whaleRetailSpread >= 16.5 : whaleRetailSpread >= 10.5);

    // Engine #44A + #45 + #50 + #54B + #63D: 5m Institutional Taker Floor (>=1.12x LONG) & Strict Anti-Bleed SHORT Lockdown
    const tuning = state.adaptiveTuning || { minLongScore: 84, minShortScore: 86, minLongTaker5m: 1.18, maxShortTaker5m: 0.84 };
    const curMaxShortTaker5m = Math.min(0.86, tuning.maxShortTaker5m ?? 0.86);

    const high4h = Math.max(...klines15m.slice(-17, -1).map(k => Number(k[2])));
    const low4h = Math.min(...klines15m.slice(-17, -1).map(k => Number(k[3])));

    // Engine #43B + #50 + #77B (GPT-6-Luna Unified Anti-Backwardation Squeeze & Strict Q3/Negative-1h GCR Mania Short Gate):
    // Never classify a slow +7.5% coin with positive 1h momentum (+0.02%) and NÖTR OI (+0.04%) as a GCR Mania Short!
    const isGcrCrowdedManiaShort = Boolean(
      (item.change24hPct >= 12.0 || (item.change24hPct >= 8.5 && rsi15m >= 73)) &&
        rsi15m >= 62 &&
        anatomy.posIn16BarRange >= 0.58 &&
        change1hPct > -2.20 &&
        change1hPct <= -0.15 &&
        item.basisPct >= -0.020 &&
        item.fundingRatePct >= 0.0 &&
        (oiQuadrant.startsWith('Q3') || (oiQuadrant.startsWith('Q2') && anatomy.normCvd3BarPct <= -8.0)) &&
        !oiQuadrant.startsWith('Q3-TUZAK') &&
        rawInstBuySellRatio <= curMaxShortTaker5m &&
        (whaleRetailSpread <= -4.0 || item.basisPct >= 0.045 || item.fundingRatePct >= 0.018 || isLiveInstTakerDumping) &&
        (anatomy.bearishPattern || anatomy.buySideSweep || anatomy.bearishCvdPts >= 6)
    );
    if (isGcrCrowdedManiaShort) {
      bearishWhalePts = Math.min(16, bearishWhalePts + 6);
    }

    // Layer #16 + Engine #52 + #57A + #77A (GPT-6-Luna Hype-Breakout, Short-Squeeze Reload & Qullamaggie High-Tight-Flag TTM-Coil LONG Engine):
    // Fixed Bug #16 & #20 + Engine #57A + #77A: Require genuine 24h hype (>= +6.5% & 1h >= +0.65%) or explosive 1h/squeeze breakout (never a +3.98% 24h crawl under 4h resistance like DASHUSDT!)
    const isSqueezeConfirmedLong =
      oiQuadrant.startsWith('Q3-TUZAK') ||
      mtfSqueeze.squeezeBullishPts > 0 ||
      ((item.fundingRatePct <= -0.020 || item.basisPct <= -0.10) && oiDelta1hPct >= 0.35);
    const isStallingUnder4hResistanceLong =
      anatomy.posIn16BarRange >= 0.84 &&
      lastPrice < high4h * 1.001 &&
      volRatio15m < 1.35 &&
      item.fundingRatePct > -0.025;
    // Engine #79B: Inside a TTM Coil, require either confirmed upward squeeze expansion (squeezeBullishPts > 0)
    // or institutional volume >= 0.72x with no prior-bar bearish rejection veto (!anatomy.vetoLong) — never buy a 0.50x volume coil bleed!
    const isHtfCoilContinuationLong = Boolean(
      (mtfSqueeze.squeezeBullishPts > 0 ||
        (mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') && volRatio15m >= 0.72)) &&
        item.change24hPct >= 6.0 &&
        change1hPct >= 0.35 &&
        (oiQuadrant.startsWith('Q1') || isSqueezeConfirmedLong) &&
        mtfSqueeze.mtfBullishPts > 0 &&
        takerDataValid &&
        rawInstBuySellRatio >= 1.12 &&
        volRatio15m >= 0.65 &&
        rsi15m <= 66 &&
        anatomy.normCvd3BarPct >= 3.5 &&
        anatomy.clv >= 0.65 &&
        mtfSqueeze.mtfBearishPts === 0 &&
        !anatomy.vetoLong &&
        !anatomy.isFishingTrapLong
    );
    const minHypeSqueezeClv =
      mtfSqueeze.squeezeBullishPts > 0 && volRatio15m >= 1.50 && rawInstBuySellRatio >= 1.25 ? 0.48 : 0.56;
    // Engine #88A: Require genuine 24h momentum (item.change24hPct >= 6.5%) across ALL branches of isHypeSqueezeMomentumLong
    // so sleepy low-24h coins (+2.78% 24h like MTLUSDT) NEVER unlock RSI > 70 or wide VWAP extension bands!
    const isHypeSqueezeMomentumLong = Boolean(
      item.change24hPct >= 6.5 &&
        (change1hPct >= 0.65 || (isSqueezeConfirmedLong && item.fundingRatePct <= -0.020 && change1hPct >= 0.50)) &&
        !isStallingUnder4hResistanceLong &&
        (oiQuadrant.startsWith('Q1') || isSqueezeConfirmedLong) &&
        takerDataValid &&
        rawInstBuySellRatio >= 1.12 &&
        (volRatio15m >= 0.85 || isHtfCoilContinuationLong) &&
        rsi15m <= 78 &&
        anatomy.normCvd3BarPct >= 3.5 &&
        anatomy.clv >= minHypeSqueezeClv &&
        mtfSqueeze.mtfBearishPts === 0 &&
        !anatomy.vetoLong &&
        !anatomy.isFishingTrapLong
    );

    let velocityLongPts = 0;
    let velocityShortPts = 0;
    // Motor #106B (GPT-6-Luna Directional Candle Evidence for Velocity Points):
    // Never award +8p velocityLongPts when the live 15m candle b0 is RED (!anatomy.b0IsGreen) or has weak CLV (< 0.60, like POLYXUSDT selling climax at 10:41)!
    if (isHypeSqueezeMomentumLong && (anatomy.b0IsGreen || anatomy.b0ElapsedFrac < 0.35)) {
      velocityLongPts = Math.min(14, Math.round(6 + Math.max(0, change1hPct) * 2.2 + Math.max(0, volRatio15m - 0.8) * 3));
    } else if (
      change1hPct >= 0.85 &&
      mtfSqueeze.mtfBullishPts > 0 &&
      volRatio15m >= 1.25 &&
      anatomy.b0IsGreen &&
      anatomy.clv >= 0.60 &&
      !anatomy.isFishingTrapLong
    ) {
      velocityLongPts = Math.min(8, Math.round(change1hPct * 2.5 + (volRatio15m - 1) * 3));
    } else if (
      change1hPct <= -0.85 &&
      mtfSqueeze.mtfBearishPts > 0 &&
      !anatomy.b0IsGreen &&
      anatomy.clv <= 0.40 &&
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

    // Layer #15 + Engine #77A + #96B + #104B: Liquidation Magnet Cluster Detector (4h High/Low Stop-Hunt & Short/Long Squeeze Magnet — requires whale alignment >= 0, 1h >= +0.55%, and no prior-bar red supply rejection unless active squeeze + 1h >= +1.0% + RS >= +0.85 ATR is present so NILUSDT double-top retests never get +5p magnet inflation!)
    let liqMagnetLongPts = 0;
    let liqMagnetShortPts = 0;
    let liqMagnetLabel = '';
    if (
      oiDelta1hPct >= 0.50 &&
      lastPrice >= high4h * 0.988 &&
      whaleRetailSpread >= 0 &&
      change1hPct >= 0.55 &&
      (item.fundingRatePct < 0 || item.basisPct <= -0.025) &&
      (!anatomy.b1IsRedRejection || (mtfSqueeze.squeezeBullishPts > 0 && change1hPct >= 1.0 && rsVsBtcAtr >= 0.85)) &&
      !(anatomy.green3Completed && lastPrice < high4h * 1.001 && volRatio15m < 1.30 && item.fundingRatePct > -0.015) &&
      !anatomy.vetoLong
    ) {
      liqMagnetLongPts = 5;
      liqMagnetLabel = ' | 🧲 Short Likidasyon Mıknatısı';
    } else if (
      (oiDelta1hPct >= 0.45 || isLiveInstTakerDumping) &&
      lastPrice <= low4h * 1.012 &&
      whaleRetailSpread <= 0 &&
      change1hPct <= -0.55 &&
      item.fundingRatePct > -0.05 &&
      (!anatomy.b1IsGreenRejection || (mtfSqueeze.squeezeBearishPts > 0 && change1hPct <= -1.0 && rsVsBtcAtr <= -0.85)) &&
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
    // Motor #106B (GPT-6-Luna Anti-Double-Counted Spot-Discount Carry Cap on 24h-Red / Negative-Whale / No-Pattern Coins):
    // Negative funding and negative basis measure the same spot-perp arbitrage discount. When there is no fresh news,
    // never let passive discount double-counting award +22 points on a coin with 24h < 0, negative whale spread, and no bullish pattern (like POLYXUSDT 24s:-3.53%, Whale:-1.6%, CLV:0.52 -> 93p)!
    if (!hasFreshDirectNews && !hasSpotGoldenLeaderSynergy) {
      if (item.change24hPct < 0 && whaleRetailSpread < 0 && !anatomy.bullishPattern) {
        bullishFundNewsPts = 0;
        bullishBasisPts = 0;
      } else if (item.change24hPct < 0 || whaleRetailSpread < 0 || !anatomy.bullishPattern) {
        const combinedCarryPts = bullishFundNewsPts + bullishBasisPts;
        if (combinedCarryPts > 8) {
          const excessCarry = combinedCarryPts - 8;
          const trimFund = Math.min(bullishFundNewsPts, excessCarry);
          bullishFundNewsPts -= trimFund;
          bullishBasisPts = Math.max(0, bullishBasisPts - (excessCarry - trimFund));
        }
      }
    }

    if (item.fundingRatePct >= 0.015) {
      bearishFundNewsPts += Math.min(10, Math.round(item.fundingRatePct * 350));
    }
    if (rsi15m >= 69) {
      bearishFundNewsPts += Math.min(8, Math.round((rsi15m - 66) * 1.2));
    }
    bearishFundNewsPts = Math.min(13, bearishFundNewsPts);

    // Wall #6B + Engine #39 + #81C (GPT-6-Luna Contract-Specific nextFundingTime Settlement Cost & Farmer Dump Guard):
    // Block new LONG entries in the final 8 minutes before funding settlement when funding <= -0.15% (funding farmers dump immediately after snapshot!)
    const fundingVetoLong =
      item.fundingRatePct >= 0.080 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct >= 0.035) ||
      (itemMinsToFunding <= 12 && item.fundingRatePct <= -0.35) ||
      (itemMinsToFunding <= 8 && item.fundingRatePct <= -0.15);
    const fundingVetoShort =
      item.fundingRatePct <= -0.120 ||
      (itemMinsToFunding <= 15 && item.fundingRatePct <= -0.035);

    // Engine #40 + #52 + #57B + #80C + #89C (Qullamaggie + GPT-6-Luna ATR-Normalized Hype VWAP & RSI Extension Band):
    // Allow up to 2.35 * ATR% room from 4h VWAP (up to 10.50%) on confirmed Qullamaggie/Hype-Squeeze breakouts
    // so genuine hype rockets like CAPUSDT (ATR 4.035%, vwapDist 7.76% = 1.92x ATR, +41.9% 24h, Q1 OI, Whale +5.8%, Taker 1.32x) are NEVER starved!
    const hasQullamaggieMomentumConfirm =
      isHypeSqueezeMomentumLong ||
      isHtfCoilContinuationLong ||
      (oiDelta1hPct >= 0.35 &&
        rawInstBuySellRatio >= 1.16 &&
        volRatio15m >= 0.85 &&
        anatomy.normCvd3BarPct >= 6.0 &&
        anatomy.clv >= 0.60);
    const baseAtrVwapBandPct = Math.max(2.10, Math.min(3.60, Number((1.65 * atr15mPct).toFixed(2))));
    const vwapMaxBandPct = hasQullamaggieMomentumConfirm
      ? Math.max(baseAtrVwapBandPct, 4.20, Math.min(10.50, Number((2.35 * atr15mPct).toFixed(2))))
      : baseAtrVwapBandPct;
    const maxAllowedLongRsi = isHypeSqueezeMomentumLong || hasQullamaggieMomentumConfirm ? 78 : 72;
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

    // Engine #63C: Symmetric Cross-Basis Penalties (subtract bearishBasisPts from rawLongTotal and bullishBasisPts from rawShortTotal)
    const rawLongTotal = Math.max(
      0,
      36 +
        bullishOiPts +
        bullishWhalePts +
        anatomy.bullishCvdPts +
        anatomy.bullishSmcPts +
        anatomy.bullishCandlePts +
        bullishFundNewsPts +
        (isBnfLiquidationBounce ? 8 : bullishRsPts + mtfSqueeze.mtfBullishPts) +
        bullishBasisPts -
        bearishBasisPts +
        mtfSqueeze.squeezeBullishPts +
        instTakerLongPts +
        liqMagnetLongPts +
        velocityLongPts
    );

    const rawShortTotal = Math.max(
      0,
      36 +
        bearishOiPts +
        bearishWhalePts +
        anatomy.bearishCvdPts +
        anatomy.bearishSmcPts +
        anatomy.bearishCandlePts +
        bearishFundNewsPts +
        bearishRsPts +
        bearishBasisPts -
        bullishBasisPts +
        mtfSqueeze.mtfBearishPts +
        mtfSqueeze.squeezeBearishPts +
        instTakerShortPts +
        liqMagnetShortPts +
        velocityShortPts
    );

    let engine = 'WATCHLIST';
    let side = 'LONG_ADAY';
    let score = 50;
    let thesis = '';

    const longStructDistPct =
      anatomy.structuralLow > 0 && anatomy.structuralLow < lastPrice
        ? ((lastPrice - anatomy.structuralLow * 0.999) / lastPrice) * 100
        : 0.95;
    const shortStructDistPct =
      anatomy.structuralHigh > lastPrice
        ? ((anatomy.structuralHigh * 1.001 - lastPrice) / lastPrice) * 100
        : 0.95;

    // Engine #82B + #89A (GPT-6-Luna Hype-Unchained Single-Bar Climax Gate):
    // Never blindly ban a hype coin just because its 2-bar range (longStructDistPct) is > 2.20%!
    // Only block when b1 spiked >= max(3.50%, 2.25 * ATR%) in a single 15m bar AND live bar b0 has turned red (!anatomy.b0IsGreen)!
    const isSingleBarClimaxTopLong =
      (anatomy.b1RangePct >= Math.max(3.50, atr15mPct * 2.25) || anatomy.b1MovePct >= Math.max(3.20, atr15mPct * 2.10)) &&
      !anatomy.b0IsGreen;
    const isSingleBarClimaxBottomShort =
      (anatomy.b1RangePct >= Math.max(3.50, atr15mPct * 2.25) || anatomy.b1MovePct <= -Math.max(3.20, atr15mPct * 2.10)) &&
      anatomy.b0IsGreen;

    // Wall #4 + Bug #17 Fix + Engine #57C + #77A + #82B: Anti-Top-Chase / 4h Double-Top Supply Exhaustion Ceiling
    const isCoiledTopLongTrap =
      !isBnfLiquidationBounce &&
      !isHtfCoilContinuationLong &&
      mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') &&
      item.change24hPct >= 8.0 &&
      Math.abs(change1hPct) <= 0.85 &&
      anatomy.clv >= 0.80;
    const is4hDoubleTopSupplyExhaustionLong =
      !isBnfLiquidationBounce &&
      !isHtfCoilContinuationLong &&
      anatomy.green3Completed &&
      anatomy.posIn16BarRange >= 0.84 &&
      lastPrice <= high4h * 1.002 &&
      volRatio15m < 1.45 &&
      item.fundingRatePct > -0.025;
    const isHypeExhaustedTopLong =
      isHypeSqueezeMomentumLong &&
      item.change24hPct >= 95.0 &&
      !isHtfCoilContinuationLong &&
      (volRatio15m < 1.15 || rawInstBuySellRatio < 1.12 || anatomy.posIn4BarRange >= 0.94);
    // Engine #92A (GPT-6-Luna Anti-1H-Blowoff-Exhaustion-on-Non-Q1-OI):
    // When Open Interest is NOT expanding (NÖTR or Q2, !oiQuadrant.startsWith('Q1')), a >= +3.20% 1-hour spike or >= +2.85 ATR relative extension
    // (like ZROUSDT 1s:+4.30%, RS_BTC:+3.59 ATR, NÖTR OI +0.04% at $1.7713) is an exhausted 1-hour blow-off top right before mean-reversion!
    const isNonQ1OneHourBlowoffTopLong =
      !isBnfLiquidationBounce &&
      !oiQuadrant.startsWith('Q1') &&
      (rsVsBtcAtr >= 2.85 || change1hPct >= 3.20);
    // Engine #97A (GPT-6-Luna Anti-1H-Blowoff-Exhaustion Even on Q1 OI When Candle Closes Weak & Stop Is Stretched):
    // Even if Q1 OI is present, when a coin has already spiked >= +3.40% in 1h or >= +3.00 ATR vs BTC
    // AND its 15m candle fails to close strong (anatomy.clv < 0.68 or !anatomy.bullishPattern with longStructDistPct >= 1.85,
    // like GRASSUSDT 1s:+3.62%, RS_BTC:+3.33 ATR, CLV:0.56 Dengeli Mum, Stop:-2.20% at $0.7372),
    // the 1-hour vertical leg is exhausted right at local supply!
    const isQ1OneHourExhaustedTopLong =
      !isBnfLiquidationBounce &&
      (rsVsBtcAtr >= 3.00 || change1hPct >= 3.40) &&
      (anatomy.clv < 0.68 || (!anatomy.bullishPattern && longStructDistPct >= 1.85));
    // Engine #104B (GPT-6-Luna Unbroken Supply Retest Top-Chase Guard):
    // When there is NO active bullish squeeze breakout (squeezeBullishPts === 0) and completed bar b1 was a red supply rejection (b1IsRedRejection),
    // never chase a stretched live bar b0 (b0MoveFromOpenPct >= 0.95% or longStructDistPct >= 1.65%) right into the top 15% of the 4h range (posIn16BarRange >= 0.85, lastPrice <= high4h * 1.001)!
    const isUnbrokenSupplyRetestTopLong =
      !isBnfLiquidationBounce &&
      !isHypeSqueezeMomentumLong &&
      mtfSqueeze.squeezeBullishPts === 0 &&
      anatomy.b1IsRedRejection &&
      anatomy.posIn16BarRange >= 0.85 &&
      lastPrice <= high4h * 1.001 &&
      (anatomy.b0MoveFromOpenPct >= 0.95 || longStructDistPct >= 1.65);
    const isOverextendedMicroTopLong =
      isSingleBarClimaxTopLong ||
      isCoiledTopLongTrap ||
      is4hDoubleTopSupplyExhaustionLong ||
      isHypeExhaustedTopLong ||
      isNonQ1OneHourBlowoffTopLong ||
      isQ1OneHourExhaustedTopLong ||
      isUnbrokenSupplyRetestTopLong ||
      (!isBnfLiquidationBounce &&
        !isHypeSqueezeMomentumLong &&
        ((anatomy.green3Completed &&
          anatomy.runup4BarPct >= Math.max(0.95, atr15mPct * 1.45) &&
          anatomy.posIn4BarRange >= 0.86 &&
          volRatio15m < 1.55) ||
          (item.change24hPct >= 18.0 && (volRatio15m < 1.35 || mtfSqueeze.mtfBullishPts === 0))));

    // Engine #43 + #47 + #48 + #82B: Anti-Bottom-Chase, Q4 De-Leveraging, Macro-Uptrend Pullback & Coiled-Bottom Short Shield
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
      isSingleBarClimaxBottomShort ||
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
    // Engine #94C (GPT-6-Luna Extreme Spot-Perp Backwardation Hedging Trap Veto):
    // When a coin has extreme perpetual discount (basisPct <= -1.20% or fundingRatePct <= -0.22%) inside a flat coil (Yay Sıkışması + YATAY MTF)
    // with weak whale support (whaleRetailSpread < 4.0, like TUSDT basis -3.40%, funding -0.28%, whale +1.0%), market makers are shorting perps to hedge spot distribution!
    const isExtremeBackwardationCoilTrapLong =
      (item.basisPct <= -1.20 || item.fundingRatePct <= -0.22) &&
      mtfSqueeze.squeezeBullishPts === 0 &&
      (mtfSqueeze.mtfBullishPts === 0 || whaleRetailSpread < 4.0);
    const isBasisDumpTrapLong =
      isFallingKnifeLongVeto ||
      isExtremeBackwardationCoilTrapLong ||
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

    // Engine #47A + #63D: Strict Zero-Bleed Directional 3-Bar CVD Floor (>= +3.5% LONG / <= -4.0% SHORT)
    const hasCvdAlignmentLong = anatomy.normCvd3BarPct >= 3.5;
    const hasCvdAlignmentShort = anatomy.normCvd3BarPct <= -4.0;

    // Engine #63C + #71A + #89C: Allow perp momentum basis up to +0.38% during confirmed Q1/Hype breakouts (like CAPUSDT +41.9% 24h, Q1 OI, Whale +5.8%, Taker 1.32x, Basis +0.1887%)
    const hasConfirmedHypeOrQ1FlowLong =
      isHypeSqueezeMomentumLong ||
      (oiQuadrant.startsWith('Q1') && whaleRetailSpread >= 0 && rawInstBuySellRatio >= 1.18);
    const contangoVetoLong =
      item.basisPct >= (hasConfirmedHypeOrQ1FlowLong ? 0.380 : 0.140) ||
      (!hasConfirmedHypeOrQ1FlowLong &&
        item.basisPct >= 0.075 &&
        !(item.fundingRatePct <= -0.015 && oiQuadrant.startsWith('Q1') && rawInstBuySellRatio >= 1.35)) ||
      (oiQuadrant === 'NÖTR' && item.basisPct > 0.045 && !hasFreshDirectNews && whaleRetailSpread < 5.0);
    const symPriorStops = Number(state.symbolConsecStops?.[item.symbol] || 0);
    // Motor #103C (GPT-6-Luna Independent Bullish Confirmation for Whale+Taker Fallback & Prior-Stop Range Chop Veto):
    // Never allow a single-bar whale+taker spike to override YATAY MTF + Normal Squeeze + NÖTR OI + positive funding on a symbol with a prior stop (like GRASSUSDT -5.45 TL)!
    const blockWhaleTakerLongFallback =
      symPriorStops >= 1 &&
      mtfSqueeze.mtfBullishPts === 0 &&
      mtfSqueeze.squeezeBullishPts === 0 &&
      oiQuadrant === 'NÖTR' &&
      item.fundingRatePct > 0;
    const hasLongStructureOrBreakout =
      mtfSqueeze.mtfBullishPts > 0 ||
      mtfSqueeze.squeezeBullishPts > 0 ||
      isHtfCoilContinuationLong ||
      isHypeSqueezeMomentumLong ||
      (!blockWhaleTakerLongFallback &&
        whaleRetailSpread >= 4.0 &&
        rawInstBuySellRatio >= 1.30 &&
        anatomy.normCvd3BarPct >= 10.0 &&
        change1hPct >= 0.45 &&
        (mtfSqueeze.mtfBullishPts > 0 || oiQuadrant.startsWith('Q1') || item.fundingRatePct <= -0.010 || symPriorStops === 0)) ||
      (oiQuadrant.startsWith('Q1') && oiDelta1hPct >= 1.2 && change1hPct >= 1.2 && anatomy.normCvd3BarPct >= 6.0);
    // Engine #74B + #77B (Symmetric Short Structure & Anti-Counter-MTF Shield):
    // Forbid SHORT entries inside flat range chop (YATAY MTF + Normal) or against MTF YÜKSELİŞ (EMA20>50) unless TTM Downward Breakout or violent dump confirmation!
    const hasShortStructureOrBreakdown =
      (mtfSqueeze.mtfBearishPts > 0 ||
        mtfSqueeze.squeezeBearishPts > 0 ||
        isGcrCrowdedManiaShort ||
        (oiQuadrant.startsWith('Q3') && oiDelta1hPct >= 2.5 && change1hPct <= -1.80 && anatomy.normCvd3BarPct <= -12.0)) &&
      (mtfSqueeze.mtfBullishPts === 0 ||
        mtfSqueeze.squeezeBearishPts > 0 ||
        (isGcrCrowdedManiaShort && change1hPct <= -0.85 && anatomy.normCvd3BarPct <= -12.0 && rawInstBuySellRatio <= 0.65));

    // Engine #77C + #89B: Wide Hype-Ready ATR Velocity Window [0.48%, 6.50%] (or up to 9.0% on confirmed Hype Rockets):
    // Never starve high-velocity hype rockets (CAPUSDT ATR 4.03%, JCTUSDT ATR 8.48%) or tight coil breakouts (ZECUSDT ATR 0.55%, NEARUSDT ATR 0.63%)!
    const maxAllowedAtrLong = isHypeSqueezeMomentumLong || hasConfirmedHypeOrQ1FlowLong ? 9.0 : 6.0;
    const hasLongMomentumAndVol =
      atr15mPct >= 0.48 &&
      atr15mPct <= maxAllowedAtrLong &&
      (volRatio15m >= 0.68 || isHtfCoilContinuationLong || isHypeSqueezeMomentumLong) &&
      hasCvdAlignmentLong &&
      hasLongStructureOrBreakout &&
      change1hPct >= 0.15 &&
      rsVsBtcAtr >= 0.05;
    const hasShortMomentumAndVol =
      atr15mPct >= 0.48 &&
      atr15mPct <= 6.0 &&
      volRatio15m >= 0.72 &&
      hasCvdAlignmentShort &&
      hasShortStructureOrBreakdown &&
      change1hPct <= -0.15 &&
      rsVsBtcAtr <= -0.05;

    const has5mInstTakerLong =
      takerDataValid &&
      rawInstBuySellRatio >= Math.max(1.18, tuning.minLongTaker5m ?? 1.18) &&
      (takerBuyPct >= 52.0 || rawInstBuySellRatio >= 1.22);
    const has5mInstTakerShort =
      takerDataValid &&
      rawInstBuySellRatio <= curMaxShortTaker5m &&
      (takerBuyPct <= 48.0 || rawInstBuySellRatio <= 0.84);

    // Engine #78C + #90A + #91B + #93A (GPT-6-Luna Strict Anti-Dead-Range Q2 & Neutral-OI Non-Squeeze Quality Floor):
    // 1. Block Q2 (falling OI short-covering) LONG entries when 24h momentum is flat (< 2.80%), MTF is flat with weak CLV (< 0.70),
    //    or there is no TTM Squeeze Breakout (!mtfSqueeze.squeezeBullishPts) and 1h momentum is stale (change1hPct < 0.65 || rsVsBtcAtr < 0.70 — blocks QNTUSDT 1s:+0.39%, RS_BTC:+0.4 ATR, OI:-0.75% 32m chop).
    // 2. Block flat 24h coins (< 2.20%) that lack Q1 new-buyer OI and MTF Bullish trend (like NEARUSDT 24s:+0.089%, Q2 OI↓, YATAY MTF, CLV:0.55 -> -6.75 TL).
    // 3. On NÖTR OI, require either Q1/MTF Bullish confirmation, a formal bullish candlestick pattern (anatomy.bullishPattern),
    //    negative-basis/funding squeeze (basisPct <= -0.025 || fundingRatePct <= -0.010), or high-conviction score >= 86
    //    (Motor #105C: even if TTM expansion is present, never allow NÖTR OI + YATAY MTF + !bullishPattern + positive basis/funding + stretched stop >= 1.70% or prior stop like BRUSDT 78p -> -5.83 TL)!
    const isWeakNeutralOiLongVeto =
      oiQuadrant === 'NÖTR' &&
      !hasFreshDirectNews &&
      !anatomy.bullishPattern &&
      item.basisPct > -0.025 &&
      item.fundingRatePct > -0.010 &&
      rawLongTotal < 86 &&
      (mtfSqueeze.squeezeBullishPts === 0 ||
        (mtfSqueeze.mtfBullishPts === 0 && (symPriorStops >= 1 || longStructDistPct >= 1.70 || rawLongTotal < 82)));
    // Engine #96A + #98A + #101A (GPT-6-Luna Non-Breakout TTM-Coil Lagging-RS Veto & GCR Perp-Bubble Guard):
    // 1. If a coin has NOT broken out of a TTM Squeeze (mtfSqueeze.squeezeBullishPts === 0, i.e. Yay Sıkışması / Normal),
    //    strictly forbid LONG entries when 1h relative strength is lagging (rsVsBtcAtr < 0.58 ATR or change1hPct < 0.65)
    //    unless backed by a true negative-basis short squeeze (isActiveShortSqueezeRegime && basisPct <= -0.05 && clv >= 0.72 && rawLongTotal >= 84),
    //    blocking 100% of our last 4 non-breakout coil losses (QNT #1 RS:+0.40, ARIA RS:+0.44, ENA RS:+0.41, QNT #2 RS:+0.49 in TTM Coil -> -7.71 TL)!
    const isStalledNonSqueezeLongVeto =
      mtfSqueeze.squeezeBullishPts === 0 &&
      !isBnfLiquidationBounce &&
      !hasFreshDirectNews &&
      !(isActiveShortSqueezeRegime && item.basisPct <= -0.05 && anatomy.clv >= 0.72 && rawLongTotal >= 84) &&
      (rsVsBtcAtr < 0.58 ||
        change1hPct < 0.65 ||
        ((change1hPct < 0.75 || rsVsBtcAtr < 0.65) && (whaleRetailSpread <= 0 || !anatomy.bullishPattern || anatomy.clv < 0.68)));
    const isGcrPerpBubbleOrLaggingRsLongVeto =
      !isBnfLiquidationBounce &&
      !hasFreshDirectNews &&
      ((item.basisPct >= 0.18 &&
        (rsVsBtcAtr < 0.90 || whaleRetailSpread < 3.0 || longStructDistPct >= 1.85 || mtfSqueeze.squeezeLabel.includes('Yay Sıkışması'))) ||
        (rsVsBtcAtr < 0.58 &&
          (mtfSqueeze.squeezeBullishPts === 0 || whaleRetailSpread <= 0.5 || longStructDistPct >= 1.95 || (!anatomy.bullishPattern && item.basisPct >= 0))));
    const isPriorStopRangeChopLongVeto =
      symPriorStops >= 1 &&
      ((mtfSqueeze.squeezeBullishPts === 0 &&
        (mtfSqueeze.mtfBullishPts === 0 || (!oiQuadrant.startsWith('Q1') && item.fundingRatePct > -0.015))) ||
        (mtfSqueeze.mtfBullishPts === 0 && !oiQuadrant.startsWith('Q1') && !anatomy.bullishPattern && item.fundingRatePct > -0.015));
    const isQ2WeakBounceLongVeto =
      isWeakNeutralOiLongVeto ||
      isStalledNonSqueezeLongVeto ||
      isGcrPerpBubbleOrLaggingRsLongVeto ||
      isPriorStopRangeChopLongVeto ||
      (!isActiveShortSqueezeRegime &&
        ((oiQuadrant.startsWith('Q2') &&
          (whaleRetailSpread <= -2.0 ||
            item.change24hPct < 2.80 ||
            (mtfSqueeze.squeezeBullishPts === 0 && (change1hPct < 0.65 || rsVsBtcAtr < 0.70)) ||
            (mtfSqueeze.mtfBullishPts === 0 && anatomy.clv < 0.70) ||
            (mtfSqueeze.squeezeLabel.includes('Yay Sıkışması') && item.change24hPct < 5.0))) ||
          (item.change24hPct < 2.20 &&
            !oiQuadrant.startsWith('Q1') &&
            mtfSqueeze.mtfBullishPts === 0 &&
            !hasFreshDirectNews)));

    const canTriggerLong =
      !btcVetoLong &&
      !whaleVetoLong &&
      !fundingVetoLong &&
      !contangoVetoLong &&
      !isQ2WeakBounceLongVeto &&
      !anatomy.vetoLong &&
      !isTakerRatioCrashingLong &&
      !isOverextendedMicroTopLong &&
      !isBasisDumpTrapLong &&
      hasLongMomentumAndVol &&
      vwapLongOk &&
      has5mInstTakerLong &&
      rsVsBtcAtr >= -0.20 &&
      rawLongTotal >= Math.max(84, tuning.minLongScore ?? 84);

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
    const whaleAlignedLong = whaleRetailSpread >= 0 || (isActiveShortSqueezeRegime && volRatio15m >= 1.35);
    const whaleAlignedShort = whaleRetailSpread <= 0;
    const isQ2NonSqueezeLong = oiQuadrant.startsWith('Q2') && mtfSqueeze.squeezeBullishPts === 0;
    const isSymCoolingDown =
      item.symbol !== state.openPosition?.symbol &&
      Number(state.symbolCooldowns?.[item.symbol] || 0) > nowScanMs;
    if (!isSymCoolingDown && canTriggerLong && (!canTriggerShort || rawLongTotal >= rawShortTotal)) {
      side = 'LONG';
      rawScore = rawLongTotal;
      score = Math.min(99, rawLongTotal);
      const rawDynLev = selectConvictionLeverage(score, atr15mPct, longStructDistPct, volRatio15m, whaleAlignedLong);
      const dynLev = isQ2NonSqueezeLong ? Math.min(3, rawDynLev) : rawDynLev;
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
    } else if (!isSymCoolingDown && canTriggerShort) {
      side = 'SHORT';
      rawScore = rawShortTotal;
      score = Math.min(99, rawShortTotal);
      const dynLev = selectConvictionLeverage(score, atr15mPct, shortStructDistPct, volRatio15m, whaleAlignedShort);
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

    const activeStructDistPct = side.startsWith('SHORT') ? shortStructDistPct : longStructDistPct;
    const activeWhaleAligned = side.startsWith('SHORT') ? whaleAlignedShort : whaleAlignedLong;
    const rawConvictionLeverage = selectConvictionLeverage(score, atr15mPct, activeStructDistPct, volRatio15m, activeWhaleAligned);
    const convictionLeverage = !side.startsWith('SHORT') && isQ2NonSqueezeLong ? Math.min(3, rawConvictionLeverage) : rawConvictionLeverage;

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
    btcChange2mPct: btc2mChangePct,
    btcChange15mPct: btc15mChangePct,
    btcChange1hPct: btc1hChangePct,
    avgFundingRatePct: avgFunding,
    minsToNextFunding,
    activeUniverseCount: preCandidates.length,
    regimeLabel: btcVetoLong
      ? `⚠️ BTC SERT DÜŞÜŞ (2dk:${btc2mChangePct}% | 15dk:${btc15mChangePct}%) -> LONG VETO, SADECE GCR SHORT!`
      : btcVetoShort
        ? `🚀 BTC SERT YÜKSELİŞ (2dk:+${btc2mChangePct}% | 15dk:+${btc15mChangePct}%) -> SHORT VETO, SADECE EUGENE LONG!`
        : `20 KATMANLI YIRTICI KONSEY v10.6 (${preCandidates.length} Likit Kontrat | 3x-5x Anti-İğne + İnsan-Üstü Limit/1dk Refleks Kalkanı)`,
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
  const posId = pos.id;

  const book = await fetchJson(`${FAPI_BASE}/fapi/v1/ticker/bookTicker?symbol=${pos.fSym}`, {}, 2500);
  if (!book || state.openPosition?.id !== posId || pos.isClosing) return;
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
  // Engine #101B: Track if a position already popped >= +0.52% and then rejected below entry (<= -0.15%) so any subsequent second-chance lower-high bounce (>= +0.28%) locks fee-plus profit!
  if (peakCoinMoveFrac >= 0.0052 && rawCoinMoveFrac <= -0.0015) {
    pos.dippedBelowEntryAfterPop = true;
  }

  // Engine #79A (GPT-6-Luna Strict One-Way Stop Invariant — No Post-Entry Stop Widening):
  // tryOpenPosition already sets the full untruncated structural stop at entry. Once a position is open,
  // pos.stopPrice may ONLY tighten in the favorable direction (ratchet up on LONG / ratchet down on SHORT) and NEVER widen away from entry!

  const effectiveFeeSlipFrac =
    Number.isFinite(pos.feeSlipFrac) && pos.feeSlipFrac >= 0
      ? pos.feeSlipFrac
      : ROUND_TRIP_FEE_SLIP_FRAC;
  const netCoinMoveFrac = rawCoinMoveFrac - effectiveFeeSlipFrac;
  const netPnlUsdt = Number((pos.notionalUsdt * netCoinMoveFrac).toFixed(4));
  const netPnlTry = toTL(netPnlUsdt);
  const roePct = Number(((netPnlUsdt / pos.marginUsdt) * 100).toFixed(2));
  const underlyingMovePct = Number((rawCoinMoveFrac * 100).toFixed(2));

  pos.unrealizedPnlUsdt = netPnlUsdt;
  pos.unrealizedPnlTry = netPnlTry;
  pos.roePct = roePct;
  pos.underlyingMovePct = underlyingMovePct;
  const posLev = pos.leverage || LEVERAGE;

  // Engine #64C + #100B (Human Orderbook Wall Front-Run & Near-TP1 Pullback Partial Harvest — Closing the [1.02%, 1.25%) Spread Dead Zone):
  // 1. If price reaches >= +1.02% (>82% of TP1 +1.25%) and either encounters an opposing orderbook wall (|liveOb| >= 0.24) or 5m Taker weakens,
  //    OR if peakCoinMoveFrac already reached >= +1.10% (so lastPrice touched ~+1.18%..+1.25% TP1, like TAUSDT at $0.05918) and pulls back >= 0.12% while still >= +0.88%,
  //    harvest the 35% TP1 partial immediately instead of letting a 1-tick spread miss round-trip without TP1!
  let isWallFrontRunTp1 = false;
  if (!pos.tp1Done && !pos.externallyClosedOnExchange && rawCoinMoveFrac >= 0.0088 && rawCoinMoveFrac < 0.0125) {
    const frontRunCand =
      candidates.find(c => c.symbol === pos.symbol) ||
      (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
    const isPullbackFromNearTp1Touch = Boolean(
      peakCoinMoveFrac >= 0.0110 && rawCoinMoveFrac <= peakCoinMoveFrac - 0.0012
    );
    const takerWeakNearTp1 = Boolean(
      rawCoinMoveFrac >= 0.0102 &&
        frontRunCand?.takerDataValid &&
        (pos.side === 'LONG' ? frontRunCand.instBuySellRatio <= 0.90 : frontRunCand.instBuySellRatio >= 1.12)
    );
    if (isPullbackFromNearTp1Touch || takerWeakNearTp1) {
      isWallFrontRunTp1 = true;
    } else if (rawCoinMoveFrac >= 0.0102) {
      const tp1Depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 1800);
      if (state.openPosition?.id !== posId || pos.isClosing) return;
      if (tp1Depth?.bids?.length && tp1Depth?.asks?.length) {
        const tp1Ob = computeWeightedBookImbalance(tp1Depth.bids, tp1Depth.asks);
        if ((pos.side === 'LONG' && tp1Ob <= -0.24) || (pos.side === 'SHORT' && tp1Ob >= 0.24)) {
          isWallFrontRunTp1 = true;
        }
      }
    }
  }

  // Stage 2 (v8.4 Asymmetric Runner + Zero-Choke + MIN_NOTIONAL Full-Lock Guard + Engine #64C Wall Front-Run + Engine #72/#73B Live Fill Parity):
  // On Binance USD-M Futures, reduceOnly partial closes are exempt from the $5.00 MIN_NOTIONAL filter;
  // only require liveHarvestQty > 0 (>= minQty) and remaining 65% runner >= $5.00 MIN_NOTIONAL in both SIM and LIVE!
  if (!pos.tp1Done && !pos.externallyClosedOnExchange && (rawCoinMoveFrac >= 0.0125 || isWallFrontRunTp1)) {
    const prevExecQty = Number(pos.executedQty || roundQtyToStep(pos.fSym, pos.notionalUsdt / pos.entryPrice) || 0);
    const liveHarvestQty = roundQtyToStep(pos.fSym, prevExecQty * 0.35);
    const liveRemainQty = roundQtyToStep(pos.fSym, Math.max(0, prevExecQty - liveHarvestQty));
    const canSplitLiveQty =
      liveHarvestQty > 0 &&
      liveRemainQty > 0 &&
      liveRemainQty * markExitPrice >= MIN_NOTIONAL_USDT;
    if (pos.notionalUsdt * 0.65 < MIN_NOTIONAL_USDT || !canSplitLiveQty) {
      pos.tp1Done = true;
      pos.ratchetStage = 'TP1_FULL_STOP_LOCK_MIN_NOTIONAL';
      if (pos.side === 'LONG') {
        const lockFull = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0055), 'floor');
        if (lockFull > pos.stopPrice) pos.stopPrice = lockFull;
      } else {
        const lockFull = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0055), 'ceil');
        if (lockFull < pos.stopPrice) pos.stopPrice = lockFull;
      }
      logEvent(
        state,
        `🔒 [TP1 %100 TAM GÖVDE KÂR KİLİDİ (MIN_NOTIONAL KORUMASI)] ${pos.symbol}USDT (${posLev}x ${pos.side}) +%${underlyingMovePct} yürüyüşte ${pos.marginTry} TL (${pos.notionalTry} TL Hacim) bölünmeden %100 Ana Gövde Stopu +%0.55 Net Kâra Kilitlendi!`
      );
    } else {
      let tp1Confirmed = true;
      let harvestFrac = 0.35;
      let tp1ExitPrice = markExitPrice;
      if (pos.isLiveFapiOrder) {
        const tp1Exec = await executeFapiRealExit(pos, 0.35);
        if (state.openPosition?.id !== posId || pos.isClosing) return;
        if (!tp1Exec.ok || !tp1Exec.filledQty || tp1Exec.alreadyClosedOnExchange) {
          tp1Confirmed = false;
        } else {
          harvestFrac = prevExecQty > 0 ? Math.min(0.95, Math.max(0.05, tp1Exec.filledQty / prevExecQty)) : 0.35;
          if (tp1Exec.avgExitPrice && tp1Exec.avgExitPrice > 0) {
            tp1ExitPrice = tp1Exec.avgExitPrice;
          }
        }
      }
      if (tp1Confirmed) {
        const tp1RawMoveFrac =
          pos.side === 'LONG'
            ? (tp1ExitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - tp1ExitPrice) / pos.entryPrice;
        const tp1NetMoveFrac = tp1RawMoveFrac - effectiveFeeSlipFrac;
        const closedMarginUsdt = Number((pos.marginUsdt * harvestFrac).toFixed(4));
        const closedNotionalUsdt = Number((pos.notionalUsdt * harvestFrac).toFixed(4));
        const partialNetPnlUsdt = Number((closedNotionalUsdt * tp1NetMoveFrac).toFixed(4));
        const partialNetPnlTry = toTL(partialNetPnlUsdt);
        const partialRoePct = Number(((partialNetPnlUsdt / Math.max(0.0001, closedMarginUsdt)) * 100).toFixed(2));

        state.marginCashUsdt = Number((state.marginCashUsdt + closedMarginUsdt + partialNetPnlUsdt).toFixed(4));
        state.realizedPnlUsdt = Number((state.realizedPnlUsdt + partialNetPnlUsdt).toFixed(4));

        pos.marginUsdt = Number((pos.marginUsdt - closedMarginUsdt).toFixed(4));
        pos.notionalUsdt = Number((pos.notionalUsdt - closedNotionalUsdt).toFixed(4));
        pos.marginTry = toTL(pos.marginUsdt);
        pos.notionalTry = toTL(pos.notionalUsdt);
        pos.realizedPartialUsdt = Number(((pos.realizedPartialUsdt || 0) + partialNetPnlUsdt).toFixed(4));
        pos.tp1Done = true;
        pos.ratchetStage = 'TP1_HARVESTED_RUNNER';

        const tp1CandNow =
          candidates.find(c => c.symbol === pos.symbol) ||
          (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
        const tp1HeldMins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
        const isBoomingRunnerFlow = Boolean(
          tp1HeldMins < 12 &&
            tp1CandNow &&
            tp1CandNow.takerDataValid &&
            (pos.side === 'LONG'
              ? tp1CandNow.instBuySellRatio >= 1.12 && Number(tp1CandNow.whaleRetailSpread || 0) >= 0 && !tp1CandNow.vetoLong
              : tp1CandNow.instBuySellRatio <= 0.89 && Number(tp1CandNow.whaleRetailSpread || 0) <= 0 && !tp1CandNow.vetoShort)
        );
        const tp1RunnerLockFrac = isBoomingRunnerFlow ? 0.0012 : 0.0035;
        if (pos.side === 'LONG') {
          const lockTp1 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + tp1RunnerLockFrac), 'floor');
          if (lockTp1 > pos.stopPrice) pos.stopPrice = lockTp1;
        } else {
          const lockTp1 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - tp1RunnerLockFrac), 'ceil');
          if (lockTp1 < pos.stopPrice) pos.stopPrice = lockTp1;
        }

        logEvent(
          state,
          `💰 [TP1 %35 KÂR CEBELLEZİ] ${pos.symbol}USDT (${posLev}x ${pos.side}) +%${underlyingMovePct} yürüyüşte %${Math.round(harvestFrac * 100)} nakde çevrildi (+${partialNetPnlTry} TL cebe indi!) | Kalan Ana Gövde Runner Stopu +%${(tp1RunnerLockFrac * 100).toFixed(2)} Kâra Kilitlendi!`
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
          exitPrice: tp1ExitPrice,
          thesis: pos.thesis,
        });
        if (state.openPosition?.id !== posId || pos.isClosing) return;
      }
    }
  }

  // Stage 1 / Stage 3 (v8.4 Wide-Breathing Ratchet + Bug #42 Capped TP Extensions + GPT-6-Luna TickSize Quantization):
  if (peakCoinMoveFrac >= 0.0195) {
    pos.ratchetStage = 'PARABOLIC_SQUEEZE_RUNNER';
    if (pos.side === 'LONG') {
      const trailStop = roundPriceToTick(pos.fSym, pos.extremePrice * (1 - 0.0055), 'floor');
      if (trailStop > pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice >= pos.tpPrice * 0.997 && (pos.tpExtensionCount || 0) < 3) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        if (state.openPosition?.id !== posId || pos.isClosing) return;
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb >= 0.12) {
          pos.tpPrice = roundPriceToTick(pos.fSym, markExitPrice * 1.015, 'ceil');
          pos.tpExtensionCount = (pos.tpExtensionCount || 0) + 1;
        }
      }
    } else {
      const trailStop = roundPriceToTick(pos.fSym, pos.extremePrice * (1 + 0.0055), 'ceil');
      if (trailStop < pos.stopPrice) pos.stopPrice = trailStop;
      if (markExitPrice <= pos.tpPrice * 1.003 && (pos.tpExtensionCount || 0) < 3) {
        const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
        if (state.openPosition?.id !== posId || pos.isClosing) return;
        const liveOb = depth?.bids?.length && depth?.asks?.length ? computeWeightedBookImbalance(depth.bids, depth.asks) : 0;
        if (liveOb <= -0.12) {
          pos.tpPrice = roundPriceToTick(pos.fSym, markExitPrice * 0.985, 'floor');
          pos.tpExtensionCount = (pos.tpExtensionCount || 0) + 1;
        }
      }
    }
  } else if (peakCoinMoveFrac >= 0.0155) {
    if (!pos.ratchetStage.includes('TP1')) pos.ratchetStage = 'PROFIT_LOCK_2';
    if (pos.side === 'LONG') {
      const lock2 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0075), 'floor');
      if (lock2 > pos.stopPrice) pos.stopPrice = lock2;
    } else {
      const lock2 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0075), 'ceil');
      if (lock2 < pos.stopPrice) pos.stopPrice = lock2;
    }
  } else if (pos.tp1Done && peakCoinMoveFrac >= 0.0130) {
    // Engine #81A: Intermediate runner ratchet step at +1.30% peak after TP1 harvest -> lock +0.52% on remaining 65% runner!
    if (pos.side === 'LONG') {
      const lockRunner1 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0052), 'floor');
      if (lockRunner1 > pos.stopPrice && lockRunner1 < markExitPrice) pos.stopPrice = lockRunner1;
    } else {
      const lockRunner1 = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0052), 'ceil');
      if (lockRunner1 < pos.stopPrice && lockRunner1 > markExitPrice) pos.stopPrice = lockRunner1;
    }
  } else if (peakCoinMoveFrac >= 0.0108 && rawCoinMoveFrac >= 0.0052) { // Engine #106B: Only lock pre-TP1 profit floor once coin reaches +1.08% (near TP1 +1.25%), never choke at +0.46 TL!
    // Engine #44B + #76B + #81A + #94A + #99A + #100C (GPT-6-Luna Anti-RoundTrip 0.82% MFE Fee-Plus Lock & Zero-Dead-Zone Breathing Guard):
    // Once a leveraged trade reaches >= +0.82% underlying move (+2.46% to +3.28% ROE at 3x-4x), lock +0.34% net fee-plus stop
    // UNLESS the position is < 10m old (< 12m if tp1Done), peak < +1.30%, and institutional flow is still actively expanding
    // (5m Taker >= 1.12x LONG / <= 0.89x SHORT, Whale Spread >= 0 LONG / <= 0 SHORT, no candle veto, no 2m BTC shock),
    // preventing healthy breakouts like NILUSDT and TAUSDT ($0.05992 -> $0.05918 -> $0.05988 retest -> $0.05770 -3.70% crash) from being choked on an entry retest!
    const beLockCand =
      candidates.find(c => c.symbol === pos.symbol) ||
      (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
    const beHeldMins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
    const btc2mBe = Number(state.marketSummary?.btcChange2mPct || 0);
    const isHealthyPreTp1Expansion = Boolean(
      beHeldMins < (pos.tp1Done ? 12 : 10) &&
        peakCoinMoveFrac < 0.0130 &&
        beLockCand &&
        beLockCand.takerDataValid &&
        (pos.side === 'LONG'
          ? beLockCand.instBuySellRatio >= 1.12 &&
            Number(beLockCand.whaleRetailSpread || 0) >= 0 &&
            !beLockCand.vetoLong &&
            btc2mBe > -0.20
          : beLockCand.instBuySellRatio <= 0.89 &&
            Number(beLockCand.whaleRetailSpread || 0) <= 0 &&
            !beLockCand.vetoShort &&
            btc2mBe < 0.20)
    );
    if (!isHealthyPreTp1Expansion) {
      if (pos.side === 'LONG') {
        const bePlus = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0034), 'floor');
        if (bePlus > pos.stopPrice && bePlus < markExitPrice) {
          pos.stopPrice = bePlus;
          if (!pos.ratchetStage.includes('TP1')) pos.ratchetStage = 'FAST_BREAKEVEN_PLUS';
        }
      } else {
        const bePlus = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0034), 'ceil');
        if (bePlus < pos.stopPrice && bePlus > markExitPrice) {
          pos.stopPrice = bePlus;
          if (!pos.ratchetStage.includes('TP1')) pos.ratchetStage = 'FAST_BREAKEVEN_PLUS';
        }
      }
    }
  } else if (peakCoinMoveFrac >= 0.0098 && rawCoinMoveFrac >= 0.0048 && !pos.tp1Done) { // Engine #106B: Prevent +0.34% EARLY_PROFIT_LOCK from choking normal <1.0% breathers
    // Engine #60A + #76B + #78B + #87D + #94B + #99A (GPT-6-Luna Pre-TP1 Zero-Choke & Orderflow-Confirmed Pullback Lock):
    // 1. Require rawCoinMoveFrac >= 0.0036 so the +0.34% stop is ALWAYS strictly below markExitPrice (LONG) / above markExitPrice (SHORT) on real Binance Futures!
    // 2. Motor #99A: Never lock +0.34% unconditionally at minute 1-3 when Taker >= 1.05x & Whale >= 0! Require peak >= +0.75%, pullback <= +0.50%, AND either held >= 8m or orderflow/whale/candle weakening.
    const earlyLockCand =
      candidates.find(c => c.symbol === pos.symbol) ||
      (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
    const earlyHeldMins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
    const isSevereEarlyTakerCrash = Boolean(
      earlyHeldMins >= 3.0 &&
        earlyLockCand &&
        earlyLockCand.takerDataValid &&
        (pos.side === 'LONG' ? earlyLockCand.instBuySellRatio <= 0.82 : earlyLockCand.instBuySellRatio >= 1.22)
    );
    const isEarlyTakerDecaying = Boolean(
      earlyHeldMins >= 8 &&
        earlyLockCand &&
        (pos.side === 'LONG'
          ? earlyLockCand.instBuySellRatio < 0.96 || earlyLockCand.whaleRetailSpread <= -3.5
          : earlyLockCand.instBuySellRatio > 1.04 || earlyLockCand.whaleRetailSpread >= 3.5)
    );
    const isDeepPullbackFromNearTp1 = Boolean(
      peakCoinMoveFrac >= 0.0075 &&
        rawCoinMoveFrac <= 0.0050 &&
        (earlyHeldMins >= 8 ||
          !earlyLockCand ||
          (pos.side === 'LONG'
            ? earlyLockCand.instBuySellRatio < 1.05 || earlyLockCand.whaleRetailSpread < 0 || earlyLockCand.vetoLong
            : earlyLockCand.instBuySellRatio > 0.95 || earlyLockCand.whaleRetailSpread > 0 || earlyLockCand.vetoShort))
    );
    if (isSevereEarlyTakerCrash || isEarlyTakerDecaying || isDeepPullbackFromNearTp1) {
      if (pos.side === 'LONG') {
        const earlyLock = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0034), 'floor');
        if (earlyLock > pos.stopPrice && earlyLock < markExitPrice) {
          pos.stopPrice = earlyLock;
          pos.ratchetStage = 'EARLY_PROFIT_LOCK';
        }
      } else {
        const earlyLock = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0034), 'ceil');
        if (earlyLock < pos.stopPrice && earlyLock > markExitPrice) {
          pos.stopPrice = earlyLock;
          pos.ratchetStage = 'EARLY_PROFIT_LOCK';
        }
      }
    }
  } else if (peakCoinMoveFrac >= 0.0092 && rawCoinMoveFrac >= 0.0042 && !pos.tp1Done) { // Engine #106B: Prevent +0.26% MICRO_POP_FEE_LOCK (+0.46 TL) from choking winning trades before TP1
    // Engine #63A + #78B + #87D (GPT-6-Luna Pre-TP1 MFE Expectancy Guard & Micro-Pop Fee-Plus Lock):
    // 1. Require rawCoinMoveFrac >= 0.0028 so the +0.26% stop is strictly on the valid side of current markExitPrice!
    // 2. Regular weakening path requires peak >= +0.42%, microHeldMins >= 8, AND 5m taker <= 0.86x LONG / >= 1.16x SHORT so normal breathers are never choked before TP1 (+1.25%)!
    // 3. Emergency fast path triggers on 2m BTC shock (<= -0.28% LONG / >= +0.28% SHORT) or severe fast taker crash (microHeldMins >= 3.5 && taker <= 0.76x LONG / >= 1.28x SHORT).
    const microLockCand =
      candidates.find(c => c.symbol === pos.symbol) ||
      (state.openPositionLiveCand?.symbol === pos.symbol ? state.openPositionLiveCand : null);
    const microHeldMins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
    const isFastMicroTakerCrash = Boolean(
      microHeldMins >= 3.5 &&
        microLockCand &&
        microLockCand.takerDataValid &&
        (pos.side === 'LONG' ? microLockCand.instBuySellRatio <= 0.76 : microLockCand.instBuySellRatio >= 1.28)
    );
    const isMicroTakerWeakening = Boolean(
      peakCoinMoveFrac >= 0.0042 &&
        microHeldMins >= 8 &&
        microLockCand &&
        microLockCand.takerDataValid &&
        (pos.side === 'LONG' ? microLockCand.instBuySellRatio <= 0.86 : microLockCand.instBuySellRatio >= 1.16)
    );
    const btc2mNow = Number(state.marketSummary?.btcChange2mPct || 0);
    const isBtc2mShockAgainst = pos.side === 'LONG' ? btc2mNow <= -0.28 : btc2mNow >= 0.28;
    // Engine #101B (Second-Chance Lower-High Bounce Lock):
    // If the trade already spiked >= +0.52%, rejected below entry (<= -0.15%), and then bounced back to >= +0.28% (like QNTUSDT bouncing to $191.06 +0.315% at minute 9 after dipping to $190.10),
    // lock the +0.26% fee-plus stop immediately on the lower-high bounce before the real breakdown hits!
    const isSecondChanceBounceAfterDip = Boolean(
      pos.dippedBelowEntryAfterPop && peakCoinMoveFrac >= 0.0052 && rawCoinMoveFrac >= 0.0028
    );
    if (isFastMicroTakerCrash || isMicroTakerWeakening || isBtc2mShockAgainst || isSecondChanceBounceAfterDip) {
      if (pos.side === 'LONG') {
        const microLock = roundPriceToTick(pos.fSym, pos.entryPrice * (1 + 0.0026), 'floor');
        if (microLock > pos.stopPrice && microLock < markExitPrice) {
          pos.stopPrice = microLock;
          pos.ratchetStage = isBtc2mShockAgainst
            ? 'BTC_SHOCK_PROFIT_LOCK'
            : isSecondChanceBounceAfterDip
              ? 'SECOND_CHANCE_BOUNCE_LOCK'
              : 'MICRO_POP_FEE_LOCK';
        }
      } else {
        const microLock = roundPriceToTick(pos.fSym, pos.entryPrice * (1 - 0.0026), 'ceil');
        if (microLock < pos.stopPrice && microLock > markExitPrice) {
          pos.stopPrice = microLock;
          pos.ratchetStage = isBtc2mShockAgainst
            ? 'BTC_SHOCK_PROFIT_LOCK'
            : isSecondChanceBounceAfterDip
              ? 'SECOND_CHANCE_BOUNCE_LOCK'
              : 'MICRO_POP_FEE_LOCK';
        }
      }
    }
  }

  let hwStopImmediateTrigger = false;
  if (pos.isLiveFapiOrder && !pos.externallyClosedOnExchange && (!pos.hwStopOrderId || pos.stopPrice !== pos.lastSyncedHwStopPrice)) {
    const hwSync = await syncFapiHardwareStop(pos, markExitPrice);
    if (state.openPosition?.id !== posId || pos.isClosing) return;
    if (hwSync && hwSync.immediateTrigger) {
      hwStopImmediateTrigger = true;
    }
  }

  const isTpHit =
    pos.side === 'LONG' ? markExitPrice >= pos.tpPrice : markExitPrice <= pos.tpPrice;
  const isStopHit =
    Boolean(pos.externallyClosedOnExchange) ||
    hwStopImmediateTrigger ||
    (pos.side === 'LONG' ? markExitPrice <= pos.stopPrice : markExitPrice >= pos.stopPrice);

  const minsHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
  const isTimeStop = minsHeld >= 90 && rawCoinMoveFrac < 0.0035;

  let isOrderflowScratch = false;
  let isFishingEmergencyExit = false;
  let isProfitTakerCollapseHarvest = false;
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
      pos.side === 'LONG' && liveFundPct <= -0.18 && !pos.tp1Done && rawCoinMoveFrac < 0.0125;
    if (
      posMinsToFund <= 5 &&
      rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC + 0.0012 &&
      (isPayingHeavyFunding || isExtremeNegFundFarmerDumpRisk)
    ) {
      isFundingSettlementHarvest = true;
    }
  }
  // Engine #63A + #83B (GPT-6-Luna Anti-Choke Profit-Zone Taker-Collapse Harvest):
  // Since MICRO_POP_FEE_LOCK (+0.26%) and EARLY_PROFIT_LOCK (+0.34%) already place a hard profit-lock stop below price,
  // NEVER market-sell a rising breakout near its peak or while live 15m orderflow is healthy (like AVAUSDT at $0.4428 right before surging to $0.4525, +2.49%)!
  // Only market-exit in the +0.26%..+0.95% zone if:
  // 1) peakCoinMoveFrac >= 0.0055 and price has actively pulled back >= 0.18% from peak,
  // 2) rolling 5m Taker has genuinely collapsed (<= 0.68x LONG / >= 1.45x SHORT), AND
  // 3) live 15m candle confirms orderflow weakness (veto or takerBuyPct <= 48% LONG / >= 52% SHORT).
  if (
    !isTpHit &&
    !isStopHit &&
    !pos.tp1Done &&
    minsHeld >= 12 &&
    peakCoinMoveFrac >= 0.0105 &&
    rawCoinMoveFrac <= peakCoinMoveFrac - 0.0025 &&
    rawCoinMoveFrac >= ROUND_TRIP_FEE_SLIP_FRAC + 0.0008 &&
    rawCoinMoveFrac < 0.0095 &&
    curPosLiveCand &&
    curPosLiveCand.takerDataValid
  ) {
    const isLongProfitCollapseConfirmed =
      pos.side === 'LONG' &&
      curPosLiveCand.instBuySellRatio <= 0.68 &&
      (curPosLiveCand.vetoLong || curPosLiveCand.takerBuyPct <= 48.0);
    const isShortProfitCollapseConfirmed =
      pos.side === 'SHORT' &&
      curPosLiveCand.instBuySellRatio >= 1.45 &&
      (curPosLiveCand.vetoShort || curPosLiveCand.takerBuyPct >= 52.0);
    if (isLongProfitCollapseConfirmed || isShortProfitCollapseConfirmed) {
      isProfitTakerCollapseHarvest = true;
    }
  }
  // Engine #77D + #88B: Allow early (>= 5m) emergency fishing exit if 5m Taker suffers a catastrophic institutional collapse (<= 0.45x LONG / >= 2.10x SHORT) with candle veto,
  // OR at >= 8m when caught in a BSL/SSL Liquidity Sweep / Candle Rejection with heavy Whale opposition (<= -8.0% LONG / >= +8.0% SHORT) and sub-1.0x 5m Taker (like MTLUSDT at $0.2847 -> $0.2833)!
  const isWhaleSweepRejectionTrap = Boolean(
    !isTpHit &&
      !isStopHit &&
      !pos.tp1Done &&
      minsHeld >= 8 &&
      rawCoinMoveFrac <= -0.0020 &&
      rawCoinMoveFrac >= -0.0090 &&
      mfeR < 0.25 &&
      curPosLiveCand &&
      curPosLiveCand.takerDataValid &&
      ((pos.side === 'LONG' &&
        curPosLiveCand.vetoLong &&
        curPosLiveCand.whaleRetailSpread <= -8.0 &&
        curPosLiveCand.instBuySellRatio <= 0.92) ||
        (pos.side === 'SHORT' &&
          curPosLiveCand.vetoShort &&
          curPosLiveCand.whaleRetailSpread >= 8.0 &&
          curPosLiveCand.instBuySellRatio >= 1.08))
  );
  const isCatastrophicEarlyTakerCrash = Boolean(
    !isTpHit &&
      !isStopHit &&
      minsHeld >= 5 &&
      rawCoinMoveFrac <= -0.0015 &&
      rawCoinMoveFrac >= -0.0185 &&
      curPosLiveCand &&
      curPosLiveCand.takerDataValid &&
      ((pos.side === 'LONG' && curPosLiveCand.instBuySellRatio <= 0.45 && curPosLiveCand.takerBuyPct <= 42.0 && curPosLiveCand.vetoLong) ||
        (pos.side === 'SHORT' && curPosLiveCand.instBuySellRatio >= 2.10 && curPosLiveCand.takerBuyPct >= 58.0 && curPosLiveCand.vetoShort))
  );
  // Engine #96D (GPT-6-Luna Dead-on-Arrival >=3.5m Instant-Dump Orderbook Rescue):
  // If a trade has been open >= 3.5m with zero follow-through from entry (peakCoinMoveFrac < 0.18%, mfeR < 0.15)
  // and has already dumped <= -0.68% (aeR >= 0.52) while whales/candle/taker oppose (like CTUSDT at $0.17126 -> $0.16899),
  // check live futures orderbook depth and evacuate at ~-7 TL before hitting the full -14 TL stop!
  let isDeadOnArrivalInstantDump = false;
  if (
    !isTpHit &&
    !isStopHit &&
    !pos.tp1Done &&
    minsHeld >= 3.5 &&
    peakCoinMoveFrac < 0.0018 &&
    mfeR < 0.15 &&
    rawCoinMoveFrac <= -0.0068 &&
    aeR >= 0.52 &&
    curPosLiveCand &&
    ((pos.side === 'LONG' &&
      (curPosLiveCand.vetoLong || curPosLiveCand.whaleRetailSpread < 0 || curPosLiveCand.instBuySellRatio <= 0.95)) ||
      (pos.side === 'SHORT' &&
        (curPosLiveCand.vetoShort || curPosLiveCand.whaleRetailSpread > 0 || curPosLiveCand.instBuySellRatio >= 1.05)))
  ) {
    const doaDepth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
    if (state.openPosition?.id !== posId || pos.isClosing) return;
    if (doaDepth?.bids?.length && doaDepth?.asks?.length) {
      const doaOb = computeWeightedBookImbalance(doaDepth.bids, doaDepth.asks);
      if ((pos.side === 'LONG' && doaOb <= -0.12) || (pos.side === 'SHORT' && doaOb >= 0.12)) {
        isDeadOnArrivalInstantDump = true;
      }
    }
  }
  // Engine #104C (GPT-6-Luna 8m Early Candle-Veto + Taker-Decay Rescue):
  // If a trade has been open >= 8m with negligible MFE (mfeR < 0.16) and is already down <= -0.65% (aeR >= 0.45)
  // while the live 15m candle flips to vetoLong/vetoShort AND 5m Taker drops <= 0.88x LONG / >= 1.15x SHORT (like NILUSDT at 09:20 after the 06:00 bar closed with a 48% upper rejection wick),
  // evacuate immediately instead of waiting for the full -1.87% stop!
  const isEarlyFishingCandleTrap = Boolean(
    !isTpHit &&
      !isStopHit &&
      !pos.tp1Done &&
      minsHeld >= 8 &&
      mfeR < 0.16 &&
      aeR >= 0.45 &&
      rawCoinMoveFrac <= -0.0065 &&
      curPosLiveCand &&
      ((pos.side === 'LONG' &&
        ((curPosLiveCand.candlePattern && curPosLiveCand.candlePattern.includes('Yemleme/Fishing')) ||
          (curPosLiveCand.vetoLong && curPosLiveCand.instBuySellRatio <= 0.88))) ||
        (pos.side === 'SHORT' && curPosLiveCand.vetoShort && curPosLiveCand.instBuySellRatio >= 1.15))
  );
  // Engine #98C (GPT-6-Luna >=6m Active Q3 / Bearish-Breakout Reversal Rescue):
  // If a trade has been open >= 6m with weak MFE (mfeR < 0.30) and is already down <= -0.72% (aeR >= 0.48)
  // while live structure flips to candle veto + 5m Taker collapse (<= 0.84x LONG / >= 1.18x SHORT) + Q3/Down-Breakout/Whale-Flip (like ARIAUSDT flipping to Bearish Engulfing + Q3 + TTM Down + 0.72x Taker),
  // evacuate immediately before hitting the full -2.20% (-12.40 TL) stop!
  const isActiveStructureBreakdownExit = Boolean(
    !isTpHit &&
      !isStopHit &&
      !pos.tp1Done &&
      minsHeld >= 6 &&
      mfeR < 0.30 &&
      aeR >= 0.48 &&
      rawCoinMoveFrac <= -0.0072 &&
      curPosLiveCand &&
      ((pos.side === 'LONG' &&
        curPosLiveCand.vetoLong &&
        curPosLiveCand.instBuySellRatio <= 0.84 &&
        (String(curPosLiveCand.oiQuadrant || '').startsWith('Q3') ||
          String(curPosLiveCand.squeezeLabel || '').includes('AŞAĞI') ||
          curPosLiveCand.whaleRetailSpread <= 0)) ||
        (pos.side === 'SHORT' &&
          curPosLiveCand.vetoShort &&
          curPosLiveCand.instBuySellRatio >= 1.18 &&
          (String(curPosLiveCand.oiQuadrant || '').startsWith('Q1') ||
            String(curPosLiveCand.squeezeLabel || '').includes('YUKARI') ||
            curPosLiveCand.whaleRetailSpread >= 0)))
  );
  // Engine #106C (Anti-Self-Mutilation Scratch Guard): Forbid panic market-dumping at minute 5-15 on noisy 5m taker dips (like BR -5.83 TL & NIL -9.61 TL);
  // Only allow emergency fishing exit when minsHeld >= 18, mfeR < 0.12, aeR >= 0.72, and catastrophic 5m taker + whale + candle collapse all confirm simultaneously!
  if (
    !isTpHit &&
    !isStopHit &&
    !pos.tp1Done &&
    minsHeld >= 18 &&
    mfeR < 0.12 &&
    aeR >= 0.72 &&
    isCatastrophicEarlyTakerCrash &&
    curPosLiveCand &&
    ((pos.side === 'LONG' && curPosLiveCand.whaleRetailSpread <= -6.0 && curPosLiveCand.instBuySellRatio <= 0.45) ||
      (pos.side === 'SHORT' && curPosLiveCand.whaleRetailSpread >= 6.0 && curPosLiveCand.instBuySellRatio >= 2.15))
  ) {
    isFishingEmergencyExit = true;
  }
  // Engine #56 + #94D (GPT-6-Luna Completed-Bar Wick-Rejection & Failed-Breakout Round-Trip Scratch):
  // Never cut during the first 15m bar consolidation (FUSDT paused at 9m before ripping +14.71 TL / +5.33% ROE!);
  // Scratch at >= 15m if either:
  // 1) Stalled from start (mfeR < 0.22, aeR >= 0.35) with completed candle veto and 5m Taker <= 0.84x LONG / >= 1.18x SHORT, OR
  // 2) Failed-Breakout Round-Trip (peakCoinMoveFrac >= 0.0065 that dumped >= 0.95% from peak into rawCoinMoveFrac <= -0.0030 with INITIAL_STOP) + completed bearish rejection candle (like TUSDT +0.94% -> -1.43% Shooting Star CLV:0.15 & Taker <= 1.00x)!
  const isFailedBreakoutRoundTrip =
    pos.ratchetStage === 'INITIAL_STOP' &&
    peakCoinMoveFrac >= 0.0065 &&
    rawCoinMoveFrac <= -0.0030;
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && !pos.tp1Done && minsHeld >= 15 && aeR >= 0.35 && (mfeR < 0.22 || isFailedBreakoutRoundTrip) && curPosLiveCand) {
    const isLongWickCollapse =
      pos.side === 'LONG' &&
      curPosLiveCand.vetoLong &&
      (isFailedBreakoutRoundTrip
        ? curPosLiveCand.instBuySellRatio <= 1.02 || curPosLiveCand.whaleRetailSpread <= 0
        : curPosLiveCand.instBuySellRatio <= 0.84 && curPosLiveCand.takerBuyPct <= 46.0);
    const isShortWickCollapse =
      pos.side === 'SHORT' &&
      curPosLiveCand.vetoShort &&
      (isFailedBreakoutRoundTrip
        ? curPosLiveCand.instBuySellRatio >= 0.98 || curPosLiveCand.whaleRetailSpread >= 0
        : curPosLiveCand.instBuySellRatio >= 1.18 && curPosLiveCand.takerBuyPct >= 54.0);
    if (isLongWickCollapse || isShortWickCollapse) {
      isWickTakerCollapseScratch = true;
    }
  }
  // Engine #49 + #62 + #75A + #102B (GPT-6-Luna 32-Minute R-Normalized MFE/MAE & Giveback Stale-Trade Scratch — Never Cut Recovering Trades Near Entry):
  // 1. Require rawCoinMoveFrac <= -0.0032 and currentAdverseR >= 0.20 so a position that already recovered 70% of an early dip and is sitting within -0.26% (0.12R) of entry
  //    (like POLYXUSDT at $0.03466 vs $0.03475 right before rallying to $0.03499 +0.69%) is NEVER fee-scratched because of a stale minute-1 aeR!
  const currentAdverseR = currentAdverseFrac / initRiskFrac;
  if (
    !isTpHit &&
    !isStopHit &&
    !isFishingEmergencyExit &&
    !isWickTakerCollapseScratch &&
    !pos.tp1Done &&
    rawCoinMoveFrac <= -0.0032 &&
    currentAdverseR >= 0.20
  ) {
    const whaleOrTakerFlippedAgainst = Boolean(
      curPosLiveCand &&
        ((pos.side === 'SHORT' &&
          (curPosLiveCand.whaleRetailSpread >= 3.0 ||
            (curPosLiveCand.instBuySellRatio >= 1.15 && (curPosLiveCand.whaleRetailSpread >= 0 || curPosLiveCand.score < 85)))) ||
          (pos.side === 'LONG' &&
            (curPosLiveCand.whaleRetailSpread <= -3.0 ||
              (curPosLiveCand.instBuySellRatio <= 0.85 && (curPosLiveCand.whaleRetailSpread <= 0 || curPosLiveCand.score < 85)))))
    );
    const liveFundNow = Number(curPosLiveCand?.fundingRatePct ?? pos.fundingRatePct ?? 0);
    const hasHeavyFavorableFundingAndHigherHigh = Boolean(
      peakCoinMoveFrac >= 0.0035 &&
        currentAdverseR < 0.35 &&
        ((pos.side === 'LONG' && liveFundNow <= -0.10) || (pos.side === 'SHORT' && liveFundNow >= 0.10))
    );
    const isGivebackStall =
      minsHeld >= 30 &&
      rawCoinMoveFrac >= -0.0045 &&
      aeR >= 0.30 &&
      mfeR < 0.45 &&
      whaleOrTakerFlippedAgainst;
    const isDeepMaeWatchlistDegraded22m = Boolean(
      minsHeld >= 22 &&
        aeR >= 0.55 &&
        currentAdverseR >= 0.30 &&
        mfeR < 0.15 &&
        (!curPosLiveCand || curPosLiveCand.engine === 'WATCHLIST' || curPosLiveCand.score < 78) &&
        (pos.side === 'LONG'
          ? Number(curPosLiveCand?.whaleRetailSpread ?? 0) < 0 || Number(curPosLiveCand?.volRatio15m ?? 1) < 0.80
          : Number(curPosLiveCand?.whaleRetailSpread ?? 0) > 0 || Number(curPosLiveCand?.volRatio15m ?? 1) < 0.80)
    );
    // Engine #106C: Require >= 50m (over 3 full 15m bars) and deep currentAdverseR >= 0.50 before stale momentum scratch can fire (prevents 22m/32m -5.45 TL GRASS & -2.02 TL POLYX chops!)
    if (
      minsHeld >= 50 &&
      !hasHeavyFavorableFundingAndHigherHigh &&
      aeR >= 0.60 &&
      currentAdverseR >= 0.50 &&
      mfeR < 0.15 &&
      whaleOrTakerFlippedAgainst
    ) {
      isStaleMomentumScratch = true;
    }
  }
  if (!isTpHit && !isStopHit && !isFishingEmergencyExit && !isWickTakerCollapseScratch && !isStaleMomentumScratch && minsHeld >= 22 && rawCoinMoveFrac <= -0.0032 && rawCoinMoveFrac >= -0.0045) {
    const depth = await fetchJson(`${FAPI_BASE}/fapi/v1/depth?symbol=${pos.fSym}&limit=15`, {}, 2000);
    if (state.openPosition?.id !== posId || pos.isClosing) return;
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
        Math.abs(Number(c.rsVsBtcAtr || 0)) < 2.50 &&
        Math.abs(Number(c.change1hPct || 0)) < 3.00 &&
        !(state.obVetoStrikes && state.obVetoStrikes[c.symbol] >= 1) &&
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
  } else if (isProfitTakerCollapseHarvest) {
    exitReason = `💰 TAKER ÇÖKÜŞÜ KÂR HASADI (Motor #63A: 5dk Taker ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x Çöktü, Kâr Erimesi Beklenmeden Artıda Hasat Edildi | ROE +${roePct}%)`;
  } else if (isFishingEmergencyExit) {
    exitReason = `🎣 YEMLEME (FISHING) ERKEN TAHLİYESİ (Kurumsal Alıcı Çöktü [5dk Taker ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x], Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isWickTakerCollapseScratch) {
    exitReason = `🛡️ İĞNE REDDİ & 5dk TAKER ÇÖKÜŞÜ ERKEN TAHLİYESİ (Motor #56: ${curPosLiveCand?.candlePattern || 'İğne Reddi'} & 5dk Taker ${curPosLiveCand?.instBuySellRatio ?? 'N/A'}x, Tam Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isStaleMomentumScratch) {
    const staleMfeCapPct = mfeR >= 0.25 ? 45 : 25;
    exitReason = `⏱️ 32dk BAYAT İVME / SIKIŞMA ERKEN TAHLİYESİ (Motor #49: MFE ${(mfeR * 100).toFixed(0)}%R < ${staleMfeCapPct}%R & MAE ${(aeR * 100).toFixed(0)}%R, Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isOrderflowScratch) {
    exitReason = `🛡️ EUGENE ERKEN TAHTA TAHLİYESİ (Emir Defteri Tersine Döndü, Stop Beklenmeden Çıkıldı | ROE ${roePct}%)`;
  } else if (isFundingSettlementHarvest) {
    exitReason = `⏱️ FONLAMA KESİNTİSİ ÖNCESİ KÂR HASADI (Kesime <=5dk | Fonlama %${curPosLiveCand?.fundingRatePct ?? 0} | ROE +${roePct}%)`;
  } else if (rotationTarget) {
    exitReason = `🔄 ULTRA-APEX SIFIR-ZARAR SLOT ROTASYONU (Başabaş/Kârlı İşlemden ${rotationTarget.symbol} [${rotationTarget.score}/99] Fırsatına Geçildi | ROE +${roePct}%)`;
  } else if (isTimeStop) {
    exitReason = `⏱️ 90dk FONLAMA/ZAMAN KORUMASI (İvme Durdu, Fonlama Kesintisi Öncesi Çıkıldı | ROE ${roePct}%)`;
  }

  if (exitReason && state.openPosition?.id === posId && !pos.isClosing) {
    pos.isClosing = true; // Synchronous atomic lock so no concurrent loop can ever double-close or double-refund!
    let liveAvgExitPrice = null;
    if (pos.isLiveFapiOrder && !pos.externallyClosedOnExchange) {
      const finalExec = await executeFapiRealExit(pos, 1.0);
      if (!finalExec.ok) {
        // Engine #72F (GPT-6-Luna Fail-Safe Close Retry):
        // Never orphan an open exchange position or delete its stop if the close call failed -> unlock and retry on next 4s tick!
        pos.isClosing = false;
        return;
      }
      if (finalExec.avgExitPrice && finalExec.avgExitPrice > 0) {
        liveAvgExitPrice = finalExec.avgExitPrice;
      }
    }
    state.openPosition = null;

    // Engine #44B + #49B + Fixed Bug #35 + Engine #72 (Use real Binance fill price when available, fallback to modeled effectiveExitPrice):
    const isProfitStopClose =
      isStopHit && (pos.side === 'LONG' ? pos.stopPrice > pos.entryPrice : pos.stopPrice < pos.entryPrice);
    const stopLockedMoveFrac =
      pos.side === 'LONG'
        ? (pos.stopPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - pos.stopPrice) / pos.entryPrice;
    const liveSpreadFrac = (bestAsk - bestBid) / Math.max(1e-9, (bestAsk + bestBid) * 0.5);
    const serverStopSlipFrac = Math.max(0.0006, liveSpreadFrac + 0.0004);
    const modeledRawMoveFrac = isProfitStopClose
      ? Math.max(rawCoinMoveFrac, effectiveFeeSlipFrac + 0.0006, stopLockedMoveFrac - 0.0004)
      : isStopHit
        ? Math.max(rawCoinMoveFrac, stopLockedMoveFrac - serverStopSlipFrac)
        : rawCoinMoveFrac;
    const effectiveRawMoveFrac = liveAvgExitPrice
      ? pos.side === 'LONG'
        ? (liveAvgExitPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - liveAvgExitPrice) / pos.entryPrice
      : modeledRawMoveFrac;
    const effectiveNetMoveFrac = effectiveRawMoveFrac - effectiveFeeSlipFrac;
    const effectiveExitPrice = liveAvgExitPrice
      ? roundPriceToTick(pos.fSym, liveAvgExitPrice)
      : pos.side === 'LONG'
        ? roundPriceToTick(pos.fSym, pos.entryPrice * (1 + effectiveRawMoveFrac))
        : roundPriceToTick(pos.fSym, pos.entryPrice * (1 - effectiveRawMoveFrac));

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

    const hadPriorSameSymWin60m = (state.closedTrades || []).some(
      r =>
        r.symbol === pos.symbol &&
        Number(r.netPnlTry || 0) >= 0 &&
        Date.now() - Number(r.closedAtMs || parseClosedAtMs(r.closedAt) || 0) <= 60 * 60 * 1000
    );

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
      tp1Done: Boolean(pos.tp1Done),
      exitReason,
      closedAt: new Date().toLocaleString('tr-TR'),
      closedAtMs: Date.now(),
    });
    // Engine #46 + Fixed Bug #44 (GPT-6-Luna Protective-Stop Quarantine vs Early Scratch Cooldown):
    // Only increment symbolConsecStops on actual protective stop-outs or losses >= 3.50 TL; early tactical scratches get a 60m cooldown without triggering a 12h toxic quarantine!
    if (!state.symbolCooldowns) state.symbolCooldowns = {};
    if (!state.symbolConsecStops) state.symbolConsecStops = {};
    if (totalLifecyclePnlUsdt >= 0) {
      state.symbolConsecStops[pos.symbol] = 0;
      // Engine #80A + #84A + #99B (GPT-6-Luna Post-TP1 Cooldown Integrity & 15m Pre-TP1 Micro-Win Cooldown):
      // Only a first pre-TP1 micro-profit lock (< 1.25 TL, !pos.tp1Done, !isTpHit, !hadPriorSameSymWin60m) gets a 15-minute breather (1 full 15m candle).
      // Any TP1/TP harvest, >= 1.25 TL win (like LUMIAUSDT +3.02 TL), or 2nd win on the same symbol within 60m gets the full 45-minute cooldown!
      const isMicroProfitScratch =
        !pos.tp1Done && !isTpHit && totalLifecyclePnlTry < 1.25 && !hadPriorSameSymWin60m;
      const winCooldownMins = isMicroProfitScratch ? 15 : 45;
      const winExpiry = Date.now() + winCooldownMins * 60 * 1000;
      state.symbolCooldowns[pos.symbol] = isMicroProfitScratch
        ? winExpiry
        : Math.max(state.symbolCooldowns[pos.symbol] || 0, winExpiry);
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
      const scratchExpiry = Date.now() + 20 * 60 * 1000;
      state.symbolCooldowns[pos.symbol] = Math.max(state.symbolCooldowns[pos.symbol] || 0, scratchExpiry);
    }
    if (totalLifecyclePnlTry <= -2.50) {
      state.lastLossClosedAtMs = Date.now();
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

  // Fixed Bug #46 + Engine #74C: Decay progressive orderbook strikes if last veto was > 45 minutes ago!
  for (const symKey of Object.keys(state.obVetoStrikes)) {
    if (nowEntryMs - (state.obVetoAtMs[symKey] || 0) > 45 * 60 * 1000) {
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
        // Engine #102A: Require Whale Alignment (whaleRetailSpread >= 0 LONG / <= 0 SHORT) for early 90s Surge Reset so negative-whale coins like POLYX (-2.8%) serve their full orderbook cooldown!
        const isLongSurge =
          c.side === 'LONG' &&
          c.volRatio15m >= 1.25 &&
          c.oiDelta1hPct >= 0.35 &&
          c.instBuySellRatio >= 1.25 &&
          Number(c.whaleRetailSpread || 0) >= 0;
        const isShortSurge =
          c.side === 'SHORT' &&
          c.volRatio15m >= 1.25 &&
          c.oiDelta1hPct >= 0.35 &&
          c.instBuySellRatio <= 0.80 &&
          Number(c.whaleRetailSpread || 0) <= 0;
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

  // Engine #64D + GPT-6-Luna Fix #3 + Engine #85 (Dual-AI Luna + Freebuff Anti-Overconfidence Low-Volume Spoof Guard):
  const isInPostLossCoolDown = nowEntryMs - (state.lastLossClosedAtMs || 0) < 25 * 60 * 1000;
  const lastAnyClosedMs = Number(state.closedTrades?.[0]?.closedAtMs || 0);
  const isInGlobalBreathingCooldown = lastAnyClosedMs > 0 && nowEntryMs - lastAnyClosedMs < 15 * 60 * 1000;
  const dualAi = state.lastSelfAudit?.dualAiCouncil || {};
  const fbLongBonus = Number(dualAi.freebuffMinLongBonus || 0);

  const actionable = candidates.filter(c => {
    if (
      c.engine === 'WATCHLIST' ||
      (c.side !== 'LONG' && c.side !== 'SHORT') ||
      (isInGlobalBreathingCooldown && c.score < 90) ||
      Number(c.volRatio15m || 0) < 1.10 ||
      (c.side === 'LONG' ? Number(c.whaleRetailSpread || 0) < 0 : Number(c.whaleRetailSpread || 0) > 0) ||
      c.score <
        (isInPostLossCoolDown
          ? 88
          : c.side === 'LONG' && fbLongBonus > 0 && Number(c.volRatio15m || 0) < 1.20
            ? Math.max(84, 82 + fbLongBonus)
            : 84) ||
      (isInPostLossCoolDown &&
        !(
          c.takerDataValid &&
          Math.abs(Number(c.rsVsBtcAtr || 0)) >= 0.80 &&
          (c.side === 'LONG'
            ? c.instBuySellRatio >= 1.25 && Number(c.whaleRetailSpread || 0) >= 2.0 && Number(c.basisPct || 0) < 0.15
            : c.instBuySellRatio <= 0.78 && Number(c.whaleRetailSpread || 0) <= -2.0)
        )) ||
      (symCds[c.symbol] && symCds[c.symbol] > nowEntryMs) ||
      (obVetoCds[c.symbol] && obVetoCds[c.symbol] > nowEntryMs)
    ) {
      return false;
    }
    // Engine #99B (GPT-6-Luna Same-Symbol Pre-TP1 Anti-Chase Re-Entry Guard):
    // If the most recent closed trade on c.symbol within the last 35m was in the same direction, pre-TP1 (!tp1Done), and closed in profit,
    // forbid chasing the exact same symbol >= +0.45% higher (LONG) / lower (SHORT) than our recent exit price (like NILUSDT exited at $0.09061 and re-entered at $0.09158 +1.07% higher)!
    const lastSymClosed = (state.closedTrades || []).find(r => r.symbol === c.symbol);
    if (
      lastSymClosed &&
      lastSymClosed.side === c.side &&
      !lastSymClosed.tp1Done &&
      Number(lastSymClosed.netPnlTry || 0) >= 0 &&
      nowEntryMs - Number(lastSymClosed.closedAtMs || parseClosedAtMs(lastSymClosed.closedAt) || 0) <= 35 * 60 * 1000
    ) {
      const lastExitPx = Number(lastSymClosed.exitPrice || 0);
      const curPx = Number(c.price || 0);
      if (lastExitPx > 0 && curPx > 0) {
        const chasePastExitPct =
          c.side === 'LONG' ? ((curPx - lastExitPx) / lastExitPx) * 100 : ((lastExitPx - curPx) / lastExitPx) * 100;
        if (chasePastExitPct >= 0.45) {
          return false;
        }
      }
    }
    return true;
  });
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

    const obCheck = await fetchPerpOrderbookConfirm(cand.symbol, cand.side, cand.atr15mPct);
    if (!obCheck.ok) {
      // Engine #41 + #64A (GPT-6-Luna Progressive Strike Orderbook Cooldown; NO_DEPTH & MICRO_1M_SPIKE wait 90s for pullback without strike penalty!)
      const isNoStrikeWait =
        obCheck.vetoCode === 'NO_DEPTH' ||
        obCheck.vetoCode === 'MICRO_1M_SPIKE' ||
        String(obCheck.reason || '').startsWith('NO_DEPTH');
      let cdMins = 1.5;
      let strikeCount = state.obVetoStrikes[cand.symbol] || 0;
      if (!isNoStrikeWait) {
        strikeCount += 1;
        state.obVetoStrikes[cand.symbol] = strikeCount;
        const isSpoofVeto = obCheck.vetoCode === 'SPOOF_WALL_DECAY' || obCheck.vetoCode === 'BOOK_HOLLOWING';
        cdMins = isSpoofVeto
          ? (strikeCount === 1 ? 3.5 : strikeCount === 2 ? 12.0 : 35.0)
          : (strikeCount === 1 ? 2.5 : strikeCount === 2 ? 8.0 : 18.0);
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

    // Engine #64A: Use passive Maker Limit fill price & lower fee (0.13% vs 0.18%) when Post-Only Bid/Ask fill is confirmed!
    const isMakerEntry = Boolean(obCheck.isPassiveMakerFill && obCheck.makerEntryPrice > 0);
    const entryPrice = isMakerEntry
      ? obCheck.makerEntryPrice
      : cand.side === 'LONG'
        ? obCheck.bestAsk
        : obCheck.bestBid;
    const posFeeSlipFrac = isMakerEntry ? 0.0013 : ROUND_TRIP_FEE_SLIP_FRAC;
    let rawWickDistFrac = 0.0095;
    if (cand.side === 'LONG' && cand.structuralLow > 0 && cand.structuralLow < entryPrice) {
      rawWickDistFrac = (entryPrice - cand.structuralLow * 0.999) / entryPrice;
    } else if (cand.side === 'SHORT' && cand.structuralHigh > entryPrice) {
      rawWickDistFrac = (cand.structuralHigh * 1.001 - entryPrice) / entryPrice;
    }
    // Engine #42 + #59 + #74A + #89A (GPT-6-Luna Breakout-Midpoint Structural Stop & Volatility-Scaled Margin):
    // 1. On fast hype breakouts where 2-bar structuralLow is > 2.20% away, anchor the stop at the breakout invalidation zone (max 2.20% coin move)
    //    and let highAtrMarginScale scale position margin down so TL risk is strictly bounded without starving the hype entry!
    const rawStopFrac = Math.max(
      0.0092,
      Math.min(0.0220, rawWickDistFrac),
      Math.min(0.0215, (cand.atr15mPct / 100) * 0.65)
    );
    const underlyingSlFrac = Math.min(0.0220, rawStopFrac);
    const maxRiskLev = 0.0525 / (underlyingSlFrac + ROUND_TRIP_FEE_SLIP_FRAC + 0.0005);
    const microConfirm5x =
      cand.side === 'LONG'
        ? obCheck.microSkew > 0 && obCheck.ob2 >= 0.08
        : obCheck.microSkew < 0 && obCheck.ob2 <= -0.08;
    const rawAllowedLev = Math.min(tierLev, maxRiskLev);
    const rawChosenLev =
      rawAllowedLev >= 4.15 && tierLev >= 5 && microConfirm5x && underlyingSlFrac <= 0.0096
        ? 5
        : rawAllowedLev >= 3.85 && tierLev >= 4 && underlyingSlFrac <= 0.0112
          ? 4
          : rawAllowedLev >= 3.25 && tierLev >= 3.5 && underlyingSlFrac <= 0.0140
            ? 3.5
            : 3;
    // Engine #72G (GPT-6-Luna Integer Leverage Parity for LIVE_BINANCE_FAPI):
    // Binance Futures only accepts integer leverage (3, 4, 5); in LIVE_BINANCE_FAPI mode, quantize chosenLev to integer before sizing!
    const chosenLev = state.mode === 'LIVE_BINANCE_FAPI' ? Math.max(1, Math.min(5, Math.round(rawChosenLev))) : rawChosenLev;
    const highAtrMarginScale = underlyingSlFrac > 0.0150 ? Math.max(0.55, Number((0.0150 / underlyingSlFrac).toFixed(4))) : 1.0;
    const posMarginUsdt = Number(Math.max(MIN_NOTIONAL_USDT / chosenLev + 0.05, usableMarginUsdt * highAtrMarginScale).toFixed(4));
    const finalMarginUsdt = Math.min(usableMarginUsdt, posMarginUsdt);
    const maxNotionalUsdt = Number((finalMarginUsdt * chosenLev).toFixed(4));
    const underlyingTpFrac = Math.max(0.0250, underlyingSlFrac * 2.55);

    const stopPrice =
      cand.side === 'LONG'
        ? roundPriceToTick(cand.fSym, entryPrice * (1 - underlyingSlFrac), 'floor')
        : roundPriceToTick(cand.fSym, entryPrice * (1 + underlyingSlFrac), 'ceil');

    const tpPrice =
      cand.side === 'LONG'
        ? roundPriceToTick(cand.fSym, entryPrice * (1 + underlyingTpFrac), 'ceil')
        : roundPriceToTick(cand.fSym, entryPrice * (1 - underlyingTpFrac), 'floor');

    const liqDistFrac = Number((0.92 / chosenLev).toFixed(4));
    const liqPrice =
      cand.side === 'LONG'
        ? roundPriceToTick(cand.fSym, entryPrice * (1 - liqDistFrac), 'floor')
        : roundPriceToTick(cand.fSym, entryPrice * (1 + liqDistFrac), 'ceil');

    const syncedThesis = String(cand.thesis || '').replace(/->\s*[\d.]+x\s+(LONG|SHORT)!/, `-> ${chosenLev}x $1!`);

    // Engine #65-#72: If connected to Real Binance Futures (LIVE_BINANCE_FAPI), execute real ISOLATED order + verified hardware STOP_MARKET!
    let liveExec = { isLive: false };
    if (state.mode === 'LIVE_BINANCE_FAPI') {
      liveExec = await executeFapiRealEntry(state, {
        fSym: cand.fSym,
        side: cand.side,
        chosenLev,
        notionalUsdt: maxNotionalUsdt,
        entryPrice,
        underlyingSlFrac,
        underlyingTpFrac,
      });
      if (!liveExec.ok) {
        logEvent(
          state,
          `⚠️ [GERÇEK FAPI EMİR KORUMASI] ${cand.symbol}USDT gerçek emir gönderilemedi (${liveExec.reason}), bakiye korundu!`
        );
        continue;
      }
    }

    const bookedEntryPrice = liveExec.isLive && liveExec.avgPrice ? liveExec.avgPrice : entryPrice;
    const bookedMarginUsdt = liveExec.isLive && liveExec.usedMarginUsdt ? liveExec.usedMarginUsdt : finalMarginUsdt;
    const bookedNotionalUsdt = liveExec.isLive && liveExec.execNotionalUsdt ? liveExec.execNotionalUsdt : maxNotionalUsdt;
    const finalStopPrice = liveExec.isLive && liveExec.liveStopPrice ? liveExec.liveStopPrice : stopPrice;
    const finalTpPrice = liveExec.isLive && liveExec.liveTpPrice ? liveExec.liveTpPrice : tpPrice;
    const finalLiqPrice =
      cand.side === 'LONG'
        ? roundPriceToTick(cand.fSym, bookedEntryPrice * (1 - liqDistFrac), 'floor')
        : roundPriceToTick(cand.fSym, bookedEntryPrice * (1 + liqDistFrac), 'ceil');

    state.leverage = chosenLev;
    state.marginCashUsdt = Number((state.marginCashUsdt - bookedMarginUsdt).toFixed(4));
    state.openPosition = {
      id: `perp_${Date.now()}_${cand.symbol}`,
      symbol: cand.symbol,
      fSym: cand.fSym,
      side: cand.side,
      engine: cand.engine,
      candlePattern: cand.candlePattern,
      leverage: chosenLev,
      isLiveFapiOrder: Boolean(liveExec.isLive && liveExec.ok),
      executedQty: liveExec.execQty || roundQtyToStep(cand.fSym, bookedNotionalUsdt / bookedEntryPrice),
      hwStopOrderId: liveExec.hwStopOrderId || null,
      lastSyncedHwStopPrice: liveExec.isLive ? (liveExec.hwStopPrice || null) : finalStopPrice,
      initialMarginUsdt: bookedMarginUsdt,
      initialNotionalUsdt: bookedNotionalUsdt,
      marginUsdt: bookedMarginUsdt,
      marginTry: toTL(bookedMarginUsdt),
      notionalUsdt: bookedNotionalUsdt,
      notionalTry: toTL(bookedNotionalUsdt),
      entryPrice: bookedEntryPrice,
      currentPrice: bookedEntryPrice,
      extremePrice: bookedEntryPrice,
      maxAdverseCoinMoveFrac: 0,
      feeSlipFrac: posFeeSlipFrac,
      executionMode: isMakerEntry ? 'MAKER_LIMIT_POST_ONLY' : 'TAKER_MARKET_SWEEP',
      initialRiskFrac: underlyingSlFrac,
      tpExtensionCount: 0,
      stopPrice: finalStopPrice,
      tpPrice: finalTpPrice,
      liqPrice: finalLiqPrice,
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
    // Engine #100A: Immediately populate openPositionLiveCand on entry so the 4s fast loop has full Taker/Whale/Candle telemetry from second 0!
    state.openPositionLiveCand = cand;

    logEvent(
      state,
      `🚀 [${chosenLev}x ${cand.side} GİRİŞ (300 TL Anti-İğne)] ${cand.symbol}USDT @ $${bookedEntryPrice} | Teminat: ${toTL(bookedMarginUsdt)} TL (${chosenLev}x Büyüklük: ${toTL(bookedNotionalUsdt)} TL) | Stop: $${finalStopPrice} (-%${(underlyingSlFrac * 100).toFixed(2)}) | TP1: +%1.25 (%35 Nakit) | Ana Hedef: $${finalTpPrice} (+%${(underlyingTpFrac * 100).toFixed(2)}) | ${syncedThesis}`
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

  const md = `# ⚡ 300 TL SABİT ANA PARA (3x–5x RİSK-NORMALİZE KALDIRAÇ) + 23.000 TL HEDEF & OTONOM EVRİM (${state.version || 'Mutlak-Yapi-v11.1'})

**Son Güncelleme:** ${new Date().toLocaleString('tr-TR')}  
**🌍 Her Yerden (4.5G/Mobil/Wi-Fi Cloudflare Port Forwarding):** \`${PUBLIC_TUNNEL_URL}\` *(Yedek: \`${BACKUP_TUNNEL_URL}\`)*  
**🏠 Ev Wi-Fi:** \`http://${lanIp}:${DASHBOARD_PORT}\` | **💻 Bilgisayar:** \`http://localhost:${DASHBOARD_PORT}\`  
**Çalışma Modu:** \`${state.mode}\` — \`${state.fapiAccountStatus || 'SIM_LIVE_FAPI'}\` *(Max ${goalInfo.activeCapTry} TL İle Oynar + 3x–5x Luna/Qullamaggie Kaldıraç + Otonom Özeleştiri & Evrim Motoru #43–#71)*

---

## 🎯 23.000,00 TL BÜYÜK HEDEF & KENDİ KÂRIYLA KADEMELİ BÜYÜME YOL HARİTASI

* **🎯 Nihai Servet Hedefi:** **\`23.000,00 TL\`**
* **🏛️ Mevcut Kaldıraç + Spot Kâr Kasası Toplamı:** **\`${goalInfo.combinedTry} TL / 23.000,00 TL\` (\`%${goalInfo.progressPct} Tamamlandı\` | Kalan: \`${goalInfo.remainingTry} TL\`)**
* **🪜 Aktif Büyüme Basamağı:** **\`${goalInfo.tierLabel}\`** *(Cebinden ekstra 1 TL çıkmadan, yalnızca Spot Kâr Kasasında biriken dokunulmaz kârla kademe atlar!)*

---

## 🧠 İKİLİ YAPAY ZEKA KONSEYİ (GPT-6-LUNA + FREEBUFF AI — Motor #43–#85)

* **⏱️ Son Otonom Denetim:** \`${audit.lastAuditAt}\` | **Sonraki 2-Saatlik Denetim:** \`${audit.nextAuditAt}\`
* **🤝 Aktif İkili Yapay Zeka Ortaklığı:** **\`${audit.dualAiCouncil?.partnerModels || 'GPT-6-Luna + Freebuff AI (GLM 5.3 Flash / DeepSeek V4.1)'}\`** *(Gizlilik Kalkanı: \`${audit.dualAiCouncil?.privacyShield || 'Space Bunny Alpha Yasaklı'}\`)*
* **🧬 1. Beyin (GPT-6-Luna):** ${audit.dualAiCouncil?.lunaVerdict || '-'}
* **🛡️ 2. Beyin (Freebuff AI — Şeytanın Avukatı):** ${audit.dualAiCouncil?.freebuffVerdict || '-'}${audit.dualAiCouncil?.liveFreebuffNote ? `\n* **💬 Canlı Freebuff Mesajı:** *${audit.dualAiCouncil.liveFreebuffNote}*` : ''}
* **⚖️ İkili Konsey Ortak Kararı:** **${audit.dualAiCouncil?.consensusAction || '-'}**
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
    if (urlObj.pathname === '/api/dual-ai-council') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state.lastSelfAudit?.dualAiCouncil || {}, null, 2));
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
      <span>🧠 İkili Yapay Zeka Konseyi: GPT-6-Luna + Freebuff AI (Motor #43–#85)</span>
      <span class="sub">Son Denetim: <b>${(state.lastSelfAudit || {}).lastAuditAt || '-'}</b> | Sonraki: <b>${(state.lastSelfAudit || {}).nextAuditAt || '+2 Saat'}</b></span>
    </h3>
    <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px;">
      Aktif Otonom Barajlar: <b>LONG &gt;= ${(state.lastSelfAudit || {}).minLongScore || 78}p (5dk Taker &gt;= ${(state.lastSelfAudit || {}).minLongTaker5m || 1.02}x)</b> | <b>SHORT &gt;= ${(state.lastSelfAudit || {}).minShortScore || 78}p (5dk Taker &lt;= ${(state.lastSelfAudit || {}).maxShortTaker5m || 0.98}x)</b> | Luna $J$-Skoru: <b class="cyan">${(state.lastSelfAudit || {}).objectiveJ ?? 0}</b>
    </div>
    <div style="background:#131c31;border:1px solid #38bdf844;border-radius:10px;padding:10px;margin-bottom:10px;font-size:12px;line-height:1.5;">
      <div>🧬 <b class="cyan">1. Beyin (GPT-6-Luna):</b> ${state.lastSelfAudit?.dualAiCouncil?.lunaVerdict || 'Matematiksel konsey aktif.'}</div>
      <div style="margin-top:4px;">🛡️ <b class="amber">2. Beyin (Freebuff AI — GLM 5.3 / DeepSeek V4.1):</b> ${state.lastSelfAudit?.dualAiCouncil?.freebuffVerdict || 'Anti-Spoof ve Şeytanın Avukatı denetimi aktif.'}</div>
      ${state.lastSelfAudit?.dualAiCouncil?.liveFreebuffNote ? `<div style="margin-top:4px;color:#34d399;">💬 <b>Canlı Freebuff Notu:</b> ${state.lastSelfAudit.dualAiCouncil.liveFreebuffNote}</div>` : ''}
      <div style="margin-top:4px;color:#10b981;">⚖️ <b>Ortak Konsey Kararı:</b> ${state.lastSelfAudit?.dualAiCouncil?.consensusAction || 'İki yapay zeka mutabık.'}</div>
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

async function syncLiveUsdTryRateAndTunnel(state) {
  const now = Date.now();
  if (now - lastUsdTrySyncMs >= 120000) {
    try {
      const t = await fetchJson('https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTTRY', {}, 3000);
      const bid = Number(t?.bidPrice || 0);
      const ask = Number(t?.askPrice || 0);
      if (bid > 30 && ask > 30) {
        USD_TRY_RATE = Number(((bid + ask) / 2).toFixed(2));
        state.usdTryRate = USD_TRY_RATE;
        lastUsdTrySyncMs = now;
      }
    } catch {
      // keep last known USD_TRY_RATE
    }
  }
  try {
    if (fs.existsSync(TUNNEL_LOG_FILE)) {
      const txt = fs.readFileSync(TUNNEL_LOG_FILE, 'utf8');
      const matches = [...txt.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)];
      if (matches.length > 0) {
        const latestUrl = matches[matches.length - 1][0];
        if (latestUrl && latestUrl !== PUBLIC_TUNNEL_URL) {
          PUBLIC_TUNNEL_URL = latestUrl;
        }
      }
    }
    if (PUBLIC_TUNNEL_URL && state.lastNotifiedTunnelUrl && state.lastNotifiedTunnelUrl !== PUBLIC_TUNNEL_URL) {
      state.lastNotifiedTunnelUrl = PUBLIC_TUNNEL_URL;
      logEvent(state, `🌐 [YENİ MOBİL PANEL LİNKİ] Cloudflare Tüneli Yenilendi: ${PUBLIC_TUNNEL_URL}`);
      const cfg = loadEnv();
      if (cfg.WHATSAPP_PHONE && cfg.CALLMEBOT_API_KEY) {
        let phone = cfg.WHATSAPP_PHONE.replace(/\s+/g, '');
        if (phone.startsWith('05')) phone = '+9' + phone;
        else if (phone.startsWith('5')) phone = '+90' + phone;
        const waText = `🌐 [YENİ 7/24 MOBİL PANEL LİNKİ] Bilgisayar/Tünel yenilendi! Yeni 4.5G linkin: ${PUBLIC_TUNNEL_URL} (Ev Wi-Fi: http://${getLocalLanIp()}:${DASHBOARD_PORT})`;
        const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(waText)}&apikey=${encodeURIComponent(cfg.CALLMEBOT_API_KEY)}`;
        fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => {});
      }
    } else if (!state.lastNotifiedTunnelUrl) {
      state.lastNotifiedTunnelUrl = PUBLIC_TUNNEL_URL;
    }
  } catch {
    // ignore transient file read error
  }
}

async function runCycle(state) {
  if (isPositionCycleBusy && Date.now() - busySinceMs < 25000) return;
  isPositionCycleBusy = true;
  busySinceMs = Date.now();
  try {
    await syncLiveUsdTryRateAndTunnel(state);
    // Keepalive self-ping so public tunnels (Cloudflare & localhost.run) never hit activity timeout
    fetch(`${PUBLIC_TUNNEL_URL}/api/state`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    fetch(`${BACKUP_TUNNEL_URL}/api/state`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    await syncLiveFapiAccount(state);
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
  state.version = 'Mutlak-Yapi-v13.16-MatureUpperWickRolloverVeto-And-HealthyTtmExpansion-Motor107';
  // Engine #89 Startup Hygiene: Clear stale orderbook cooldowns so unchained hype rockets are immediately evaluated
  state.obVetoCooldowns = {};
  state.obVetoStrikes = {};
  // Engine #87B Startup Hygiene: Reclassify any historical false SPOOF_WALL_DECAY where ob1 was already opposing (ob:- for LONG / ob:+ for SHORT) to WEAK_OB
  if (state.obVetoReasons && state.obVetoCodes) {
    for (const [sym, reason] of Object.entries(state.obVetoReasons)) {
      const rStr = String(reason || '');
      if (
        (rStr.startsWith('SPOOF_WALL_DECAY_LONG (ob:-') || rStr.startsWith('SPOOF_WALL_DECAY_SHORT (ob:0.')) &&
        state.obVetoCodes[sym] === 'SPOOF_WALL_DECAY'
      ) {
        state.obVetoCodes[sym] = 'WEAK_OB';
        state.obVetoStrikes[sym] = Math.min(1, Number(state.obVetoStrikes?.[sym] || 1));
      }
    }
  }
  if (state.openPosition?.thesis && state.openPosition?.leverage) {
    state.openPosition.thesis = String(state.openPosition.thesis).replace(
      /->\s*[\d.]+x\s+(LONG|SHORT)!/,
      `-> ${state.openPosition.leverage}x $1!`
    );
  }
  runTwoHourSelfAudit(state, true);
  console.log('================================================================================');
  console.log(`⚡ 300 TL SABİT ANA PARA (3x–5x KALDIRAÇ) + İKİLİ YAPAY ZEKA (LUNA + FREEBUFF) KALESİ (v12.7 — Motor #58-#87)`);
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
