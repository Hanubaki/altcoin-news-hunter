# GPT-6-Luna & Antigravity Brainstorming Spec: Leverage v8.6 (Engine #38 Two-Snapshot Microprice/Spoof Gate & Engine #39 Contract-Specific Funding Settlement Guard)

**Date:** 2026-10-24  
**Authors:** Antigravity & GPT-6-Luna (`codex.exe exec` session `01a16c9a-181f-73c3-9c56-ad5c91b53daa`)  
**Target System:** `leverage-3x-system/leverage_3x_trader.mjs` (`Mutlak-Yapi-v8.6-300TL-Luna-Microprice-Funding`)

---

## 1. Context & Problem Statement
Our 300 TL Fixed-Principal (`3x / 3.5x / 4x` Anti-Wick Leverage + Spot Profit Vault) system is actively trading (`ALTUSDT` closed at `+0.96 TL` -> Spot Vault `+14.97 TL`; `IOSTUSDT` 3.5x LONG active). Through joint brainstorming with `GPT-6-Luna`, we identified two critical microstructure gaps:

1. **Orderbook Spoof-Decay & Single-Snapshot Microprice Vulnerability (`fetchPerpOrderbookConfirm`):**
   - Previously, `fetchPerpOrderbookConfirm` only evaluated `microSkew` on the second snapshot (`d2`) and averaged depth imbalance (`avgOb = (ob1 + ob2)/2`) without bounding `ob2 - ob1` (`Spoof-Decay`) or checking `d2.lastUpdateId >= d1.lastUpdateId` and `bookHollowing` (`bestBid2 < bestBid1 && bestAsk2 > bestAsk1`).
2. **Global BTC Funding Clock Assumption vs. Contract-Specific 2h/4h/8h Schedules:**
   - Previously, `minsToNextFunding` was read only from `BTCUSDT` (`btcPrem.nextFundingTime`), ignoring that many altcoin perpetuals settle every 2 or 4 hours via their own `prem.nextFundingTime`.

---

## 2. Mathematical Specification (Approved Option A1: Approach A + Narrow B)

### 2.1 Engine #38: Two-Snapshot Perp Microprice & Spoof-Decay Confirmation (`1.8s` Interval)
For snapshots $k \in \{1, 2\}$ taken $\Delta t = 1800\text{ ms}$ apart:
- Sequence continuity guard: $\text{lastUpdateId}_2 \ge \text{lastUpdateId}_1$.
- Size-weighted microprice and normalized touch skew:
  $$\mu_k = \frac{a_k Q^b_k + b_k Q^a_k}{Q^b_k + Q^a_k}, \qquad m_k = \frac{a_k + b_k}{2}, \qquad x_k = \frac{\mu_k - m_k}{(a_k - b_k)/2} \in [-1, 1]$$
- Exponential distance-weighted 15-level book imbalance $I_k \in [-1, 1]$ (`ob1`, `ob2`).
- Book hollowing veto: reject if $b_2 < b_1 \land a_2 > a_1$.
- Directional spoof-decay veto ($d = +1$ for LONG, $d = -1$ for SHORT):
  $$d \cdot (I_2 - I_1) \ge -0.10$$
- Directional microprice & depth persistence gate:
  - **LONG ($d = +1$):** $\bar{I} \ge 0.05$, $I_2 \ge 0.02$, $x_2 \ge -0.08$, and $\neg(x_1 < -0.10 \land x_2 < 0)$.
  - **SHORT ($d = -1$):** $\bar{I} \le -0.05$, $I_2 \le -0.02$, $x_2 \le 0.08$, and $\neg(x_1 > 0.10 \land x_2 > 0)$.

### 2.2 Engine #39: Contract-Specific `nextFundingTime` Settlement Cost & Pre-Settlement Dump Guard
For each perpetual contract $i$, compute remaining minutes to its own settlement timestamp $T_{\text{fund}, i}$:
$$m_i = \max\left(0, \text{round}\left(\frac{T_{\text{fund}, i} - t_{\text{now}}}{60000}\right)\right)$$
- **Entry Guard (Narrow B):**
  - Block new **LONG** if $f_i \ge +0.080\%$, OR ($m_i \le 15 \land f_i \ge +0.035\%$ — avoids paying imminent funding), OR ($m_i \le 12 \land f_i \le -0.35\%$ — avoids buying right before post-settlement funding-farmer dump).
  - Block new **SHORT** if $f_i \le -0.120\%$, OR ($m_i \le 15 \land f_i \le -0.035\%$ — avoids paying imminent negative funding).
- **Open Position Pre-Settlement Profit Protection:**
  - If an open position has $m_i \le 5$ minutes to settlement, is in net profit ($\text{rawCoinMoveFrac} \ge \text{FEE\_SLIP} + 0.0015$), and faces either imminent funding payment ($\ge 0.05\%$) or extreme negative-funding farmer dump risk ($f_i \le -0.40\%$ pre-TP1), harvest profit before the settlement clock boundary.
