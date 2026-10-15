# 🎯 AltcoinNewsHunter v5.0 — Canlı Haberden Bağlantılı Altcoin (Sympathy Play) & Otomatik Al-Sat Botu

6 küresel kripto haber kaynağını (`CoinTelegraph`, `Decrypt`, `CoinDesk`, `BeInCrypto`, `CryptoPotato`, `NewsBTC`) gerçek zamanlı tarayıp, **10 ekosistem ve 69 Binance altcoini** içinde haberi pozitif olup **fiyatı henüz yükselmemiş (`1s RSI < 45`)** bağlantılı altcoinleri otomatik satın alan, takip eden ve Kâr Al (`TP`) / İz Süren Stop (`Trailing SL`) ile otomatik satan Node.js tabanlı otonom sistem.

---

## 🚀 Evdeki Bilgisayarda Hızlı Kurulum (10 Saniye)

Herhangi bir dış paket (`npm install`) bile gerektirmez; doğrudan yerleşik Node.js (`v18+`) ile çalışır:

```bash
git clone https://github.com/Hanubaki/altcoin-news-hunter.git
cd altcoin-news-hunter

# 1. Sadece canlı haber + 69 altcoin fırsat taraması yapmak için:
npm run scan
# veya: node altcoin_news_hunter.mjs

# 2. Otomatik Al-Sat Motoru + Canlı Web Kontrol Panelini (http://localhost:3847) başlatmak için:
npm start
# veya: node altcoin_auto_trader.mjs --daemon
```

Tarayıcıdan **`http://localhost:3847`** adresini açarak canlı portföyü, açık pozisyonları, anlık Binance `Best Bid / Best Ask` fiyatlarını ve yakalanan haberleri izleyebilirsiniz.

---

## ⚙️ Gerçek Binance Hesabına Bağlama (`.env`)

Varsayılan olarak bot `REALTIME_ORDERBOOK_PAPER` modunda (gerçek Binance emir defteri alış/satış fiyatlarıyla sanal bakiye üzerinde) çalışır. Gerçek Binance Spot hesabınızla işlem yapması için:

1. `.env.example` dosyasını `.env` olarak kopyalayın:
   ```bash
   cp .env.example .env
   ```
2. `.env` içine Binance API anahtarlarınızı girin ve `LIVE_TRADING=true` yapın:
   ```env
   BINANCE_API_KEY=buraya_api_key
   BINANCE_SECRET_KEY=buraya_secret_key
   LIVE_TRADING=true
   BANKROLL_TRY=1000
   BANKROLL_USDT=28.01
   MAX_OPEN_POSITIONS=3
   ORDER_SIZE_USDT=7.50
   SCAN_INTERVAL_SECONDS=45
   ```
   > **Güvenlik Notu:** Binance API anahtarı oluştururken yalnızca **"Enable Spot & Margin Trading"** seçeneğini açın, **"Enable Withdrawals (Para Çekme)"** iznini kesinlikle kapalı tutun.
