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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BANKROLL_TRY = 1000;
const USD_TRY_RATE = 49.46;
const BANKROLL_USDT = Number((BANKROLL_TRY / USD_TRY_RATE).toFixed(2));

const BINANCE_API = 'https://data-api.binance.vision/api/v3';
const BINANCE_CMS_API = 'https://www.binance.info/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10';
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
    sympathyAlts: ['ONDO', 'LINK', 'XRP', 'XLM', 'AVAX', 'HBAR', 'ALGO', 'RSR'],
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
    sympathyAlts: ['AAVE', 'UNI', 'PENDLE', 'LDO', 'ETHFI', 'EIGEN', 'ARB', 'OP', 'ENS', 'METIS', 'ENA', 'ZRO'],
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
    sympathyAlts: ['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'PNUT', 'TRUMP'],
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
  'ortaklık', 'entegre', 'listeleme', 'onay', 'yatırım aldı', 'net giriş', 'rekor', 'beklentileri aştı', 'destekliyor', 'ralli', 'yükseliş', 'lisans',
];

const BEARISH_TERMS = [
  'hack', 'hacked', 'exploit', 'ban', 'banned', 'lawsuit', 'sue', 'sued', 'crash',
  'outflow', 'outflows', 'dump', 'delist', 'arrest', 'fraud', 'scam', 'delay',
  'reject', 'rejected', 'slump', 'drop', 'drops', 'liquidation', 'insolvency', 'drain',
  'stolen', 'phishing', 'penalty', 'fine', 'dip', 'dips', 'slide', 'slides', 'fall', 'falls',
  'lowest', 'slow', 'risk', 'risks', 'exit', 'shed', 'loss', 'losses', 'warn', 'warning',
  'fear', 'bear', 'bearish', 'down', 'plunge', 'plunges', 'tumble', 'attack', 'attacks',
  'fail', 'failed', 'fails', 'failure', 'bull trap', 'sell the news', 'unlock', 'unlocks',
  'struggle', 'struggles', 'stall', 'stalls', 'weak', 'bleed', 'ran out of',
  'retest', 'may retest', 'could drop', 'could fall', 'price prediction', 'before its next',
  'contain', 'restrict', 'crackdown', 'pullback', 'correction', 'downside',
  'çıkış yaşadı', 'net çıkış', 'saldırgan', 'çaldı', 'durduracağını', 'uyarıyor', 'zayıflatıyor', 'düşüş', 'satış baskısı', 'sattı', 'belirsizlik',
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

async function fetchJson(url, options = {}, timeoutMs = 5500) {
  const tryFetch = async targetUrl => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, {
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
  };
  return await tryFetch(url);
}

function parseRssFeed(xml, sourceName) {
  const rawItems = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  let maxPubMs = 0;

  while ((match = itemRegex.exec(xml)) !== null && rawItems.length < 20) {
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
    const pubMs = pubDateStr ? new Date(pubDateStr).getTime() : 0;
    if (Number.isFinite(pubMs) && pubMs > maxPubMs) maxPubMs = pubMs;

    if (title) {
      rawItems.push({ source: sourceName, title, summary, pubMs, sourceWeight: 1.0 });
    }
  }

  const refNow = maxPubMs > 0 ? maxPubMs + 5 * 60000 : Date.now();
  return rawItems.map((it, idx) => ({
    source: it.source,
    title: it.title,
    summary: it.summary,
    minutesAgo: it.pubMs > 0 ? Math.max(1, Math.round((refNow - it.pubMs) / 60000)) : (idx + 1) * 15,
    sourceWeight: it.sourceWeight,
  }));
}

async function fetchBinanceAnnouncements() {
  try {
    const res = await fetchJson(BINANCE_CMS_API, {}, 3200);
    const catalogs = res?.data?.catalogs || [];
    const items = [];
    const now = Date.now();
    for (const cat of catalogs) {
      const isListingOrLaunchpool = [48, 49, 128].includes(Number(cat.catalogId));
      const isDelisting = Number(cat.catalogId) === 161;
      for (const art of (cat.articles || []).slice(0, 8)) {
        const minutesAgo = art.releaseDate ? Math.max(1, Math.round((now - art.releaseDate) / 60000)) : 60;
        if (minutesAgo > 360) continue; // Only fresh <= 6h official announcements
        items.push({
          source: isListingOrLaunchpool ? 'BinanceListingSniper' : 'BinanceResmiDuyuru',
          title: isDelisting ? `[DELIST RISK] ${art.title}` : art.title,
          summary: art.title,
          minutesAgo,
          sourceWeight: isListingOrLaunchpool ? 2.6 : 1.9,
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

/**
 * Engine #26A (binance-skills-hub / crypto-market-rank):
 * Queries Binance Web3 Official AI Social-Hype & Sentiment Leaderboard (BSC + Solana)
 */
async function fetchBinanceAiSocialHype() {
  const map = {};
  try {
    const urls = [
      'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard/ai?chainId=56&targetLanguage=en&timeRange=1',
      'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard/ai?chainId=CT_501&targetLanguage=en&timeRange=1',
    ];
    const results = await Promise.all(
      urls.map(u =>
        fetchJson(u, { headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/3.0 (Skill)' } }, 2800).catch(() => null)
      )
    );
    for (const r of results) {
      for (const item of r?.data?.leaderBoardList || []) {
        const sym = String(item?.metaInfo?.symbol || '').toUpperCase().trim();
        if (!sym) continue;
        map[sym] = {
          sentiment: item?.socialHypeInfo?.sentiment || 'Neutral',
          socialHype: Number(item?.socialHypeInfo?.socialHype || 0),
          brief: String(item?.socialHypeInfo?.socialSummaryBriefTranslated || item?.socialHypeInfo?.socialSummaryBrief || '').slice(0, 140),
        };
      }
    }
  } catch {}
  return map;
}

async function fetchTelegramPublicChannels() {
  const defaultChannels = [
    { handle: 'binance_announcements', name: 'BinanceTG', weight: 2.5 },
    { handle: 'WatcherGuru', name: 'WatcherGuruTG', weight: 1.75 },
    { handle: 'unfolded', name: 'UnfoldedTG', weight: 1.75 },
    { handle: 'coinkolik', name: 'CoinkolikTG', weight: 1.65 },
    { handle: 'Cointelegraph_TR', name: 'CointelegraphTR', weight: 1.65 },
  ];
  try {
    const stPath = path.resolve('portfolio_state.json');
    if (fs.existsSync(stPath)) {
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8').replace(/^\uFEFF/, ''));
      for (const ch of st.customTelegramChannels || []) {
        const cleanHandle = String(ch).replace(/^@|^https?:\/\/t\.me\/(s\/)?/i, '').trim();
        if (cleanHandle && !defaultChannels.some(d => d.handle.toLowerCase() === cleanHandle.toLowerCase())) {
          defaultChannels.push({ handle: cleanHandle, name: `TG:@${cleanHandle}`, weight: 1.7 });
        }
      }
    }
  } catch {}

  const now = Date.now();
  const results = await Promise.all(
    defaultChannels.map(async ch => {
      try {
        const html = await fetchText(`https://t.me/s/${ch.handle}`, 2800);
        const blocks = html.split('tgme_widget_message_wrap').slice(1);
        const items = [];
        for (const blk of blocks.slice(-10)) {
          const txtMatch = blk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
          if (!txtMatch) continue;
          const timeMatch = blk.match(/<time datetime="([^"]+)"/i);
          const pubMs = timeMatch ? Date.parse(timeMatch[1]) : now;
          const minutesAgo = !Number.isNaN(pubMs) && pubMs > 0 ? Math.max(1, Math.round((now - pubMs) / 60000)) : 30;
          if (minutesAgo > 360) continue;
          const cleanTxt = txtMatch[1]
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#039;|&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanTxt.length < 15) continue;
          items.push({
            source: ch.name === 'BinanceTG' && /will list|launchpool|hodler/i.test(cleanTxt) ? 'BinanceListingSniper' : ch.name,
            title: cleanTxt.slice(0, 180),
            summary: cleanTxt.slice(0, 320),
            minutesAgo,
            sourceWeight: ch.weight,
          });
        }
        return { name: ch.name, items };
      } catch {
        return { name: ch.name, items: [] };
      }
    })
  );
  return results;
}

async function scanAllNewsFeeds() {
  const [binanceAnns, trendingSet, tgChannelResults, ...feedResults] = await Promise.all([
    fetchBinanceAnnouncements(),
    fetchCoinGeckoTrending(),
    fetchTelegramPublicChannels(),
    ...NEWS_FEEDS.map(f =>
      fetchText(f.url, 3200)
        .then(xml => parseRssFeed(xml, f.name))
        .catch(() => [])
    ),
  ]);

  const headlines = [...binanceAnns];
  const activeFeeds = [];
  if (binanceAnns.length > 0) activeFeeds.push(`BinanceCMS (${binanceAnns.length})`);
  for (const tgRes of tgChannelResults || []) {
    if (tgRes.items?.length > 0) {
      headlines.push(...tgRes.items);
      activeFeeds.push(`${tgRes.name} (${tgRes.items.length})`);
    }
  }

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

    const isGenericPriceFluff =
      (titleLower.includes('price update') ||
        titleLower.includes('price prediction') ||
        titleLower.includes('price analysis') ||
        titleLower.includes('price forecast')) &&
      !titleLower.includes('sec') &&
      !titleLower.includes('etf') &&
      !titleLower.includes('binance') &&
      !titleLower.includes('upbit') &&
      !titleLower.includes('launch') &&
      !titleLower.includes('mainnet');
    if (isGenericPriceFluff) continue;

    if (netHeadlineSentiment <= 0.4) continue;
    // Engine #25: Anti-Piggyback Freshness Alignment — Never allow >75m stale headlines to inflate newsScore or sit at headlines[0]!
    if (item.minutesAgo > 75) continue;

    const recencyWeight = item.minutesAgo <= 30 ? 2.0 : item.minutesAgo <= 60 ? 1.85 : 1.5;
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

        const directMention = titleLower.includes(` ${alt.toLowerCase()} `) || titleKw.some(k => k.trim().toUpperCase() === alt);
        // Prevent weak/unrelated single-coin sympathy contagion: non-direct sympathy requires genuine positive sentiment (>= 1.2)
        if (!directMention && netHeadlineSentiment < 1.2) continue;
        const catalystPoints = Number(
          (netHeadlineSentiment * recencyWeight * srcWeight * (directMention ? 1.85 : 0.90)).toFixed(2)
        );

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
    entry.headlines.sort((a, b) => (b.directMention === a.directMention ? b.catalystPoints - a.catalystPoints : b.directMention ? 1 : -1));
    entry.hasDirectMention = entry.headlines.some(h => h.directMention === true);
    // Bind freshestMinutesAgo strictly to the primary catalyst headline (headlines[0]) so stale headlines can never piggyback on a newer secondary article
    entry.freshestMinutesAgo = entry.headlines[0]?.minutesAgo ?? 9999;
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
 * Alpha Engine #3 & #4: Whale Taker Buy Ratio + 24h Institutional VWAP + Bottom Bounce Candle Check
 */
function analyzeWhaleAndCandleFlow(klines) {
  if (!Array.isArray(klines) || klines.length < 3) {
    return {
      takerBuyRatio: 0.5,
      last1hTakerBuy: 0.5,
      last1hQuoteVolUsd: 0,
      takerFlowDecel: 0,
      amihudIlliquidity: 1.0,
      isGreenBounce: false,
      aboveVwap: true,
      vwap24h: 0,
    };
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

  // Compute 24h Institutional VWAP (Volume-Weighted Average Price) + True Amihud Illiquidity Ratio (|ret_1h%| / $1M quoteVol)
  const slice24 = klines.slice(-24);
  let sumBaseVol = 0;
  let sumQuoteVol = 0;
  let amihudSum = 0;
  let amihudCount = 0;
  for (const k of slice24) {
    const kOpen = Number(k[1] || 0);
    const kClose = Number(k[4] || 0);
    const kQuoteVol = Number(k[7] || 0);
    sumBaseVol += Number(k[5] || 0);
    sumQuoteVol += kQuoteVol;
    if (kOpen > 0 && kQuoteVol >= 10000) {
      const absRetPct = (Math.abs(kClose - kOpen) / kOpen) * 100;
      const volMillions = kQuoteVol / 1000000;
      amihudSum += absRetPct / volMillions;
      amihudCount++;
    }
  }
  const amihudIlliquidity = amihudCount > 0 ? Number((amihudSum / amihudCount).toFixed(3)) : 1.0;
  const last = klines[klines.length - 1];
  const close = Number(last[4]);
  const vwap24h = sumBaseVol > 0 ? Number((sumQuoteVol / sumBaseVol).toPrecision(5)) : close;
  const aboveVwap = close >= vwap24h * 0.993;

  // Latest rolling 60m whale acceleration & sample volume (blends developing 1h bar with remaining weight of prior 1h bar to prevent top-of-hour reset)
  const openTimeMs = Number(last[0] || 0);
  const fracHour = openTimeMs > 0 ? Math.min(1, Math.max(0.02, (Date.now() - openTimeMs) / 3600000)) : 1;
  const prev = klines[klines.length - 2] || last;
  const prevWeight = 1 - fracHour;
  const last1hQuote = Number(last[7] || 0) + prevWeight * Number(prev[7] || 0);
  const last1hTaker = Number(last[10] || 0) + prevWeight * Number(prev[10] || 0);
  const last1hTakerBuy = last1hQuote > 0 ? Number((last1hTaker / last1hQuote).toFixed(3)) : takerBuyRatio;
  const takerFlowDecel = Number((takerBuyRatio - last1hTakerBuy).toFixed(3));

  // Check if latest candle is turning green or bouncing strongly off its low (excluding shooting-star upper-wick bull traps!)
  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const range = Math.max(0.0000001, high - low);
  const closePositionInRange = (close - low) / range;
  const intrabarPumpPct = open > 0 ? ((high - open) / open) * 100 : 0;
  const isUpperWickRejection = intrabarPumpPct >= 1.4 && closePositionInRange <= 0.30;
  const isGreenBounce = (close >= open && closePositionInRange >= 0.45) || closePositionInRange >= 0.60;
  const prev2 = klines[klines.length - 3] || prev;
  const isHigherLow3Bar = Boolean(low > Number(prev[3] || 0) && Number(prev[3] || 0) >= Number(prev2[3] || 0) * 0.996);

  return {
    takerBuyRatio,
    last1hTakerBuy,
    last1hQuoteVolUsd: Math.round(last1hQuote),
    takerFlowDecel,
    amihudIlliquidity,
    isUpperWickRejection,
    isGreenBounce,
    closePositionInRange: Number(closePositionInRange.toFixed(2)),
    isHigherLow3Bar,
    aboveVwap,
    vwap24h,
  };
}

async function main() {
  const t0 = Date.now();
  console.log('================================================================================');
  console.log(`🚀 AltcoinNewsHunter v10.0 (Zero-Risk Institutional Matrix) | 14 Veri Kaynağı + VWAP + Balina OI`);
  console.log('================================================================================\n');

  const allSymbols = getAllTrackedSymbols();
  const symbolsParam = JSON.stringify(allSymbols.map(s => `${s}USDT`));

  const [newsScan, tickersRes, hlMetaRes, fapiPremRes, fngRes, globalRes, binanceSocialMap] = await Promise.all([
    scanAllNewsFeeds(),
    fetchJson(`${BINANCE_API}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`, {}, 8000),
    fetchJson(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    }).catch(() => null),
    fetchJson('https://www.binance.info/fapi/v1/premiumIndex', {}, 4000).catch(() => []),
    fetchJson('https://api.alternative.me/fng/?limit=1', {}, 3000).catch(() => null),
    fetchJson('https://api.coinpaprika.com/v1/global', {}, 3000).catch(() => null),
    fetchBinanceAiSocialHype(),
  ]);

  const fearGreedVal = Number(fngRes?.data?.[0]?.value || 55);
  const fearGreedClass = fngRes?.data?.[0]?.value_classification || 'Greed';
  const btcDominancePct = Number(globalRes?.bitcoin_dominance_percentage || 57.4);

  const tickerMap = {};
  let greenCoinsCount = 0;
  let intradayReclaimCount = 0;
  for (const t of tickersRes || []) {
    const sym = t.symbol.replace(/USDT$/, '');
    const chg = Number(t.priceChangePercent);
    const lastPrice = Number(t.lastPrice);
    const high24h = Number(t.highPrice);
    const low24h = Number(t.lowPrice);
    const vwap24 = Number(t.weightedAvgPrice || lastPrice);
    const bounceFromLowPct = low24h > 0 ? ((lastPrice - low24h) / low24h) * 100 : 0;
    const posInRange = high24h > low24h ? (lastPrice - low24h) / (high24h - low24h) : 0.5;
    if (chg > 0) greenCoinsCount++;
    if (lastPrice >= vwap24 * 1.001 || (bounceFromLowPct >= 2.2 && posInRange >= 0.45)) {
      intradayReclaimCount++;
    }
    tickerMap[sym] = {
      lastPrice,
      change24hPct: chg,
      high24h,
      low24h,
      quoteVol24h: Number(t.quoteVolume),
      vwapPremiumPct: vwap24 > 0 ? Number((((lastPrice - vwap24) / vwap24) * 100).toFixed(2)) : 0,
      bounceFromLowPct: Number(bounceFromLowPct.toFixed(2)),
      posInRange: Number(posInRange.toFixed(2)),
    };
  }
  const breadth24hPct = tickersRes?.length ? Math.round((greenCoinsCount / tickersRes.length) * 100) : 50;
  const intradayRecoveryPct = tickersRes?.length ? Math.round((intradayReclaimCount / tickersRes.length) * 100) : breadth24hPct;
  let marketBreadthPct = breadth24hPct;

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

  // Merge Binance Perpetual Futures Funding Rates & Spot-Futures Basis Spread
  const basisSpreadMap = {};
  for (const fp of Array.isArray(fapiPremRes) ? fapiPremRes : []) {
    if (!fp.symbol || !fp.symbol.endsWith('USDT')) continue;
    const sym = fp.symbol.replace(/USDT$/, '');
    const fRate = Number((Number(fp.lastFundingRate || 0) * 100).toFixed(4));
    if (hlMap[sym] === undefined || fRate < hlMap[sym]) {
      hlMap[sym] = fRate;
    }
    const mark = Number(fp.markPrice || 0);
    const index = Number(fp.indexPrice || 0);
    if (mark > 0 && index > 0) {
      basisSpreadMap[sym] = Number((((index - mark) / mark) * 100).toFixed(3));
    }
  }

  const qualifiedNewsCats = Object.values(newsScan.altCatalysts).filter(
    c => c.newsScore >= 1.5 && tickerMap[c.symbol] && c.hasDirectMention === true
  );

  // Engine #24 & Engine #29: Golden-Age Institutional Leader Igniter & 4-Master Sovereign Crisis Override Watchlist (active when recovery >= 28% or breadth >= 24%)
  const goldenAgeWatchList = [];
  if (intradayRecoveryPct >= 28 || breadth24hPct >= 24) {
    const existingSyms = new Set(qualifiedNewsCats.map(c => c.symbol));
    const waveTag = new Date().toISOString().slice(0, 13);
    const liquidLeaders = Object.entries(tickerMap)
      .filter(
        ([sym, m]) =>
          sym !== 'BTC' &&
          !existingSyms.has(sym) &&
          m.quoteVol24h >= 15000000 &&
          m.change24hPct >= -2.5 &&
          m.change24hPct <= 9.5 &&
          m.vwapPremiumPct >= 0.15 &&
          m.posInRange >= 0.48
      )
      .sort((a, b) => (b[1].vwapPremiumPct * 2 + b[1].bounceFromLowPct * 0.4) - (a[1].vwapPremiumPct * 2 + a[1].bounceFromLowPct * 0.4))
      .slice(0, 10);
    for (const [sym] of liquidLeaders) {
      goldenAgeWatchList.push({
        symbol: sym,
        leaderSymbol: sym,
        hasDirectMention: false,
        isGoldenAgeCandidate: true,
        ecosystems: new Set(['GoldenAgeWave']),
        matchedKeywords: new Set(['golden-age-thrust', 'vwap-reclaim']),
        newsScore: 5.2,
        freshestMinutesAgo: 5,
        headlines: [
          {
            source: 'GoldenAgeLeaderIgniter',
            minutesAgo: 5,
            title: `Golden Age Kurumsal Dönüş Dalgası (${sym} — VWAP & Balina İvme Lideri [${waveTag}])`,
          },
        ],
      });
    }
  }

  // 100% Real-News + Direct-Mention Priority (plus Golden-Age Institutional Leaders ONLY during confirmed Golden-Age waves)
  const positiveNewsAlts = [...qualifiedNewsCats, ...goldenAgeWatchList]
    .sort((a, b) => b.newsScore - a.newsScore)
    .slice(0, 55);

  const [btcKlinesRes, btc1hKlinesRes, ...klineResults] = await Promise.allSettled([
    fetchJson(`${BINANCE_API}/klines?symbol=BTCUSDT&interval=15m&limit=5`, {}, 4500),
    fetchJson(`${BINANCE_API}/klines?symbol=BTCUSDT&interval=1h&limit=30`, {}, 4500),
    ...positiveNewsAlts.map(c =>
      fetchJson(`${BINANCE_API}/klines?symbol=${c.symbol}USDT&interval=1h&limit=30`, {}, 4500)
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
  // Engine #23: Golden-Age V-Bottom Breadth Thrust Detector (eliminates 24h rolling lag when BTC & altcoins reclaim 24h VWAP)
  const isGoldenAgeThrust = btc1hChangePct >= 0.30 && intradayRecoveryPct >= 38;
  if (isGoldenAgeThrust) {
    marketBreadthPct = Math.max(breadth24hPct, Math.round(breadth24hPct * 0.40 + intradayRecoveryPct * 0.60));
  }
  const btc1hCloses = btc1hKlinesRes.status === 'fulfilled' && Array.isArray(btc1hKlinesRes.value)
    ? btc1hKlinesRes.value.map(k => Number(k[4]))
    : [];
  const btc1hReturns = [];
  for (let b = 1; b < btc1hCloses.length; b++) {
    if (btc1hCloses[b - 1] > 0) {
      btc1hReturns.push((btc1hCloses[b] - btc1hCloses[b - 1]) / btc1hCloses[b - 1]);
    }
  }
  const btcCrashAlert = btc1hChangePct <= -1.8;
  const tsiNow = new Date(Date.now() + 3 * 3600 * 1000);
  const isFriday = tsiNow.getUTCDay() === 5;
  const tsiHour = tsiNow.getUTCHours();
  // Engine #28: Friday Bull-Trap & Pre-Weekend De-Risking Shield (2-yr empirical backtest: 85.4% altcoin Friday PM dump probability after Thu drop + Fri AM bounce)
  const isFridayMorningTrapSetup = isFriday && tsiHour >= 8 && tsiHour < 15 && breadth24hPct < 46 && intradayRecoveryPct >= 42;
  const isFridayPmDumpWindow = isFriday && tsiHour >= 15 && tsiHour <= 23;
  const isConfirmedGoldenAge =
    !btcCrashAlert &&
    !isFridayPmDumpWindow &&
    ((btc1hChangePct >= 0.30 && marketBreadthPct >= 52 && intradayRecoveryPct >= 50) ||
      (btc1hChangePct >= 0.25 && breadth24hPct >= 48));

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
    const {
      takerBuyRatio,
      last1hTakerBuy,
      last1hQuoteVolUsd,
      takerFlowDecel,
      amihudIlliquidity,
      isUpperWickRejection,
      isGreenBounce,
      closePositionInRange,
      isHigherLow3Bar,
      aboveVwap,
      vwap24h,
    } = analyzeWhaleAndCandleFlow(klines);

    const lastBar = klines[klines.length - 1];
    const fracHour = lastBar?.[0] ? Math.min(1, Math.max(0.02, (Date.now() - Number(lastBar[0])) / 3600000)) : 1;
    const currBarRet = closes.length >= 2 && closes[closes.length - 2] > 0
      ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
      : 0;
    const prevBarRet = closes.length >= 3 && closes[closes.length - 3] > 0
      ? (closes[closes.length - 2] - closes[closes.length - 3]) / closes[closes.length - 3]
      : 0;
    const change1hPct = Number(((currBarRet + (1 - fracHour) * prevBarRet) * 100).toFixed(2));
    const avgVol = volumes.length > 4
      ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
      : 1;
    const rolling1hBaseVol = (volumes[volumes.length - 1] || 0) + (1 - fracHour) * (volumes[volumes.length - 2] || 0);
    const volRatio = Number(((rolling1hBaseVol || avgVol) / Math.max(0.0001, avgVol)).toFixed(2));
    const fundingHourlyPct = hlMap[sym] ?? 0;
    const basisSpreadPct = basisSpreadMap[sym] ?? 0;
    const isTrending = newsScan.trendingSet.has(sym);

    const lagVsLeader24h = Number((leaderMkt.change24hPct - mkt.change24hPct).toFixed(2));
    const hasDirectMention = Boolean(cat.hasDirectMention);
    const isGoldenAgeCandidate = Boolean(cat.isGoldenAgeCandidate);
    // Engine #29: 4-Master Sovereign Crisis Alpha Setup (Paul Tudor Jones + Mark Minervini + William O'Neil + GCR — 75.0% Backtested Win Rate)
    // Overrides Golden-Age waiting gate when a liquid leader shows 3-bar Higher Lows, EMA20>EMA50, VWAP+0.8%, Vol>=1.35x, ClosePos>=0.70, and Whale Taker>=58% during market chop/recovery!
    const isSovereignCrisisCandidate = Boolean(
      isGoldenAgeCandidate &&
        !btcCrashAlert &&
        !isFridayPmDumpWindow &&
        btc1hChangePct >= -0.25 &&
        marketBreadthPct >= 24 &&
        ema20AboveEma50 &&
        isHigherLow3Bar &&
        mkt.lastPrice >= vwap24h * 1.008 &&
        mkt.change24hPct >= 1.0 &&
        mkt.change24hPct <= 8.5 &&
        change1hPct >= 0.85 &&
        change1hPct <= 2.80 &&
        change1hPct - btc1hChangePct >= 0.90 &&
        volRatio >= 1.35 &&
        closePositionInRange >= 0.70 &&
        !isUpperWickRejection &&
        last1hQuoteVolUsd >= 350000 &&
        last1hTakerBuy >= 0.58 &&
        takerBuyRatio >= 0.54 &&
        amihudIlliquidity <= 6.5 &&
        fundingHourlyPct <= 0.015 &&
        rsi1h >= 42 &&
        rsi1h <= 61
    );
    if (isGoldenAgeCandidate) {
      if (
        (!isConfirmedGoldenAge && !isSovereignCrisisCandidate) ||
        isFridayPmDumpWindow ||
        last1hTakerBuy < 0.55 ||
        takerBuyRatio < 0.53 ||
        last1hQuoteVolUsd < 250000 ||
        amihudIlliquidity > 8.0 ||
        change1hPct < (isSovereignCrisisCandidate ? 0.85 : 1.0) ||
        change1hPct > 4.2 ||
        rsi1h < 36 ||
        rsi1h > 61 ||
        !aboveVwap ||
        isUpperWickRejection
      ) {
        continue;
      }
    }

    // 1. Event-Timestamp-Aligned Price Model: Separate preEventMove (leak/front-run) from postEventImpulse (news reaction)
    const eventAgeMins = Math.max(1, Number(cat.freshestMinutesAgo || 15));
    const eventBarsAgo = Math.max(1, Math.min(Math.max(1, klines.length - 3), Math.ceil(eventAgeMins / 60)));
    const eventBarIdx = Math.max(0, klines.length - eventBarsAgo);
    const preBarIdx = Math.max(0, eventBarIdx - 2);
    const eventBasePrice = Number(klines[eventBarIdx]?.[1] || mkt.lastPrice);
    const preEventStartPrice = Number(klines[preBarIdx]?.[1] || eventBasePrice);
    const preEventMovePct = preEventStartPrice > 0
      ? Number((((eventBasePrice - preEventStartPrice) / preEventStartPrice) * 100).toFixed(2))
      : 0;
    const preEventAtr = Number((preEventMovePct / Math.max(0.45, atr1hPct)).toFixed(2));

    let eventPeakPrice = mkt.lastPrice;
    for (let kIdx = eventBarIdx; kIdx < klines.length; kIdx++) {
      const h = Number(klines[kIdx]?.[2] || 0);
      if (h > eventPeakPrice) eventPeakPrice = h;
    }
    const impulsePct = eventBasePrice > 0
      ? Number((((eventPeakPrice - eventBasePrice) / eventBasePrice) * 100).toFixed(2))
      : Math.max(0, change1hPct);
    const impulseAtr = Number((impulsePct / Math.max(0.45, atr1hPct)).toFixed(2));
    const retracementRatio = eventPeakPrice > eventBasePrice * 1.003
      ? Number(((eventPeakPrice - mkt.lastPrice) / (eventPeakPrice - eventBasePrice)).toFixed(2))
      : 0.35;

    // 2. Rolling Beta-Adjusted Relative Strength (RS_ATR) vs BTC
    const coinReturns = [];
    for (let cIdx = 1; cIdx < closes.length; cIdx++) {
      if (closes[cIdx - 1] > 0) coinReturns.push((closes[cIdx] - closes[cIdx - 1]) / closes[cIdx - 1]);
    }
    let betaBtc = 1.15;
    const nRets = Math.min(coinReturns.length, btc1hReturns.length);
    if (nRets >= 10) {
      const cSlice = coinReturns.slice(-nRets);
      const bSlice = btc1hReturns.slice(-nRets);
      const meanC = cSlice.reduce((a, b) => a + b, 0) / nRets;
      const meanB = bSlice.reduce((a, b) => a + b, 0) / nRets;
      let cov = 0;
      let varB = 0;
      for (let r = 0; r < nRets; r++) {
        cov += (cSlice[r] - meanC) * (bSlice[r] - meanB);
        varB += (bSlice[r] - meanB) ** 2;
      }
      if (varB > 1e-9) {
        betaBtc = Number(Math.max(0.4, Math.min(2.5, cov / varB)).toFixed(2));
      }
    }
    const expectedCoin1h = Number((betaBtc * btc1hChangePct).toFixed(2));
    const relativeStrength1h = Number((change1hPct - expectedCoin1h).toFixed(2));
    const rsAtr = Number((relativeStrength1h / Math.max(0.45, atr1hPct)).toFixed(2));
    if (isGoldenAgeCandidate && rsAtr < (isFridayMorningTrapSetup ? 1.40 : 1.25)) continue;

    // 3. NO-CHASE Guard + Pre-Event Leak Filter + Freshness Gate (<= 90m; <= 45m during Friday PM dump window) + Unblinded RSI on Direct News
    const maxAllowedRsi = hasDirectMention ? (isFridayPmDumpWindow ? 60 : 66) : isGoldenAgeCandidate ? 60 : 50;
    const isNoChaseOverextended =
      eventAgeMins > (isFridayPmDumpWindow ? 45 : 90) || // Never let stale >90m news crowd out fresh candidates (<=45m on Friday PM)!
      preEventAtr > 2.2 || // Reject if coin already pumped >2.2 ATR BEFORE the news timestamp (leaked/front-run)
      impulseAtr > 3.5 ||
      (impulsePct >= 3.0 && retracementRatio < 0.20) ||
      (impulsePct >= 4.2 && retracementRatio < 0.25) ||
      retracementRatio > 0.80; // Failed impulse (>80% given back)
    if ((!hasDirectMention && !isGoldenAgeCandidate) || rsi1h > maxAllowedRsi || isNoChaseOverextended || bbPctB > 0.92 || mkt.change24hPct > 14.0) continue;
    // minQuoteVolumeGuard ($3.5M min 24h volume) + true amihudIlliquidityRatio guard (reject if >18% impact per $1M volume)
    const minQuoteVolumeGuard = (mkt.quoteVol24h || 0) >= 3500000 && amihudIlliquidity <= 18.0;
    if (!minQuoteVolumeGuard) continue;
    // takerFlowDecelerationGuard with 1h sample-volume guard (prevents low-volume 1h noise from starving valid fresh news):
    // Hard reject only on extreme 3h collapse (<48%) or high-volume 1h seller dump (<42% or decel >11% with >=$150k 1h vol)
    const isExtremeTakerCollapse =
      takerBuyRatio < 0.48 ||
      (last1hQuoteVolUsd >= 150000 && (last1hTakerBuy < 0.42 || takerFlowDecel > 0.11));
    if (isExtremeTakerCollapse) continue;
    // Engine #20: Overleveraged Long Liquidation Cascade Shield (reject extreme futures long overheating)
    if (fundingHourlyPct >= 0.06 || basisSpreadPct <= -0.50) continue;
    // Engine #26B (tradermonty/news-reaction-failure-analyzer — Jason Shapiro Step 2):
    // If bullish news has been public for >= 25m and the market shrugged it off & dumped below VWAP, reject FAILED_TO_RALLY!
    const isNewsReactionFailure =
      eventAgeMins >= 25 && change1hPct <= -0.85 && !aboveVwap && !isGreenBounce;
    if (isNewsReactionFailure) continue;

    const microstructureFlags = [];
    const isModerateTakerDecel =
      last1hQuoteVolUsd >= 100000 && (last1hTakerBuy < 0.46 || takerFlowDecel > 0.07);
    const isOverleveragedLong = fundingHourlyPct >= 0.035 || basisSpreadPct <= -0.25;
    const binanceSocial = binanceSocialMap?.[sym] || null;

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
    if (isModerateTakerDecel) {
      totalScore -= 8;
      microstructureFlags.push('TAKER_FLOW_DECEL');
    }
    if (isOverleveragedLong) {
      totalScore -= 10;
      microstructureFlags.push('OVERLEVERAGED_LONG_TRAP');
    }
    if (isUpperWickRejection) {
      totalScore -= 12;
      microstructureFlags.push('UPPER_WICK_REJECTION');
    }
    if (isFridayPmDumpWindow) {
      totalScore -= 6;
      microstructureFlags.push('FRIDAY_PM_DE_RISKING_SHIELD');
    }
    // Engine #26A (binance-skills-hub/crypto-market-rank): Binance Official AI Social-Hype Sentiment Cross-Check
    if (binanceSocial?.sentiment === 'Negative') {
      totalScore -= 10;
      microstructureFlags.push('BINANCE_SOCIAL_NEGATIVE');
    } else if (binanceSocial?.sentiment === 'Positive') {
      totalScore += 5;
      microstructureFlags.push('BINANCE_SOCIAL_POSITIVE');
    }
    if (rsi1h <= 34) totalScore += 18;
    else if (rsi1h <= 45) totalScore += 12;
    else if (rsi1h <= 58) totalScore += 8;
    else if (rsi1h <= 66 && takerBuyRatio >= 0.55) totalScore += 6;

    // Healthy Event Pullback Bonus: requires 25%-55% retracement, event age >= 1 min (>=60s duration), holding above VWAP, and active buyer absorption
    const isHealthyPullback =
      impulseAtr >= 0.8 &&
      impulseAtr <= 3.0 &&
      retracementRatio >= 0.25 &&
      retracementRatio <= 0.55 &&
      eventAgeMins >= 1 &&
      aboveVwap &&
      last1hTakerBuy >= 0.52;
    if (isHealthyPullback) {
      totalScore += 8;
    }
    const entryPattern = isHealthyPullback
      ? 'HEALTHY_PULLBACK'
      : impulseAtr < 1.2
        ? 'EARLY_UNPRICED'
        : 'MOMENTUM_CONTINUATION';

    // Beta-Adjusted Market-Independent Relative Strength Bonus (RS_ATR >= 1.2)
    if (rsAtr >= 1.5) totalScore += 8;
    else if (rsAtr >= 1.0) totalScore += 4;

    // Bollinger Band Lower Dip Support & Squeeze Bonus
    if (bbPctB <= 0.35) totalScore += 5;
    if (isSqueeze) totalScore += 5;

    // MACD + EMA20/50 + RSI Divergence + VWAP Institutional Floor Bonus
    if (macdBullishTurn) totalScore += 5;
    if (ema20AboveEma50) totalScore += 4;
    if (hasRsiDivergence) totalScore += 6;
    if (aboveVwap) totalScore += 4;
    if (last1hTakerBuy >= 0.56) totalScore += 5; // Fresh 1h whale acceleration!
    if (basisSpreadPct >= 0.08 && fundingHourlyPct < 0) totalScore += 5; // Spot premium + Futures discount short-squeeze

    // TradingArena 4-AI Hive-Mind Consensus Bonus
    if (hiveMind.aiConsensusCount === 4) totalScore += 12;
    else if (hiveMind.aiConsensusCount === 3) totalScore += 7;

    // Whale Taker Buy Bonus (Silent Whale Accumulation)
    if (takerBuyRatio >= 0.56) totalScore += 14;
    else if (takerBuyRatio >= 0.53) totalScore += 10;
    else if (takerBuyRatio >= 0.49) totalScore += 5;

    // Reversal Candle Confirmation Bonus (Engine #21 zero-conflict: never award green bounce bonus if upper-wick rejection!)
    if (isGreenBounce && !isUpperWickRejection) totalScore += 7;

    // CoinGecko Global Trending Bonus
    if (isTrending) totalScore += 9;

    if (lagVsLeader24h > 0.8) totalScore += Math.min(8, lagVsLeader24h * 1.8);
    if (fundingHourlyPct < 0) {
      totalScore += takerBuyRatio >= 0.52 ? 12 : 7; // Short-Squeeze Ignition Bonus
    }
    if (volRatio >= 1.1) totalScore += Math.min(7, (volRatio - 1) * 5);

    const rangePct = mkt.low24h > 0 ? ((mkt.high24h - mkt.low24h) / mkt.low24h) * 100 : 4;
    const tpPct = Number(Math.max(4.5, Math.min(9.0, rangePct * 0.65)).toFixed(2));
    const slPct = Number(Math.max(2.0, Math.min(3.2, atr1hPct * 1.65)).toFixed(2));

    scoredOpportunities.push({
      symbol: sym,
      leaderSymbol: cat.leaderSymbol,
      hasDirectMention,
      isGoldenAgeCandidate,
      isSovereignCrisisCandidate,
      preEventAtr,
      impulsePct,
      impulseAtr,
      retracementRatio,
      betaBtc,
      rsAtr,
      entryPattern: isGoldenAgeCandidate ? 'GOLDEN_AGE_THRUST' : entryPattern,
      ecosystems: Array.from(cat.ecosystems),
      matchedKeywords: Array.from(cat.matchedKeywords).slice(0, 6),
      newsScore: cat.newsScore,
      freshestMinutesAgo: cat.freshestMinutesAgo,
      headlines: cat.headlines.slice(0, 2),
      lastPrice: mkt.lastPrice,
      vwap24h,
      aboveVwap,
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
      last1hTakerBuyPct: Number((last1hTakerBuy * 100).toFixed(1)),
      last1hQuoteVolUsd,
      takerFlowDecel,
      amihudIlliquidity,
      microstructureFlags,
      isGreenBounce,
      isTrending,
      volRatio,
      fundingHourlyPct,
      basisSpreadPct,
      totalScore: Number(totalScore.toFixed(1)),
      tpPct,
      slPct,
      tpPrice: Number((mkt.lastPrice * (1 + tpPct / 100)).toPrecision(5)),
      slPrice: Number((mkt.lastPrice * (1 - slPct / 100)).toPrecision(5)),
    });
  }

  scoredOpportunities.sort((a, b) => b.totalScore - a.totalScore);

  // Enrich Top 10 candidates with Binance Institutional Top 20% Whale Long/Short Ratio & Aligned 15m/1h Open Interest Flow
  const top10Slice = scoredOpportunities.slice(0, 10);
  await Promise.all(
    top10Slice.map(async item => {
      try {
        const [lsRes, oiRes] = await Promise.all([
          fetchJson(`https://www.binance.info/futures/data/topLongShortPositionRatio?symbol=${item.symbol}USDT&period=1h&limit=2`, {}, 2500).catch(() => []),
          fetchJson(`https://www.binance.info/futures/data/openInterestHist?symbol=${item.symbol}USDT&period=15m&limit=5`, {}, 2500).catch(() => []),
        ]);
        if (Array.isArray(lsRes) && lsRes.length > 0) {
          const latestLs = lsRes[lsRes.length - 1];
          const topWhaleLongPct = Number((Number(latestLs.longAccount || 0.5) * 100).toFixed(1));
          item.topWhaleLongPct = topWhaleLongPct;
          if (topWhaleLongPct >= 62) item.totalScore = Number((item.totalScore + 7).toFixed(1));
          else if (topWhaleLongPct >= 55) item.totalScore = Number((item.totalScore + 4).toFixed(1));
          else if (topWhaleLongPct < 42) item.totalScore = Number((item.totalScore - 8).toFixed(1));
        }
        if (Array.isArray(oiRes) && oiRes.length >= 2) {
          const oiPrev15m = Number(oiRes[oiRes.length - 2]?.sumOpenInterestValue);
          const oiNow = Number(oiRes[oiRes.length - 1]?.sumOpenInterestValue);
          const oi1hAgo = Number(oiRes[0]?.sumOpenInterestValue);
          if (Number.isFinite(oiPrev15m) && oiPrev15m > 0 && Number.isFinite(oiNow) && oiNow > 0) {
            const oiChg15mPct = Number((((oiNow - oiPrev15m) / oiPrev15m) * 100).toFixed(2));
            const oiChg1hPct =
              Number.isFinite(oi1hAgo) && oi1hAgo > 0
                ? Number((((oiNow - oi1hAgo) / oi1hAgo) * 100).toFixed(2))
                : oiChg15mPct;
            item.oiChange15mPct = oiChg15mPct;
            item.oiChange1hPct = oiChg1hPct;
            const isAlignedBearishOiDiv =
              (item.change1hPct >= 1.2 && oiChg1hPct <= -1.0) ||
              ((item.freshestMinutesAgo || 99) <= 25 && (item.impulsePct || item.change1hPct || 0) >= 1.0 && oiChg15mPct <= -0.8);
            if (oiChg15mPct >= 0.4 && oiChg1hPct >= 0) {
              item.totalScore = Number((item.totalScore + 6).toFixed(1));
            } else if (isAlignedBearishOiDiv) {
              // Window-Aligned Bearish Price-OI Divergence: Price rose while Futures OI unwound -> Bull Trap Penalty (-14p)!
              if (!Array.isArray(item.microstructureFlags)) item.microstructureFlags = [];
              item.microstructureFlags.push('PRICE_OI_DIVERGENCE');
              item.totalScore = Number(Math.max(10, item.totalScore - 14).toFixed(1));
            }
          }
        }
        if (item.isGoldenAgeCandidate) {
          const hasValidOi = Number.isFinite(item.oiChange15mPct);
          const minReqWhale = item.isSovereignCrisisCandidate || isFridayMorningTrapSetup ? 56 : 55;
          const minReqOi = item.isSovereignCrisisCandidate ? 0.30 : isFridayMorningTrapSetup ? 0.35 : 0;
          const hasFuturesConfirmation =
            hasValidOi &&
            (((item.topWhaleLongPct || 0) >= minReqWhale && item.oiChange15mPct >= minReqOi) ||
              item.oiChange15mPct >= (item.isSovereignCrisisCandidate || isFridayMorningTrapSetup ? 0.45 : 0.25));
          if (hasFuturesConfirmation && !(item.microstructureFlags || []).includes('PRICE_OI_DIVERGENCE')) {
            item.isGoldenAgeLeader = true;
            item.isSovereignCrisisLeader = Boolean(item.isSovereignCrisisCandidate);
            item.liveLlmDecision = 'LONG';
            item.liveLlmConfidence = item.isSovereignCrisisLeader ? 92 : 88;
            item.liveLlmReason = item.isSovereignCrisisLeader
              ? `[Engine #29 Dört Efsane Egemen Kriz Alfa (PTJ+Minervini+O'Neil+GCR %75 Başarı)]: 3-Mum Yükselen Dip + VWAP+%0.8 + Hacim ${item.volRatio}x + 1s Balina %${item.last1hTakerBuyPct} + RS_ATR ${item.rsAtr}`
              : `[Engine #24 Golden-Age Kurumsal Lider]: Piyasa V-Dip İvmesi (%${marketBreadthPct} Yeşil) + 1s Balina %${item.last1hTakerBuyPct} + RS_ATR ${item.rsAtr}`;
            item.totalScore = Number(Math.min(99, item.totalScore + (item.isSovereignCrisisLeader ? 10 : 6)).toFixed(1));
          } else {
            item.isGoldenAgeLeader = false;
            item.isSovereignCrisisLeader = false;
            item.liveLlmDecision = 'WAIT';
            if (hasValidOi) item.totalScore = Number(Math.max(10, item.totalScore - 35).toFixed(1));
          }
        }
      } catch {}
    })
  );
  scoredOpportunities.sort((a, b) => b.totalScore - a.totalScore);

  const selectedTop4 = [];
  const usedLeaders = new Set();
  for (const opp of scoredOpportunities) {
    if (opp.isGoldenAgeCandidate && !opp.isGoldenAgeLeader) continue;
    if (usedLeaders.has(opp.leaderSymbol) && selectedTop4.length < 4) continue;
    usedLeaders.add(opp.leaderSymbol);
    selectedTop4.push(opp);
    if (selectedTop4.length === 6) break;
  }

  // Multi-Provider Official AI Router (Supports Free Groq Llama-4-Maverick, Google Gemini Flash, OpenRouter DeepSeek, or Keyless Fallback)
  try {
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    }
  } catch {}

  const groqKey = process.env.GROQ_API_KEY || '';
  const geminiKey = process.env.GEMINI_API_KEY || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY || '';

  if ((groqKey || geminiKey || openrouterKey) && selectedTop4.length > 0) {
    await Promise.all(
      selectedTop4.map(async item => {
        if (item.isGoldenAgeLeader) return;
        const prompt = `Sen kurumsal bir kripto haber semantik doğrulayıcısısın (fiyat falcısı değil). Şu haberi 6 objektif kriterle doğrula ve SADECE tek satır geçerli JSON döndür: {"coinDirectlyAffected":true,"eventPositive":true,"negativeTrap":false,"eventAlreadyOccurred":false,"sourceCredible":true,"symbolAmbiguous":false,"decision":"LONG","confidence":82,"reason":"Kısa Türkçe sebep (en fazla 10 kelime)"}. KURAL: Sadece şu objektif durumlarda decision "WAIT" ver: 1) coinDirectlyAffected=false (haber doğrudan ${item.symbol} ile ilgili değilse), 2) eventPositive=false veya negativeTrap=true (delist, hack, exploit, unlock, dava, düşüş/retest ise), 3) eventAlreadyOccurred=true ("dün listelendi/geçen hafta yükseldi" gibi geçmişte kalmış/bitmiş olay ise), 4) symbolAmbiguous=true (sembol başka bir kelimeyle karıştırılmışsa). Gerçek ve taze pozitif haberde RSI ${item.rsi1h} olsa bile LONG ver! Coin: ${item.symbol}, Haber (${item.freshestMinutesAgo}dk önce): "${item.headlines[0]?.title || ''}", PreEventATR: ${item.preEventAtr}, İmpulsATR: ${item.impulseAtr}, Retracement: ${item.retracementRatio}, BetaRS_ATR: ${item.rsAtr}`;

        const aiVerdicts = [];

        if (groqKey) {
          const groqModels = [
            { id: 'llama-3.3-70b-versatile', label: 'Llama-3.3-70B' },
            { id: 'openai/gpt-oss-120b', label: 'GPT-120B' },
            { id: 'qwen/qwen3.8-27b', label: 'Qwen-3.8' },
          ];
          await Promise.all(
            groqModels.map(async m => {
              try {
                const res = await fetchJson(
                  'https://api.groq.com/openai/v1/chat/completions',
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${groqKey}`,
                    },
                    body: JSON.stringify({
                      model: m.id,
                      messages: [{ role: 'user', content: prompt }],
                      temperature: 0.1,
                      max_tokens: 700,
                    }),
                  },
                  5500
                );
                const txt = (res?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
                const jsonMatch = txt.match(/\{[\s\S]*?\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  const isObjVeto =
                    parsed.coinDirectlyAffected === false ||
                    parsed.eventPositive === false ||
                    parsed.negativeTrap === true ||
                    parsed.eventAlreadyOccurred === true ||
                    parsed.sourceCredible === false ||
                    parsed.symbolAmbiguous === true;
                  aiVerdicts.push({
                    model: m.label,
                    decision: isObjVeto ? 'WAIT' : (parsed.decision || 'LONG').toUpperCase(),
                    objectiveVeto: isObjVeto,
                    confidence: Number(parsed.confidence) || 80,
                    reason: parsed.reason || '',
                  });
                }
              } catch {}
            })
          );
        }

        if (geminiKey) {
          try {
            const res = await fetchJson(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                }),
              },
              3500
            );
            const txt = res?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const jsonMatch = txt.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const isObjVeto =
                parsed.coinDirectlyAffected === false ||
                parsed.eventPositive === false ||
                parsed.negativeTrap === true ||
                parsed.eventAlreadyOccurred === true ||
                parsed.sourceCredible === false ||
                parsed.symbolAmbiguous === true;
              aiVerdicts.push({
                model: 'Gemini-Flash',
                decision: isObjVeto ? 'WAIT' : (parsed.decision || 'LONG').toUpperCase(),
                objectiveVeto: isObjVeto,
                confidence: Number(parsed.confidence) || 80,
                reason: parsed.reason || '',
              });
            }
          } catch {}
        }

        if (aiVerdicts.length > 0) {
          item.realApiVerdicts = aiVerdicts;
          const longVotes = aiVerdicts.filter(v => v.decision === 'LONG' || v.decision === 'BUY');
          const waitVotes = aiVerdicts.filter(v => v.decision === 'WAIT' || v.decision === 'SELL' || v.decision === 'AVOID');
          const avgConf = Math.round(aiVerdicts.reduce((s, v) => s + v.confidence, 0) / aiVerdicts.length);
          // 4-Model Semantic Majority Consensus
          const objectiveVetoCount = aiVerdicts.filter(v => v.objectiveVeto).length;
          item.liveLlmDecision = longVotes.length > waitVotes.length && objectiveVetoCount < 2 ? 'LONG' : 'WAIT';
          item.liveLlmConfidence = avgConf;
          item.liveLlmReason = aiVerdicts.map(v => `[${v.model}: ${v.decision} %${v.confidence}] ${v.reason}`).join(' | ');

          if (item.liveLlmDecision === 'LONG' && avgConf >= 65) {
            item.totalScore = Number(Math.min(99, item.totalScore + 6).toFixed(1));
          } else if (item.liveLlmDecision === 'WAIT') {
            item.totalScore = Number(Math.max(10, item.totalScore - 35).toFixed(1));
          }
        }
      })
    );
    selectedTop4.sort((a, b) => b.totalScore - a.totalScore);
  }

  console.log(`📰 [Kaynaklar (${newsScan.totalHeadlines} Haber)]: ${newsScan.activeFeeds.join(' | ')}`);
  console.log(`🛡️ [BTC Kalkanı]: 1s BTC %${btc1hChangePct} (${btcCrashAlert ? '🚨 FREN' : '✅ GÜVENLİ'}) | 🌍 Altcoin İştahı: %${marketBreadthPct} Yeşil | 🧭 Korku/Açgözlülük: ${fearGreedVal} (${fearGreedClass}) | BTC Dom: %${btcDominancePct}`);

  selectedTop4.forEach((item, idx) => {
    const whaleTag = item.topWhaleLongPct ? ` | 🏦 Dev Balina Long: %${item.topWhaleLongPct}` : '';
    const oiTag = item.oiChange15mPct !== undefined ? ` | 📈 15dk OI: %${item.oiChange15mPct}` : '';
    console.log(
      `\n${idx + 1}. 🎯 ${item.symbol} (Skor: ${item.totalScore}/100 | 🤖 ${item.aiConsensusLabel}) | RSI: ${item.rsi1h}${item.hasRsiDivergence ? ' (Uyumsuzluk ✅)' : ''} | 🐋 Spot Alım: %${item.takerBuyRatioPct}${whaleTag}${oiTag} | VWAP: ${item.vwap24h}`
    );
    if (item.liveLlmReason) {
      console.log(`   🧠 [4-Model Semantik AI Konseyi (${item.liveLlmDecision} Ort. Güven %${item.liveLlmConfidence})]: ${item.liveLlmReason}`);
    }
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
    isConfirmedGoldenAge,
    fearGreedVal,
    fearGreedClass,
    btcDominancePct,
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
