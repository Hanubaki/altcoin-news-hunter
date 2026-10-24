# Leverage v8.6 (Luna Brainstorming: Engine #38 & Engine #39) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `leverage-3x-system/leverage_3x_trader.mjs` to `v8.6` with Engine #38 (`Two-Snapshot Perp Microprice & Spoof-Decay Gate`) and Engine #39 (`Contract-Specific nextFundingTime Settlement Cost & Dump Shield`).

**Architecture:** Enhance `fetchPerpOrderbookConfirm` with `1.8s` dual-snapshot microprice ($x_1, x_2$), `lastUpdateId` monotonicity, `bookHollowing`, and `spoofDecay` ($\delta_I = 0.10$) checks. Wire per-contract `nextFundingTime` (`minsToFunding`) from Binance `/fapi/v1/premiumIndex` into `scanPerpUniverse` and `manageOpenPosition`.

**Tech Stack:** Node.js ESM (`leverage-3x-system/leverage_3x_trader.mjs`), Binance USDT-M Futures REST API (`/fapi/v1/depth`, `/fapi/v1/premiumIndex`).

---

### Task 1: Implement Engine #38 (`Two-Snapshot Perp Microprice & Spoof-Decay Gate`)
**Files:**
- Modify: `leverage-3x-system/leverage_3x_trader.mjs:980-1016`
- [x] **Step 1:** Update interval to `1800ms`, validate `d2.lastUpdateId >= d1.lastUpdateId`, compute `microSkew1` and `microSkew2` using normalized half-spread formula, and enforce `obDelta` spoof-decay and `bookHollowing` guards.

### Task 2: Implement Engine #39 (`Contract-Specific nextFundingTime Settlement Cost & Dump Shield`)
**Files:**
- Modify: `leverage-3x-system/leverage_3x_trader.mjs:1098-1560`
- [x] **Step 1:** Extract per-contract `minsToFunding` from `prem.nextFundingTime` in `scanPerpUniverse` and apply Narrow B settlement entry & open-position guards.
- [x] **Step 2:** Syntax check (`node --check`), restart port `3848` daemon, and push to GitHub.
