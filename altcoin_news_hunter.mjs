#!/usr/bin/env node
/**
 * AltcoinNewsHunter v4.1 — High-Precision Breaking-News to Connected Altcoin (Sympathy Play) Engine
 *
 * Strict Catalyst Rules:
 * 1. Scans 6 global real-time crypto news feeds (CoinTelegraph, Decrypt, CoinDesk, BeInCrypto, CryptoPotato, NewsBTC)
 * 2. Strict Bullish Filter: Only genuine positive catalyst headlines score points (zero points for neutral noise;
 *    strict penalty for 'dips', 'slides', 'risks', 'outflows', 'slow', etc.)
 * 3. Top-Catalyst Ranking (No Generic BTC/ETH Volume Bias): Ecosystems are scored by their strongest breaking
 *    bullish catalysts rather than sheer article count
 * 4. Sympathy Lag Detection: Finds connected ecosystem altcoins that haven't pumped yet (1h RSI < 58)
 */

import fs from 'node:fs';
import path from 'node:path';

const BANKROLL_TRY = 1000;
const USD_TRY_RATE = 35.7;
const BANKROLL_USDT = Number((BANKROLL_TRY / USD_TRY_RATE).toFixed(2)); // $28.01 USDT

const BINANCE_API = 'https://api.binance.com/api/v3';
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
      'jp morgan', 'citibank', 'treasury', 'sec settlement',
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
      'open campus', 'binance labs',
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
  'buck', 'outperform', 'whale', 'listing', 'support', 'growth', 'advances', 'major',
  'date for', 'new', 'unveil', 'unveils', 'boost', 'boosts', 'jump', 'jumps',
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
      headers: { 'User-Agent': 'Mozilla/5.0 (AltcoinNewsHunter/4.1)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AltcoinNewsHunter/4.1',
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
      items.push({ source: sourceName, title, summary, minutesAgo });
    }
  }
  return items;
}

/**
 * Step 1: Fetch all 6 RSS feeds in parallel and score ONLY genuinely bullish catalysts
 */
async function scanAllNewsFeeds() {
  const feedResults = await Promise.allSettled(
    NEWS_FEEDS.map(f => fetchText(f.url, 3200).then(xml => parseRssFeed(xml, f.name)))
  );

  const headlines = [];
  const activeFeeds = [];
  feedResults.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.length > 0) {
      headlines.push(...res.value);
      activeFeeds.push(`${NEWS_FEEDS[idx].name} (${res.value.length})`);
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

    // Special handling for contrastive headlines like "Bitcoin ETFs shed $261M as XRP funds buck weekly outflow trend"
    const isContrastiveBull = titleLower.includes('buck') || titleLower.includes('despite') || titleLower.includes('defy');
    const netHeadlineSentiment = isContrastiveBull
      ? Math.max(1.5, bullHits - bearHits * 0.3)
      : bullHits - bearHits;

    // Strictly skip headlines that are not net-positive catalysts!
    if (netHeadlineSentiment <= 0.4) continue;

    const recencyWeight = item.minutesAgo <= 90 ? 1.7 : item.minutesAgo <= 240 ? 1.35 : item.minutesAgo <= 720 ? 1.0 : 0.65;

    for (const eco of ECOSYSTEM_GRAPH) {
      const titleKw = eco.keywords.filter(kw => titleLower.includes(kw));
      if (titleKw.length === 0) continue; // Strict headline relevance: keyword MUST be in the headline title!

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
        const catalystPoints = Number((netHeadlineSentiment * recencyWeight * (directMention ? 1.35 : 1.0)).toFixed(2));

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

  // Compute each altcoin's News Score from its Top 3 Strongest Bullish Headlines
  for (const alt of Object.keys(altCatalysts)) {
    const entry = altCatalysts[alt];
    entry.headlines.sort((a, b) => b.catalystPoints - a.catalystPoints);
    const top3Headlines = entry.headlines.slice(0, 3);
    entry.newsScore = Number(top3Headlines.reduce((sum, h) => sum + h.catalystPoints, 0).toFixed(2));
  }

  return {
    totalHeadlines: headlines.length,
    activeFeeds,
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

async function main() {
  const t0 = Date.now();
  console.log('================================================================================');
  console.log(`🎯 AltcoinNewsHunter v4.1 | 69 Altcoin Canlı Haber & Bağlantılı Coin Avcısı`);
  console.log(`   Sermaye: ${BANKROLL_TRY} TL (~$${BANKROLL_USDT} USDT) | Sadece Net Pozitif Haber + Fiyatlanmamış Altcoin`);
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

  console.log(`📰 [Haber Taraması]: ${newsScan.totalHeadlines} Son Dakika Haberi Tarandı`);
  console.log(`   Kaynaklar: ${newsScan.activeFeeds.join(' | ')}`);

  const tickerMap = {};
  for (const t of tickersRes || []) {
    const sym = t.symbol.replace(/USDT$/, '');
    tickerMap[sym] = {
      lastPrice: Number(t.lastPrice),
      change24hPct: Number(t.priceChangePercent),
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
      quoteVol24h: Number(t.quoteVolume),
    };
  }

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
    .slice(0, 20);

  const [btcKlinesRes, ...klineResults] = await Promise.allSettled([
    fetchJson(`${BINANCE_API}/klines?symbol=BTCUSDT&interval=15m&limit=5`, {}, 3500),
    ...positiveNewsAlts.map(c =>
      fetchJson(`${BINANCE_API}/klines?symbol=${c.symbol}USDT&interval=1h&limit=20`, {}, 3500)
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
    const change1hPct = closes.length >= 2
      ? Number((((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100).toFixed(2))
      : 0;
    const avgVol = volumes.length > 4
      ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
      : 1;
    const volRatio = Number(((volumes[volumes.length - 1] || avgVol) / Math.max(0.0001, avgVol)).toFixed(2));
    const fundingHourlyPct = hlMap[sym] ?? 0;

    const lagVsLeader24h = Number((leaderMkt.change24hPct - mkt.change24hPct).toFixed(2));

    // Anti-FOMO / Sell-The-News Guard
    if (rsi1h > 68 || change1hPct > 4.5 || mkt.change24hPct > 14) {
      continue;
    }

    let totalScore = Math.min(48, cat.newsScore * 5.0);
    if (rsi1h <= 34) totalScore += 26;
    else if (rsi1h <= 46) totalScore += 18;
    else if (rsi1h <= 58) totalScore += 10;

    if (lagVsLeader24h > 0.8) totalScore += Math.min(12, lagVsLeader24h * 2);
    if (fundingHourlyPct < 0) totalScore += 10;
    if (volRatio >= 1.1) totalScore += Math.min(8, (volRatio - 1) * 6);

    const rangePct = mkt.low24h > 0 ? ((mkt.high24h - mkt.low24h) / mkt.low24h) * 100 : 4;
    const tpPct = Number(Math.max(4.5, Math.min(8.5, rangePct * 0.65)).toFixed(2));
    // ATR Volatility Dynamic Stop-Loss (1.5x 1h ATR, bounded between 1.8% and 3.8%)
    const slPct = Number(Math.max(1.8, Math.min(3.8, atr1hPct * 1.5)).toFixed(2));

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
      atr1hPct,
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

  console.log(`🛡️ [BTC Çöküş Kalkanı]: BTC Son 1 Saat: %${btc1hChangePct} -> ${btcCrashAlert ? '🚨 ACİL FREN AKTİF (Alımlar Durduruldu!)' : '✅ PİYASA GÜVENLİ'}`);

  const allocPerCoinUsdt = 9.00;
  const allocPerCoinTry = Math.round(allocPerCoinUsdt * USD_TRY_RATE);

  selectedTop4.forEach((item, idx) => {
    const qty = Number((allocPerCoinUsdt / item.lastPrice).toPrecision(4));
    const netProfitUsdt = Number((allocPerCoinUsdt * (item.tpPct / 100)).toFixed(2));
    item.allocUsdt = allocPerCoinUsdt;
    item.allocTry = allocPerCoinTry;
    item.qty = qty;
    item.expectedProfitUsdt = netProfitUsdt;

    console.log(`\n${idx + 1}. 🎯 ${item.symbol}USDT (Lider: ${item.leaderSymbol}) — Skor: ${item.totalScore}/100 | 1s RSI: ${item.rsi1h} | ATR: %${item.atr1hPct}`);
    item.headlines.forEach(h => {
      console.log(`   • Haber [${h.source} - ${h.minutesAgo}dk önce]: "${h.title}"`);
    });
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - t0,
    bankrollTry: BANKROLL_TRY,
    bankrollUsdt: BANKROLL_USDT,
    btc1hChangePct,
    btcCrashAlert,
    totalHeadlinesScanned: newsScan.totalHeadlines,
    activeFeeds: newsScan.activeFeeds,
    top4AltcoinPicks: selectedTop4,
    allQualifiedOpportunities: scoredOpportunities,
  };

  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n✅ Tarama ${Date.now() - t0}ms içinde tamamlandı.`);
  return payload;
}

export { main as runNewsScan };

if (process.argv[1] && process.argv[1].endsWith('altcoin_news_hunter.mjs')) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
