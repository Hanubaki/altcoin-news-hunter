# AltcoinNewsHunter v4.1 — Canlı Haberden Bağlantılı Altcoin (Sympathy Play) Avcısı (`RAPOR.md`)

**Son Güncelleme:** 2026-10-15T14:21:15+03:00  
**Odak:** %100 Canlı Kripto Haber Katalizörü $\rightarrow$ Henüz Fiyatlanmamış Bağlantılı Altcoin Tespiti  
**Hedef Kasa:** `1.000 TL` (`~$28.01 USDT`)

---

## 1. Sistem Mimarisi ([altcoin_news_hunter.mjs](file:///c:/Users/berke/Documents/antigravity/modest-faraday/altcoin_news_hunter.mjs))

Önceki simülasyon ve yan araçlar tamamen temizlendi. Sistem artık yalnızca **son dakika haberlerinden bağlantılı altcoin yakalama (Sympathy Play)** üzerine kurulu:

1. **Çoklu Canlı Haber Motoru (`92+ Son Dakika Haberi / <4sn`):**
   - `CoinTelegraph`, `Decrypt`, `CoinDesk`, `BeInCrypto`, `CryptoPotato`, `NewsBTC` RSS akışlarını paralel tarar.
   - **Sıkı Pozitif Katalizör Filtresi:** Nötr ve düşüş (`dip`, `slide`, `outflow`, `hack`, `risk`, `exit`) haberlerini eler; sadece net pozitif kurumsal/teknolojik katalizörleri puanlar.
2. **10 Ekosistem & 69 Binance Altcoin Ağı (`ECOSYSTEM_GRAPH`):**
   - **Yapay Zeka & GPU:** `FET`, `RENDER`, `TAO`, `NEAR`, `ARKM`, `WLD`, `IO`, `THETA`, `GRT`, `ICP`
   - **Solana & DEX Likidite:** `JUP`, `RAY`, `PYTH`, `JTO`, `BONK`, `WIF`, `BOME`
   - **RWA, BlackRock, Swift & Kurumsal Fonlar:** `ONDO`, `LINK`, `XRP`, `XLM`, `AVAX`, `HBAR`, `ALGO`, `OM`, `RSR`
   - **Ethereum DeFi, Restaking & Layer-2:** `AAVE`, `UNI`, `PENDLE`, `LDO`, `ETHFI`, `EIGEN`, `ARB`, `OP`, `ENS`, `METIS`
   - **Move VM & Yeni Nesil L1:** `SUI`, `APT`, `SEI`, `TIA`, `INJ`
   - **Web3 Oyun (GameFi) & Metaverse:** `IMX`, `GALA`, `SAND`, `AXS`, `BEAMX`, `PIXEL`, `RONIN`, `PORTAL`
   - **DePIN & Bulut Depolama:** `FIL`, `AR`, `IOTX`, `JASMY`
   - **Bitcoin Layer-2, Ordinals & BTC DeFi:** `STX`, `ORDI`, `RUNE`, `BCH`, `LTC`
   - **Elon Musk, X & Meme Katalizörleri:** `DOGE`, `SHIB`, `PEPE`, `FLOKI`, `PNUT`
   - **BNB Chain & Borsa Ekosistemi:** `CAKE`, `TWT`, `ID`, `EDU`
3. **Gecikme (Sympathy Lag) & Anti-FOMO Koruması:**
   - Haberi çıkan ekosistemdeki altcoinlerin Binance 1 saatlik `RSI` değerini ve Hyperliquid vadeli fonlama oranını (`Funding Rate`) anlık çeker.
   - Coin zaten yükselmişse (`RSI > 68` veya `1s Değişim > +%4.5`) **Tepe Tuzak Koruması** devreye girer ve o coini eler.
   - Sadece **haberi pozitif olup fiyatı henüz tepki vermemiş (`RSI < 40`, vadeli fonlaması negatif/nötr)** altcoinleri seçer.

---

## 2. Canlı Taramada Yakalanan Fırsatlar ([altcoin_news_signals.json](file:///c:/Users/berke/Documents/antigravity/modest-faraday/altcoin_news_signals.json))

| Sıra | Altcoin | Bağlantılı Ekosistem | Yakalanan Canlı Haber Katalizörü | Giriş Fiyatı & 1s RSI | 1.000 TL Kasa Payı | Hedef Kâr Al (TP) / Zarar Kes (SL) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **`AVAXUSDT`** | RWA, BlackRock & Kurumsal Fonlar (Lider: `XRP`) | *"13 Weeks of XRP ETF Inflows"* & *"XRP funds buck weekly outflow trend"* | `$9.539` (`RSI: 28.91` \| Fonlama: `%-0.0038/s`) | **`$6.00` (`~214 TL`)** (`0.629 AVAX`) | **TP:** `$10.149` (`+%6.39`)<br>**SL:** `$9.2462` (`-%3.07`) |
| **2** | **`PENDLEUSDT`** | Ethereum DeFi & Restaking (Lider: `ETH`) | *"Babylon advances native Bitcoin lending proposal on Aave V4"* | `$1.925` (`RSI: 27.32` \| Fonlama: `%0.0013/s`) | **`$6.00` (`~214 TL`)** (`3.117 PENDLE`) | **TP:** `$2.0694` (`+%7.50`)<br>**SL:** `$1.8596` (`-%3.40`) |
| **3** | **`STXUSDT`** | Bitcoin Layer-2 & BTC DeFi (Lider: `BTC`) | *"Babylon advances native Bitcoin lending proposal"* & *"Move Over, Saylor, New Top Buyer"* | `$0.3984` (`RSI: 33.52` \| Fonlama: `%0.0013/s`) | **`$6.00` (`~214 TL`)** (`15.06 STX`) | **TP:** `$0.4283` (`+%7.50`)<br>**SL:** `$0.3849` (`-%3.40`) |

---

## 3. Nasıl Çalıştırılır?

Terminalden istediğin an tek komutla canlı tarama yapabilirsin:
```powershell
node altcoin_news_hunter.mjs
```

---

## 4. Otomatik Al-Sat Motoru & Canlı Web Paneli ([altcoin_auto_trader.mjs](file:///c:/Users/berke/Documents/antigravity/modest-faraday/altcoin_auto_trader.mjs))

### A. Çalışma Mekanizması (`v5.0`)
1. **Otomatik Alım (Buy Execution):**
   - Her 45 saniyede bir [altcoin_news_hunter.mjs](file:///c:/Users/berke/Documents/antigravity/modest-faraday/altcoin_news_hunter.mjs) üzerinden 6 haber kaynağını ve 69 altcoini tarar.
   - Fırsat skoru `>= 58/100` olan ve aynı ekosistemden çakışmayan altcoinleri **canlı Binance Emir Defteri (`Best Ask`)** fiyatından otomatik satın alır.
2. **Otomatik Satış (TP / SL / İz Süren Trailing Stop):**
   - Her döngüde açık pozisyonların canlı `Best Bid` (anlık satılabilir tahta fiyatı) değerini kontrol eder.
   - **İz Süren Kâr Kilidi (Trailing Stop):** Bir altcoin giriş fiyatının **`+%2.2`** üzerine çıktığı anda Stop-Loss seviyesini otomatik olarak girişin **`+%0.6` üstüne (kâr kilidine)** taşır ve tepe fiyatın `%1.8` gerisinden takip eder. Böylece kâra geçen hiçbir işlem zararla kapanmaz.
   - Fiyat `Take-Profit` veya `Stop-Loss` seviyesine değdiği anda otomatik satışı gerçekleştirir ve kârı kasaya (`cashUsdt`) ekler.
3. **Çift Mod Desteği ([.env.example](file:///c:/Users/berke/Documents/antigravity/modest-faraday/.env.example)):**
   - **Canlı Tahta Test Modu (`LIVE_TRADING=false` - Varsayılan):** Gerçek Binance tahtasındaki `Best Bid` / `Best Ask` fiyatlarıyla kuruşu kuruşuna [portfolio_state.json](file:///c:/Users/berke/Documents/antigravity/modest-faraday/portfolio_state.json) üzerinde otomatik al-sat yapar.
   - **Gerçek Binance Hesabı Modu (`LIVE_TRADING=true`):** `.env` dosyasına `BINANCE_API_KEY` ve `BINANCE_SECRET_KEY` girildiğinde HMAC-SHA256 imzalı gerçek `POST /api/v3/order` (`MARKET`) emirleri gönderir.
4. **Canlı Web Kontrol Paneli:**
   - Arka planda `http://localhost:3847` adresinde çalışır. Tarayıcıdan açıldığında anlık portföy değerini, açık pozisyonları, yakalanan haberleri ve satış geçmişini canlı gösterir.
