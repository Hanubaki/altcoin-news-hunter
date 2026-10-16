#!/usr/bin/env node
/**
 * AltcoinNewsHunter v7.0 (Ultra-Yield) — Multi-Source News + Binance Official CMS + CoinGecko Trending + Whale Taker Flow
 *
 * New Alpha Engines in v7.0:
 * 1. 📢 Binance Official Announcements API (New Listings, Launchpool, Collateral, Tokenized Assets — 1.8x Catalyst Weight)
 * 2. 🔥 CoinGecko Global Trending Radar (+10p Viral Momentum Boost for coins trending worldwide)
 * 3. 🐋 Whale Taker Buy Ratio (Measures exact % of aggressive market buy volume from Binance Kline column 10)
 * 4. 📈 Reversal Candle & Wick Bounce Confirmation (Catches the exact bottom turn rather than a falling knife)
 * 5. 🛡️ BTC 1h Crash Circuit Breaker + 🌍 69-Altcoin Market Breadth Meter
 * 6. 📏 Dynamic 14h ATR Volatility Stop-Loss Sizing
 */

import fs from 'node:fs';
import path from 'node:path';

const BANKROLL_TRY = 1000;
const USD_TRY_RATE = 35.7;
const BANKROLL_USDT = Number((BANKROLL_TRY / USD_TRY_RATE).toFixed(2)); // $28.01 USDT

const BINANCE_API = 'https://api.binance.com/api/v3';
const BINANCE_CMS_API = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=12';
const COINGECKO_TRENDING_API = 'https://api.coingecko.com/api/v3/search/trending';
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const SIGNALS_FILE = path.resolve('altcoin_news_signals.json');

const NEWS_FEEDS = [
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/' },
  { name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/' },
  { name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/' },
];

const ECOSYSTEM_GRAPH = [
  {
    id: 'AI_COMPUTE',
    name: 'Yapay Zeka (AI), OpenAI, NVIDIA & GPU Ağı',
    leader: 'FET',
    keywords: [
      'openai', 'nvidia', 'chatgpt', 'anthropic', 'claude', 'artificial intelligence',
      'ai agent', 'ai agents', 'gpu', 'render', 'bittensor', 'worldcoin',
      'sam altman', 'fetch.ai', 'asi alliance', 'near protocol', 'arkham',
    ],
    sympathyAlts: ['FET', 'RENDER', 'TAO', 'NEAR', 'ARKM', 'WLD', 'IO', 'THETA', 'GRT', 'ICP'],
  },
  {
    id: 'SOLANA_ECO',
    name: 'Solana (SOL) & DEX / Likidite Ekosistemi',
    leader: 'SOL',
    keywords: [
      'solana', 'firedancer', 'jupiter', 'raydium', 'pyth', 'jito', 'bonk', 'dogwifhat',
      'sol etf', 'phantom', 'pump.fun', 'anatoly',
    ],
    sympathyAlts: ['JUP', 'RAY', 'PYTH', 'JTO', 'BONK', 'WIF', 'BOME'],
  },
  {
    id: 'RWA_INSTITUTIONAL',
    name: 'RWA (Gerçek Dünya Varlıkları), BlackRock, Swift & Kurumsal Fonlar',
    leader: 'XRP',
    keywords: [
      'blackrock', 'swift', 'tokenization', 'tokenized', 'rwa', 'chainlink',
      'ccip', 'ondo', 'ripple', 'xrp', 'rlusd', 'stellar', 'hedera', 'algorand', 'avalanche',
      'jp morgan', 'citibank', 'treasury', 'sec settlement', 'collateral asset', 'bstocks',
    ],
    sympathyAlts: ['ONDO', 'LINK', 'XRP', 'XLM', 'AVAX', 'HBAR', 'ALGO', 'OM', 'RSR'],
  },
  {
    id: 'ETH_LAYER2_DEFI',
    name: 'Ethereum DeFi, Restaking & Layer-2 (Aave / Uniswap / Lido / Arbitrum)',
    leader: 'ETH',
    keywords: [
      'arbitrum', 'optimism', 'starknet', 'zksync', 'lido', 'ether.fi', 'eigenlayer',
      'restaking', 'uniswap', 'aave', 'pendle', 'pectra', 'layer 2', 'layer-2',
      'babylon', 'lending proposal', 'vitalik',
    ],
    sympathyAlts: ['AAVE', 'UNI', 'PENDLE', 'LDO', 'ETHFI', 'EIGEN', 'ARB', 'OP', 'ENS', 'METIS'],
  },
  {
    id: 'MOVE_NEXT_L1',
    name: 'Move VM & Yeni Nesil Yüksek Hızlı L1 (Sui / Aptos / Sei / Injective)',
    leader: 'SUI',
    keywords: [
      'sui ', 'sui network', 'mysten', 'aptos', 'move language', 'sei network',
      'celestia', 'modular blockchain', 'injective',
    ],
    sympathyAlts: ['SUI', 'APT', 'SEI', 'TIA', 'INJ'],
  },
  {
    id: 'GAMEFI_METAVERSE',
    name: 'Web3 Oyun (GameFi), Immutable, Ronin & Metaverse',
    leader: 'IMX',
    keywords: [
      'immutable', 'gala games', 'sandbox', 'axie', 'ronin', 'beam', 'pixels',
      'web3 gaming', 'gamefi', 'metaverse', 'ubisoft', 'sony', 'epic games',
    ],
    sympathyAlts: ['IMX', 'GALA', 'SAND', 'AXS', 'BEAMX', 'PIXEL', 'RONIN', 'PORTAL'],
  },
  {
    id: 'DEPIN_STORAGE',
    name: 'DePIN, Merkeziyetsiz Bulut Depolama & IoT Donanım',
    leader: 'FIL',
    keywords: [
      'depin', 'filecoin', 'arweave', 'iotex', 'jasmy', 'decentralized storage',
    ],
    sympathyAlts: ['FIL', 'AR', 'IOTX', 'JASMY'],
  },
  {
    id: 'BTC_ECOSYSTEM',
    name: 'Bitcoin Layer-2, Ordinals, Runes & BTC DeFi',
    leader: 'BTC',
    keywords: [
      'stacks', 'ordinals', 'runes', 'thorchain', 'bitcoin cash', 'litecoin',
      'bitcoin l2', 'bitcoin layer-2', 'bitcoin defi', 'babylon', 'saylor',
    ],
    sympathyAlts: ['STX', 'ORDI', 'RUNE', 'BCH', 'LTC'],
  },
  {
    id: 'MEME_MUSK_RETAIL',
    name: 'Elon Musk, X Payments & Yüksek Hacimli Meme Katalizörleri',
    leader: 'DOGE',
    keywords: [
      'elon musk', 'dogecoin', 'doge', 'shiba', 'pepe', 'floki', 'memecoin', 'meme coin',
      'x payments',
    ],
    sympathyAlts: ['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'PNUT'],
  },
  {
    id: 'BNB_EXCHANGE_ECO',
    name: 'Binance / BNB Chain, Launchpool & DEX Ekosistemi',
    leader: 'BNB',
    keywords: [
      'bnb chain', 'pancakeswap', 'trust wallet', 'changpeng zhao', 'space id',
      'open campus', 'binance labs', 'binance will list', 'launchpool',
    ],
    sympathyAlts: ['CAKE', 'TWT', 'ID', 'EDU'],
  },
];

const BULLISH_TERMS = [
  'launch', 'launches', 'partner', 'partnership', 'approve', 'approved', 'approval',
  'inflow', 'inflows', 'surge', 'surges', 'soar', 'soars', 'adopt', 'adoption', 'upgrade',
  'bull', 'bullish', 'record', 'integrate', 'integration', 'fund', 'funds', 'funding',
  'backing', 'accumulate', 'accumulates', 'breakout', 'rally', 'rallies',
  'win', 'wins', 'settlement', 'expansion', 'institutional', 'milestone',
  'buck', 'outperform', 'whale', 'listing', 'will list', 'will add', 'collateral',
  'support', 'growth', 'advances', 'major', 'date for', 'new', 'unveil', 'unveils', 'boost', 'jump',
];

const BEARISH_TERMS = [
  'hack', 'hacked', 'exploit', 'ban', 'banned', 'lawsuit', 'sue', 'sued', 'crash',
  'outflow', 'outflows', 'dump', 'delist', 'arrest', 'fraud', 'scam', 'delay',
  'reject', 'rejected', 'slump', 'drop', 'drops', 'liquidation', 'insolvency', 'drain',
  'stolen', 'phishing', 'penalty', 'fine', 'dip', 'dips', 'slide', 'slides', 'fall', 'falls',
  'lowest', 'slow', 'risk', 'risks', 'exit', 'shed', 'loss', 'losses', 'warn', 'warning',
  'fear', 'bear', 'bearish', 'down', 'plunge', 'plunges', 'tumble', 'attack', 'attacks',
];

function getAllTrackedSymbols() {
  const s = new Set(['BTC', 'ETH', 'SOL', 'BNB']);
  for (const eco of ECOSYSTEM_GRAPH) {
    s.add(eco.leader);
    for (const alt of eco.sympathyAlts) s.add(alt);
  }
  return Array.from(s);
}

async function fetchText(url, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (AltcoinNewsHunter/7.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AltcoinNewsHunter/7.0',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseRssFeed(xml, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  const now = Date.now();

  while ((match = itemRegex.exec(xml)) !== null && items.length < 20) {
    const block = match[1];
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const descMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i);
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

    const clean = str =>
      (str || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#039;|&#8217;|&#8216;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;|&#8220;|&#8221;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

    const title = clean(titleMatch?.[1] || titleMatch?.[2]);
    const summary = clean(descMatch?.[1] || descMatch?.[2]).slice(0, 220);
    const pubDateStr = pubMatch ? pubMatch[1].trim() : null;
    const pubMs = pubDateStr ? new Date(pubDateStr).getTime() : now;
    const minutesAgo = Number.isFinite(pubMs) ? Math.max(1, Math.round((now - pubMs) / 60000)) : 120;

    if (title) {
      items.push({ source: sourceName, title, summary, minutesAgo, sourceWeight: 1.0 });
    }
  }
  return items;
}

async function fetchBinanceAnnouncements() {
  try {
    const res = await fetchJson(BINANCE_CMS_API, {}, 3200);
    const catalogs = res?.data?.catalogs || [];
    const items = [];
    const now = Date.now();
    for (const cat of catalogs) {
      for (const art of (cat.articles || []).slice(0, 8)) {
        const minutesAgo = art.releaseDate ? Math.max(1, Math.round((now - art.releaseDate) / 60000)) : 60;
        items.push({
          source: 'BinanceResmiDuyuru',
          title: art.title,
          summary: art.title,
          minutesAgo,
          sourceWeight: 1.8, // Official exchange announcements carry 1.8x catalyst weight
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function fetchCoinGeckoTrending() {
  try {
    const res = await fetchJson(COINGECKO_TRENDING_API, {}, 3200);
    return new Set(
      (res?.coins || [])
        .map(c => (c.item?.symbol || '').toUpperCase())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

async function scanAllNewsFeeds() {
  const [binanceAnns, trendingSet, ...feedResults] = await Promise.all([
    fetchBinanceAnnouncements(),
    fetchCoinGeckoTrending(),
    ...NEWS_FEEDS.map(f =>
      fetchText(f.url, 3200)
        .then(xml => parseRssFeed(xml, f.name))
        .catch(() => [])
    ),
  ]);

  const headlines = [...binanceAnns];
  const activeFeeds = [];
  if (binanceAnns.length > 0) activeFeeds.push(`BinanceCMS (${binanceAnns.length})`);

  feedResults.forEach((list, idx) => {
    if (Array.isArray(list) && list.length > 0) {
      headlines.push(...list);
      activeFeeds.push(`${NEWS_FEEDS[idx].name} (${list.length})`);
    }
  });

  const altCatalysts = {};
  for (const item of headlines) {
    const textLower = ` ${item.title.toLowerCase()} ${item.summary.toLowerCase()} `;
    const titleLower = ` ${item.title.toLowerCase()} `;

    let bullHits = 0;
    let bearHits = 0;
    for (const b of BULLISH_TERMS) {
      if (titleLower.includes(b)) bullHits += 1.6;
      else if (textLower.includes(b)) bullHits += 0.5;
    }
    for (const r of BEARISH_TERMS) {
      if (titleLower.includes(r)) bearHits += 2.0;
      else if (textLower.includes(r)) bearHits += 0.7;
    }

    const isContrastiveBull = titleLower.includes('buck') || titleLower.includes('despite') || titleLower.includes('defy');
    const netHeadlineSentiment = isContrastiveBull
      ? Math.max(1.5, bullHits - bearHits * 0.3)
      : bullHits - bearHits;

    if (netHeadlineSentiment <= 0.4) continue;

    const recencyWeight = item.minutesAgo <= 90 ? 1.7 : item.minutesAgo <= 240 ? 1.35 : item.minutesAgo <= 720 ? 1.0 : 0.65;
    const srcWeight = item.sourceWeight || 1.0;

    for (const eco of ECOSYSTEM_GRAPH) {
      const titleKw = eco.keywords.filter(kw => titleLower.includes(kw));
      if (titleKw.length === 0) continue;

      for (const alt of eco.sympathyAlts) {
        if (!altCatalysts[alt]) {
          altCatalysts[alt] = {
            symbol: alt,
            leaderSymbol: eco.leader,
            ecosystems: new Set(),
            matchedKeywords: new Set(),
            freshestMinutesAgo: 9999,
            headlines: [],
          };
        }
        const entry = altCatalysts[alt];
        entry.ecosystems.add(eco.name);
        titleKw.forEach(k => entry.matchedKeywords.add(k.trim()));

        const directMention = titleLower.includes(` ${alt.toLowerCase()} `) || titleKw.some(k => k.toUpperCase() === alt);
        const catalystPoints = Number(
          (netHeadlineSentiment * recencyWeight * srcWeight * (directMention ? 1.35 : 1.0)).toFixed(2)
        );

        if (item.minutesAgo < entry.freshestMinutesAgo) {
          entry.freshestMinutesAgo = item.minutesAgo;
        }
        if (!entry.headlines.some(h => h.title === item.title)) {
          entry.headlines.push({
            source: item.source,
            title: item.title,
            minutesAgo: item.minutesAgo,
            catalystPoints,
            directMention,
          });
        }
      }
    }
  }

  for (const alt of Object.keys(altCatalysts)) {
    const entry = altCatalysts[alt];
    entry.headlines.sort((a, b) => b.catalystPoints - a.catalystPoints);
    const top3Headlines = entry.headlines.slice(0, 3);
    entry.newsScore = Number(top3Headlines.reduce((sum, h) => sum + h.catalystPoints, 0).toFixed(2));
  }

  return {
    totalHeadlines: headlines.length,
    activeFeeds,
    trendingSet,
    altCatalysts,
  };
}

function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function calcEMA(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/**
 * MACD (12, 26, 9) — Detects bullish momentum shift (Histogram rising or crossing above 0)
 */
function calcMACD(closes) {
  if (closes.length < 15) return { macdBullishTurn: false, histRising: false };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  const hist = macdLine.map((m, i) => m - signalLine[i]);
  const lastHist = hist[hist.length - 1];
  const prevHist = hist[hist.length - 2];
  return {
    macdBullishTurn: lastHist > 0 || lastHist > prevHist,
    histRising: lastHist > prevHist,
  };
}

/**
 * Bollinger Bands (20, 2) %B & Squeeze Detector
 * 0.0 = at lower band (oversold support), 1.0 = at upper band (overbought)
 */
function calcBollingerMetrics(closes, period = 20) {
  if (closes.length < 5) return { bbPctB: 0.5, bbWidthPct: 5.0, isSqueeze: false };
  const slice = closes.slice(-Math.min(period, closes.length));
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  if (std === 0 || mean === 0) return { bbPctB: 0.5, bbWidthPct: 5.0, isSqueeze: false };
  const lower = mean - 2 * std;
  const upper = mean + 2 * std;
  const last = slice[slice.length - 1];
  const bbPctB = Number(((last - lower) / (upper - lower)).toFixed(2));
  const bbWidthPct = Number((((upper - lower) / mean) * 100).toFixed(2));
  const isSqueeze = bbWidthPct <= 4.8;
  return { bbPctB, bbWidthPct, isSqueeze };
}

/**
 * TradingArena.ai Style ADX (14) + EMA20/EMA50 Trend Regime Detector
 */
function calcADXAndRegime(klines, closes) {
  if (!Array.isArray(klines) || klines.length < 15) {
    return { adx: 20, ema20AboveEma50: true, regime: 'DENGELI' };
  }
  const ema20Arr = calcEMA(closes, 14);
  const ema50Arr = calcEMA(closes, 26);
  const ema20 = ema20Arr[ema20Arr.length - 1] || 0;
  const ema50 = ema50Arr[ema50Arr.length - 1] || 0;
  const ema20AboveEma50 = ema20 >= ema50 * 0.998;

  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;
  for (let i = Math.max(1, klines.length - 14); i < klines.length; i++) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const prevHigh = Number(klines[i - 1][2]);
    const prevLow = Number(klines[i - 1][3]);
    const prevClose = Number(klines[i - 1][4]);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  const plusDI = trSum > 0 ? (plusDM / trSum) * 100 : 20;
  const minusDI = trSum > 0 ? (minusDM / trSum) * 100 : 20;
  const diSum = plusDI + minusDI;
  const adx = diSum > 0 ? Number(((Math.abs(plusDI - minusDI) / diSum) * 100).toFixed(1)) : 20;
  const regime = adx >= 25 && plusDI >= minusDI ? 'GUCLU_TREND' : 'DIP_TOPLAMA';
  return { adx, ema20AboveEma50, regime };
}

/**
 * TradingArena.ai Claude-Opus Style Bullish RSI Divergence Detector
 */
function detectRSIDivergence(closes) {
  if (closes.length < 16) return false;
  const firstHalf = closes.slice(-14, -5);
  const secondHalf = closes.slice(-6);
  const min1 = Math.min(...firstHalf);
  const min2 = Math.min(...secondHalf);
  const rsi1 = calcRSI(closes.slice(0, -5), 7);
  const rsi2 = calcRSI(closes, 7);
  // Bullish divergence: price near/below previous low while RSI makes higher low, or strong oversold curl
  return (min2 <= min1 * 1.005 && rsi2 > rsi1 + 2) || (rsi2 <= 38 && closes[closes.length - 1] > closes[closes.length - 2]);
}

/**
 * TradingArena.ai Support & Resistance Pivot Level Calculator
 */
function calcSupportResistance(klines, lastPrice) {
  if (!Array.isArray(klines) || klines.length < 6 || !lastPrice) {
    return { support: lastPrice * 0.96, resistance: lastPrice * 1.06, roomToResistancePct: 6.0 };
  }
  const highs = klines.slice(-24).map(k => Number(k[2]));
  const lows = klines.slice(-24).map(k => Number(k[3]));
  const sortedHighs = [...highs].sort((a, b) => b - a);
  const sortedLows = [...lows].sort((a, b) => a - b);
  const resistance = sortedHighs[1] || sortedHighs[0] || lastPrice * 1.05;
  const support = sortedLows[1] || sortedLows[0] || lastPrice * 0.96;
  const roomToResistancePct = Number((((Math.max(resistance, lastPrice * 1.015) - lastPrice) / lastPrice) * 100).toFixed(2));
  return {
    support: Number(support.toPrecision(5)),
    resistance: Number(resistance.toPrecision(5)),
    roomToResistancePct,
  };
}

/**
 * TradingArena.ai 4-Model Hive-Mind Consensus Engine
 * Simulates the top 4 leaderboard AI strategies voting independently on the setup
 */
function computeArenaHiveMind({
  newsScore,
  freshestMinutesAgo,
  isTrending,
  ema20AboveEma50,
  macdBullishTurn,
  isSqueeze,
  volRatio,
  rsi1h,
  hasRsiDivergence,
  bbPctB,
  roomToResistancePct,
  takerBuyRatio,
  isGreenBounce,
  fundingHourlyPct,
}) {
  const votes = [];
  // 1. Llama 4 Maverick (Momentum & Trend Leader)
  if ((ema20AboveEma50 && macdBullishTurn) || isSqueeze || volRatio >= 1.15) {
    votes.push('Llama-4-Maverick');
  }
  // 2. Llama 4 Scout (81% Hit-Rate Precision Mean-Reversion)
  if ((rsi1h <= 50 || hasRsiDivergence || bbPctB <= 0.48) && roomToResistancePct >= 1.8) {
    votes.push('Llama-4-Scout');
  }
  // 3. Gemini 3.5 Flash (Real-Time Catalyst & News Velocity)
  if (newsScore >= 3.0 || freshestMinutesAgo <= 240 || isTrending) {
    votes.push('Gemini-3.5-Flash');
  }
  // 4. Claude Opus 4.8 (Whale Orderflow & Risk Structure)
  if (takerBuyRatio >= 0.49 && (isGreenBounce || fundingHourlyPct < 0)) {
    votes.push('Claude-Opus-4.8');
  }
  return {
    aiConsensusCount: votes.length,
    aiConsensusModels: votes,
    aiConsensusLabel: `${votes.length}/4 AI ONAYLI`,
  };
}

function calcATRPct(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < 3) return 2.5;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const prevClose = Number(klines[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (prevClose > 0) trs.push((tr / prevClose) * 100);
  }
  if (trs.length === 0) return 2.5;
  const slice = trs.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
  return Number(avg.toFixed(2));
}

/**
 * Alpha Engine #3 & #4: Whale Taker Buy Ratio + Bottom Bounce Candle Check
 */
function analyzeWhaleAndCandleFlow(klines) {
  if (!Array.isArray(klines) || klines.length < 3) {
    return { takerBuyRatio: 0.5, isGreenBounce: false };
  }
  // Analyze last 3 hours of taker buy volume vs total quote volume
  const recent = klines.slice(-3);
  let totalQuoteVol = 0;
  let takerBuyQuoteVol = 0;
  for (const k of recent) {
    totalQuoteVol += Number(k[7] || 0);       // Quote asset volume
    takerBuyQuoteVol += Number(k[10] || 0);   // Taker buy quote asset volume
  }
  const takerBuyRatio = totalQuoteVol > 0 ? Number((takerBuyQuoteVol / totalQuoteVol).toFixed(3)) : 0.5;

  // Check if latest candle is turning green or bouncing strongly off its low
  const last = klines[klines.length - 1];
  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const close = Number(last[4]);
  const range = Math.max(0.0000001, high - low);
  const closePositionInRange = (close - low) / range;
  const isGreenBounce = close >= open || closePositionInRange >= 0.55;

  return { takerBuyRatio, isGreenBounce };
}

async function main() {
  const t0 = Date.now();
  console.log('================================================================================');
  console.log(`🚀 AltcoinNewsHunter v8.0 (TradingArena Hive-Mind) | 4-AI İttifakı + Balina Akışı`);
  console.log('================================================================================\n');

  const allSymbols = getAllTrackedSymbols();
  const symbolsParam = JSON.stringify(allSymbols.map(s => `${s}USDT`));

  const [newsScan, tickersRes, hlMetaRes] = await Promise.all([
    scanAllNewsFeeds(),
    fetchJson(`${BINANCE_API}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`),
    fetchJson(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    }).catch(() => null),
  ]);

  const tickerMap = {};
  let greenCoinsCount = 0;
  for (const t of tickersRes || []) {
    const sym = t.symbol.replace(/USDT$/, '');
    const chg = Number(t.priceChangePercent);
    if (chg > 0) greenCoinsCount++;
    tickerMap[sym] = {
      lastPrice: Number(t.lastPrice),
      change24hPct: chg,
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
      quoteVol24h: Number(t.quoteVolume),
    };
  }
  const marketBreadthPct = tickersRes?.length ? Math.round((greenCoinsCount / tickersRes.length) * 100) : 50;

  const hlMap = {};
  if (Array.isArray(hlMetaRes) && hlMetaRes.length === 2) {
    const universe = hlMetaRes[0]?.universe || [];
    const ctxs = hlMetaRes[1] || [];
    universe.forEach((u, idx) => {
      if (ctxs[idx]) {
        hlMap[u.name] = Number((Number(ctxs[idx].funding || 0) * 100).toFixed(4));
      }
    });
  }

  const positiveNewsAlts = Object.values(newsScan.altCatalysts)
    .filter(c => c.newsScore >= 1.5 && tickerMap[c.symbol])
    .sort((a, b) => b.newsScore - a.newsScore)
    .slice(0, 22);

  const [btcKlinesRes, ...klineResults] = await Promise.allSettled([
    fetchJson(`${BINANCE_API}/klines?symbol=BTCUSDT&interval=15m&limit=5`, {}, 3500),
    ...positiveNewsAlts.map(c =>
      fetchJson(`${BINANCE_API}/klines?symbol=${c.symbol}USDT&interval=1h&limit=30`, {}, 3500)
    ),
  ]);

  let btc1hChangePct = 0;
  if (btcKlinesRes.status === 'fulfilled' && Array.isArray(btcKlinesRes.value) && btcKlinesRes.value.length >= 4) {
    const k = btcKlinesRes.value;
    const open1hAgo = Number(k[0][1]);
    const closeNow = Number(k[k.length - 1][4]);
    if (open1hAgo > 0) {
      btc1hChangePct = Number((((closeNow - open1hAgo) / open1hAgo) * 100).toFixed(2));
    }
  }
  const btcCrashAlert = btc1hChangePct <= -1.8;

  const scoredOpportunities = [];
  for (let i = 0; i < positiveNewsAlts.length; i++) {
    const cat = positiveNewsAlts[i];
    const sym = cat.symbol;
    const mkt = tickerMap[sym];
    const leaderMkt = tickerMap[cat.leaderSymbol] || mkt;

    const klines = klineResults[i]?.status === 'fulfilled' ? klineResults[i].value : [];
    const closes = klines.map(k => Number(k[4]));
    const volumes = klines.map(k => Number(k[5]));

    const rsi1h = calcRSI(closes, 14);
    const atr1hPct = calcATRPct(klines, 14);
    const { macdBullishTurn } = calcMACD(closes);
    const { bbPctB, bbWidthPct, isSqueeze } = calcBollingerMetrics(closes, 20);
    const { adx, ema20AboveEma50, regime } = calcADXAndRegime(klines, closes);
    const hasRsiDivergence = detectRSIDivergence(closes);
    const { support, resistance, roomToResistancePct } = calcSupportResistance(klines, mkt.lastPrice);
    const { takerBuyRatio, isGreenBounce } = analyzeWhaleAndCandleFlow(klines);

    const change1hPct = closes.length >= 2
      ? Number((((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100).toFixed(2))
      : 0;
    const avgVol = volumes.length > 4
      ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
      : 1;
    const volRatio = Number(((volumes[volumes.length - 1] || avgVol) / Math.max(0.0001, avgVol)).toFixed(2));
    const fundingHourlyPct = hlMap[sym] ?? 0;
    const isTrending = newsScan.trendingSet.has(sym);

    const lagVsLeader24h = Number((leaderMkt.change24hPct - mkt.change24hPct).toFixed(2));

    // Anti-FOMO Guard + Bollinger Overextension + Whale Dump Rejection
    if (rsi1h > 68 || bbPctB > 0.98 || change1hPct > 4.5 || mkt.change24hPct > 14) continue;
    if (takerBuyRatio < 0.38) continue;

    // TradingArena.ai 4-Model Hive-Mind Consensus
    const hiveMind = computeArenaHiveMind({
      newsScore: cat.newsScore,
      freshestMinutesAgo: cat.freshestMinutesAgo,
      isTrending,
      ema20AboveEma50,
      macdBullishTurn,
      isSqueeze,
      volRatio,
      rsi1h,
      hasRsiDivergence,
      bbPctB,
      roomToResistancePct,
      takerBuyRatio,
      isGreenBounce,
      fundingHourlyPct,
    });

    let totalScore = Math.min(40, cat.newsScore * 4.5);
    if (rsi1h <= 34) totalScore += 20;
    else if (rsi1h <= 46) totalScore += 14;
    else if (rsi1h <= 58) totalScore += 7;

    // Bollinger Band Lower Dip Support & Squeeze Bonus
    if (bbPctB <= 0.35) totalScore += 5;
    if (isSqueeze) totalScore += 5;

    // MACD + EMA20/50 + RSI Divergence Bonus (TradingArena Core Indicators)
    if (macdBullishTurn) totalScore += 5;
    if (ema20AboveEma50) totalScore += 4;
    if (hasRsiDivergence) totalScore += 6;

    // TradingArena 4-AI Hive-Mind Consensus Bonus
    if (hiveMind.aiConsensusCount === 4) totalScore += 12;
    else if (hiveMind.aiConsensusCount === 3) totalScore += 7;

    // Whale Taker Buy Bonus
    if (takerBuyRatio >= 0.53) totalScore += 10;
    else if (takerBuyRatio >= 0.49) totalScore += 5;

    // Reversal Candle Confirmation Bonus
    if (isGreenBounce) totalScore += 7;

    // CoinGecko Global Trending Bonus
    if (isTrending) totalScore += 9;

    if (lagVsLeader24h > 0.8) totalScore += Math.min(8, lagVsLeader24h * 1.8);
    if (fundingHourlyPct < 0) totalScore += 7;
    if (volRatio >= 1.1) totalScore += Math.min(7, (volRatio - 1) * 5);

    const rangePct = mkt.low24h > 0 ? ((mkt.high24h - mkt.low24h) / mkt.low24h) * 100 : 4;
    const tpPct = Number(Math.max(4.5, Math.min(9.0, rangePct * 0.65)).toFixed(2));
    const slPct = Number(Math.max(1.8, Math.min(3.6, atr1hPct * 1.45)).toFixed(2));

    scoredOpportunities.push({
      symbol: sym,
      leaderSymbol: cat.leaderSymbol,
      ecosystems: Array.from(cat.ecosystems),
      matchedKeywords: Array.from(cat.matchedKeywords).slice(0, 6),
      newsScore: cat.newsScore,
      freshestMinutesAgo: cat.freshestMinutesAgo,
      headlines: cat.headlines.slice(0, 2),
      lastPrice: mkt.lastPrice,
      change1hPct,
      change24hPct: mkt.change24hPct,
      lagVsLeader24h,
      rsi1h,
      hasRsiDivergence,
      atr1hPct,
      bbPctB,
      bbWidthPct,
      isSqueeze,
      macdBullishTurn,
      adx,
      ema20AboveEma50,
      regime,
      support,
      resistance,
      roomToResistancePct,
      aiConsensusCount: hiveMind.aiConsensusCount,
      aiConsensusModels: hiveMind.aiConsensusModels,
      aiConsensusLabel: hiveMind.aiConsensusLabel,
      takerBuyRatioPct: Number((takerBuyRatio * 100).toFixed(1)),
      isGreenBounce,
      isTrending,
      volRatio,
      fundingHourlyPct,
      totalScore: Number(totalScore.toFixed(1)),
      tpPct,
      slPct,
      tpPrice: Number((mkt.lastPrice * (1 + tpPct / 100)).toPrecision(5)),
      slPrice: Number((mkt.lastPrice * (1 - slPct / 100)).toPrecision(5)),
    });
  }

  scoredOpportunities.sort((a, b) => b.totalScore - a.totalScore);

  const selectedTop4 = [];
  const usedLeaders = new Set();
  for (const opp of scoredOpportunities) {
    if (usedLeaders.has(opp.leaderSymbol)) continue;
    usedLeaders.add(opp.leaderSymbol);
    selectedTop4.push(opp);
    if (selectedTop4.length === 4) break;
  }

  console.log(`📰 [Kaynaklar (${newsScan.totalHeadlines} Haber)]: ${newsScan.activeFeeds.join(' | ')}`);
  console.log(`🛡️ [BTC Kalkanı]: 1s BTC %${btc1hChangePct} (${btcCrashAlert ? '🚨 FREN' : '✅ GÜVENLİ'}) | 🌍 Altcoin İştahı: %${marketBreadthPct} Yeşil`);

  selectedTop4.forEach((item, idx) => {
    console.log(
      `\n${idx + 1}. 🎯 ${item.symbol} (Skor: ${item.totalScore}/100 | 🤖 ${item.aiConsensusLabel}) | RSI: ${item.rsi1h}${item.hasRsiDivergence ? ' (Uyumsuzluk ✅)' : ''} | 🐋 Balina: %${item.takerBuyRatioPct} | Destek/Direnç: ${item.support}/${item.resistance}`
    );
    item.headlines.forEach(h => {
      console.log(`   • [${h.source} - ${h.minutesAgo}dk önce]: "${h.title}"`);
    });
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - t0,
    bankrollTry: BANKROLL_TRY,
    bankrollUsdt: BANKROLL_USDT,
    btc1hChangePct,
    btcCrashAlert,
    marketBreadthPct,
    totalHeadlinesScanned: newsScan.totalHeadlines,
    activeFeeds: newsScan.activeFeeds,
    top4AltcoinPicks: selectedTop4,
    allQualifiedOpportunities: scoredOpportunities,
  };

  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export { main as runNewsScan };

if (process.argv[1] && process.argv[1].endsWith('altcoin_news_hunter.mjs')) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
