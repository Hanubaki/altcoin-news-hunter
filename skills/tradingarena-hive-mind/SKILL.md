---
name: tradingarena-hive-mind
description: TradingArena.ai ve NOF1 Alpha Arena mimarisine dayalı 4-AI İttifakı (Hive-Mind Consensus), RSI Uyumsuzluğu (Divergence), Bollinger Sıkışması (Squeeze), ADX Trend Gücü, Destek/Direnç Pivotları ve Stop-Mesafesine Göre Risk Bazlı Kasa Yönetimi skill'i.
---

# TradingArena.ai & Alpha Arena Hive-Mind Trading Skill

Bu skill, `tradingarena.ai/ranking` ve `nof1.ai` (Alpha Arena) üzerindeki en yüksek kâr oranına sahip yapay zeka modellerinin (**Llama 4 Maverick**, **Llama 4 Scout**, **Gemini 3.5 Flash**, **Claude Opus 4.8**, **DeepSeek**, **Qwen**) kullandığı kurumsal karar mekanizmasını projeye uygular.

## 1. TradingArena.ai Nasıl Çalışır? (Temel Mimari)
1. **Ham Grafik Yerine Sayısal İndikatör Özeti (Deep Market Vision):**
   - Yapay zeka modellerine rastgele resim gösterilmez; her döngüde `RSI (14)`, `RSI Uyumsuzluğu (Divergence)`, `MACD (12,26,9)`, `EMA 20 vs EMA 50`, `Bollinger Bant Sıkışması (%B & Bandwidth)`, `ADX (14) Trend Gücü` ve `Destek/Direnç (Support/Resistance)` seviyeleri hesaplanıp yapılandırılmış JSON olarak verilir.
2. **4-Model Hive-Mind Consensus (Yapay Zeka İttifakı):**
   - Tek bir stratejiye güvenmek yerine 4 farklı uzman AI karakteri aynı coini oylar:
     - **Llama 4 Maverick (Momentum & Trend):** `EMA20 > EMA50`, `MACD Bullish`, `Bollinger Squeeze` ve hacim patlamasına bakar.
     - **Llama 4 Scout (%81 İsabetli Dip Avcısı):** `RSI < 50`, `RSI Pozitif Uyumsuzluk (Bullish Divergence)` ve dirence olan mesafeye (`Room to Resistance`) bakar.
     - **Gemini 3.5 Flash (Haber & Katalizör Hızı):** Son dakika haber puanı, Binance resmi duyuruları ve CoinGecko Trend verisine bakar.
     - **Claude Opus 4.8 (Balina Akışı & Risk Kalkanı):** `Whale Taker Buy Ratio (%50+)`, dipten dönüş mumu ve negatif fonlama (Short Squeeze) verisine bakar.
3. **Stop Mesafesine Göre Risk Bazlı Pozisyon Büyüklüğü (Risk-Based Sizing):**
   - Her işleme körü körüne sabit para yatırmak yerine, sinyalin **AI İttifak Oyu (`3/4` veya `4/4`)** ve **Stop-Loss yakınlığına** göre kasa payı ayarlanır.
