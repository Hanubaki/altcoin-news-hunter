# Workspace Rules — AltcoinAutoTrader & AltcoinNewsHunter (`modest-faraday`)

## Zero-Conflict & Cross-Engine Harmonization Rule (Mandatory)
1. **End-to-End Cross-Engine Verification:** Any change in `altcoin_news_hunter.mjs` or `altcoin_auto_trader.mjs` MUST be verified against all interacting engines before going live:
   - **Scanner Gate vs. Execution Gate:** Freshness limits (`<=45–75m`), `directMention === true`, RSI ceilings, and 4-Model AI Council (`liveLlmDecision`) quotas must never starve valid fresh candidates or allow stale candidates through.
   - **TP1/TP2 vs. Ratchet Stop Ladder:** Pre-TP1 ratchet floors (`+0.46%` net breakeven+) must never choke a position at intermediate levels (`+1.1%` / `+2.0%`) before `TP1` (`pos.tp1Pct`) is harvested. Upper ratchet steps (`3.2%`, `4.5%`, `7.0%`) only activate after `pos.partialTpDone === true`.
   - **Main Loop (`runTradingCycle`) vs. 4-Second Fast Loop (`runFastPositionRiskTick`):** Both loops must execute identical `BINANCE_TR` fail-closed quote guards, identical `processProfitTargets`, identical ratchet ladders, and identical `Slow-Bleed` / `Time-Deterministic Stop` confirmations.
   - **Exchange Constraints (`LOT_SIZE` & `MIN_NOTIONAL >= 55 TL`):** Never split a position into a partial sell or moonbag below `55 TL` on Binance TR; lock the full position stop instead so no unsellable dust is created.
   - **Lifecycle Accounting:** `winCount`, `lossCount`, Bayes `n`, and the 45-minute Global Circuit Breaker must always be computed from completed position lifecycles (`positionId` grouping `TP1 + TP2 + FINAL`), never inflated by individual partial legs.

## Skill-First Execution & Explicit Announcement Rule (Mandatory)
1. **Check Skills Before Action:** Before starting any task, bug fix, audit, or feature, check all installed skills (`superpowers`, `ponytail`, and custom skills) first and read the matching `SKILL.md`.
2. **Announce Active Skill(s):** Whenever a skill is used, explicitly state which skill(s) were used at the top of the response (`🛠️ Kullanılan Skill: <skill-adı>`).

## Devil's Advocate & Anti-Sycophancy Risk Audit Rule (Mandatory)
1. **Never Blindly Agree with User Proposals (`Körü Körüne Onaylama Yasağı`):** When the user proposes or asks about a trading strategy, position sizing change, leverage/concentration idea, or architectural change, NEVER act as a "yes-man" (`sycophant`) that only highlights the upside to please the user.
2. **Mandatory Downside & Ruin Research First (`Önce Batma/Zarar Senaryosu Araştırması`):** Before recommending or implementing any strategy or parameter change, automatically research and present in the very first response:
   - **Historical Blow-Up Cases (`Batanlar & Neden Battıkları`):** Real-world failure modes (e.g., stop-loss slippage in thin order books, flash crashes, consecutive loss drawdowns, Kelly overbetting ruin).
   - **Exchange Microstructure Reality (`Binance TR _TRY Gerçekliği`):** How the idea behaves under actual `_TRY` order book depth, spread, and fee/slippage friction (`0.44%+`), not just idealized textbook math.
   - **Objective Verdict (`Net ve Dürüst Karar`):** If an idea carries asymmetric ruin risk or contradicts proven quantitative rules, push back directly and state why it is dangerous on the very first turn, without waiting for the user to ask "batan var mı?".
