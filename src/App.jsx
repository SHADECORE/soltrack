import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Tooltip, ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis } from "recharts";
import "./App.css";

// ── HELIUS ─────────────────────────────────────────────────────────────────────
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Stablecoins — filter from token positions. TOKEN/USDC pairs route through
// USDC as an intermediate; we want the actual memecoin, not the stable.
// Canonical stablecoin mint addresses on Solana
// Keep this in sync with STABLE_MINTS in cloudflare-worker-v5.js
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT (Tether)
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",  // USDH (Hubble)
  "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PEnn", // UXD
  "USD1yTWrgkRm1UsKud8kFc6owNJGYaXh8t2PBB51Yw4",  // USD1 (WLFI)
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (PayPal)
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",  // BTC (wBTC) — not stable but routing
  "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o", // USDCet (Wormhole USDC)
  "Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS", // PAI
  "CXLBjMMcwkc17GfJtBos6rQCo1ypeH6eDbB82Kby4MRm", // cashUSDC
]);

// Symbol-based stable detection — fallback when mint isn't in the list
// Catches new stablecoins, alternate mints, and any USD-pegged token by name
const STABLE_SYMBOL_RE = /^(USDC?T?|USDT|USD[0-9]?|BUSD|DAI|FRAX|USDH|PYUSD|TUSD|GUSD|LUSD|EURC|EURS|PAI|USH|UXD|USDD|USDP|FDUSD|SUSD|USDB|USDE)$/i;

function isStablecoin(mint, symbol) {
  if (mint && STABLE_MINTS.has(mint)) return true;
  if (symbol && STABLE_SYMBOL_RE.test(symbol.trim())) return true;
  return false;
}

// Token symbol cache — seeded with known tokens
const TOKEN_SYMBOL_CACHE = {
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82": "BOME",
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump": "POPCAT",
  "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4": "MYRO",
  "5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK31CR8Ada": "PONKE",
  "So11111111111111111111111111111111111111112": "SOL",
};

function tokenSym(mint) {
  return TOKEN_SYMBOL_CACHE[mint] ?? mint.slice(0, 6) + "…";
}

// Resolve symbols via DexScreener — free, no auth, works from browser
const _pendingSymbolFetch = new Set();
async function resolveSymbols(mints) {
  const unknown = mints.filter(m => !TOKEN_SYMBOL_CACHE[m] && !_pendingSymbolFetch.has(m));
  if (!unknown.length) return;
  unknown.forEach(m => _pendingSymbolFetch.add(m));

  // DexScreener batch endpoint: up to 30 mints per call
  const chunks = [];
  for (let i = 0; i < unknown.length; i += 30) chunks.push(unknown.slice(i, i + 30));

  await Promise.allSettled(chunks.map(async (chunk) => {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return;
      const data = await res.json(); // array of pair objects
      for (const pair of data) {
        const mint = pair?.baseToken?.address;
        const sym  = pair?.baseToken?.symbol;
        if (mint && sym && !TOKEN_SYMBOL_CACHE[mint]) {
          TOKEN_SYMBOL_CACHE[mint] = sym;
        }
      }
    } catch (e) {
      console.warn("[SOLTRACK] DexScreener lookup failed", e);
    }
  }));
}

function parseTx(tx, wallet) {
  try {
    const ts  = new Date(tx.timestamp * 1000).toISOString();
    const sig = tx.signature;

    const acct = (tx.accountData ?? []).find(a => a.account === wallet);
    const walletDelta = acct ? (acct.nativeBalanceChange ?? 0) / 1e9 : null;
    if (walletDelta === null) return [];

    const txFee = (tx.fee ?? 5000) / 1e9;

    // Compute app fees (Jito tips, platform fees) from nativeTransfers.
    // For buys: the largest outgoing transfer is the swap; smaller ones are fees.
    // For sells: all outgoing native transfers from wallet are fees.
    const nativeOutAmounts = (tx.nativeTransfers ?? [])
      .filter(t => t.fromUserAccount === wallet)
      .map(t => (t.amount ?? 0) / 1e9)
      .sort((a, b) => b - a);
    // appFee for buys: sum of all outgoing except the largest (the swap)
    const buyAppFee = nativeOutAmounts.length > 1
      ? nativeOutAmounts.slice(1).reduce((a, b) => a + b, 0) : 0;
    // appFee for sells: all outgoing native transfers are fees (swap comes IN)
    const sellAppFee = nativeOutAmounts.reduce((a, b) => a + b, 0);

    // Classify every non-SOL token transfer involving this wallet
    const allIn  = (tx.tokenTransfers ?? []).filter(t => t.toUserAccount   === wallet && t.mint !== SOL_MINT);
    const allOut = (tx.tokenTransfers ?? []).filter(t => t.fromUserAccount === wallet && t.mint !== SOL_MINT);

    // Did stablecoins move? If stables went OUT, this was a USDC-funded buy.
    // If stables came IN, this was a sell-for-USDC (walletDelta won't be positive).
    const stableOut = allOut.some(t => STABLE_MINTS.has(t.mint));

    // Tracked tokens: non-stable, non-SOL
    const tokenIn  = allIn.filter(t => !STABLE_MINTS.has(t.mint));
    const tokenOut = allOut.filter(t => !STABLE_MINTS.has(t.mint));

    const results = [];

    // ── BUY: received tracked tokens, paid SOL ──────────────────────────────
    // Skip if stablecoins went out — means this was SOL→USDC→TOKEN.
    // walletDelta in that case is just fees+rent (~0.002), not the real SOL cost.
    if (tokenIn.length > 0 && walletDelta < -0.001 && !stableOut) {
      const costEach     = +(Math.abs(walletDelta) / tokenIn.length).toFixed(9);
      const totalFeeEach = +((txFee + buyAppFee) / tokenIn.length).toFixed(9);
      const txFeeEach    = +(txFee / tokenIn.length).toFixed(9);
      for (const t of tokenIn) {
        results.push({
          id: sig + "_buy_" + t.mint.slice(0, 8),
          token: t.symbol || tokenSym(t.mint),
          mint: t.mint, type: "buy", ts,
          sol: costEach,       // |walletDelta| / n — includes swap cost + all fees + rent
          fee: totalFeeEach,   // txFee + app fees (Jito, platform)
          txFee: txFeeEach,    // protocol fee only (for backwards compat)
          amount: t.tokenAmount ?? 0, sig,
        });
      }
    }

    // ── SELL: sent tracked tokens, received SOL or stablecoin ───────────────
    // walletDelta > 0 means net SOL came in (direct SOL sell).
    // walletDelta ≈ 0 but stables came in = TOKEN→USDC sell — record with stableIn amount.
    const stableIn = allIn.filter(t => STABLE_MINTS.has(t.mint));
    const stableInAmount = stableIn.reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
    // For USDC sells: treat USDC received as SOL-equivalent revenue
    // (imperfect but preserves position closure — treated as 1:1 proxy)
    const isUsdcSell = tokenOut.length > 0 && stableInAmount > 0 && walletDelta <= 0.001;
    if (tokenOut.length > 0 && (walletDelta > 0.001 || isUsdcSell)) {
      const revenue = isUsdcSell ? stableInAmount : Math.abs(walletDelta);
      const revenueEach  = +(revenue / tokenOut.length).toFixed(9);
      const totalFeeEach = +((txFee + sellAppFee) / tokenOut.length).toFixed(9);
      const txFeeEach    = +(txFee / tokenOut.length).toFixed(9);
      for (const t of tokenOut) {
        results.push({
          id: sig + "_sell_" + t.mint.slice(0, 8),
          token: t.symbol || tokenSym(t.mint),
          mint: t.mint, type: "sell", ts,
          sol: revenueEach,    // walletDelta/n for SOL sells; stableInAmount/n for USDC sells
          fee: totalFeeEach,
          txFee: txFeeEach,
          amount: t.tokenAmount ?? 0, sig,
          usdcSell: isUsdcSell, // flag for debugging
        });
      }
    }

    return results;
  } catch (e) {
    console.warn("parse fail", tx?.signature, e);
    return [];
  }
}





function sanitizeWorkerUrl(url) {
  // Fix accidental double-protocol (https://https://...) and trim whitespace
  return url.trim().replace(/^(https?:\/\/)+/, "https://").replace(/\/$/, "");
}

async function fetchTrades(wallet, workerUrl, onProgress, signal, headers = {}) {
  const base = sanitizeWorkerUrl(workerUrl);
  const CUTOFF_TS = Date.now() - 90 * 24 * 60 * 60 * 1000;
  let all = [], before = undefined, page = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Aborted");
    const p = new URLSearchParams({ wallet, limit: "100" });
    if (before) p.set("before", before);
    const res = await fetch(`${base}/transactions?${p}`, { signal, headers });
    if (!res.ok) { const t = await res.text(); throw new Error(`Worker ${res.status}: ${t}`); }
    const txs = await res.json();
    if (!txs.length) break;
    page++;
    const oldestTs = txs[txs.length - 1]?.timestamp * 1000;
    const parsed = txs.flatMap((tx) => parseTx(tx, wallet));
    all.push(...parsed);
    onProgress?.(all.length);
    if (txs.length < 100) break;
    if (oldestTs && oldestTs < CUTOFF_TS) break;
    before = txs[txs.length - 1].signature;
    if (page >= 50) break;
  }
  return all.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
// Hardcoded worker URL — visible in network requests anyway, not a secret.
// Admin can override via Settings > Worker URL to migrate without redeployment.
const DEFAULT_WORKER_URL = "https://soltrack.space0amazing.workers.dev";

const DEFAULT_SETTINGS = {
  appName: "SOLTRACK",
  accentGreen: "#00ff91",
  accentBest:  "#ffd700",   // best day / best result highlight color
  accentRed: "#ff0000",
  accentFee: "#ff9900",
  accentPurple: "#cc16fe",
  bgBase: "#000000",
  bgCard: "#080808",
  borderColor: "#333333",
  textPrimary: "#ffffff",
  textDim: "#b0b0b0",
  textMid: "#ffffff",
  walletColors: ["#00ff55", "#9429ff", "#ff0000", "#ffb300", "#00ffee", "#ff9500"],
  spotlightWidth: 500,
  spotlightOpacity: 1,
  graphLineWidth: 2,
  graphGlowIntensity: 0,
  graphGlowWidth: 100,
  tzOffset: 0,
  terminalId: "axiom",
  graphMergeTokens: false, // merge same-token positions across wallets into one point
  uiZoom: 1,
  privacyMode: false,
  graphHeight: 400,
  graphLodPoints: 100,
  textScale: 1.2,
  sidebarWidth: 300,
  pnlHistoDecimals: 3,
  currency: "SOL",
  mistakeTags: ["topblast", "hold to zero", "fullport", "blind ape", "revenge trade", "follow CT"],
  graphShapeRules: [
    {
      dir: "above",
      threshold: 1,
      shape: "star4",
      size: 16,
    },
    {
      dir: "above",
      threshold: 0.5,
      shape: "diamond",
      size: 12,
    },
    {
      dir: "above",
      threshold: 0,
      shape: "circle",
      size: 10,
    },
    {
      dir: "below",
      threshold: 0,
      shape: "circle",
      size: 10,
    },
    {
      dir: "below",
      threshold: -0.5,
      shape: "diamond",
      size: 12,
    },
    {
      dir: "below",
      threshold: -1,
      shape: "x",
      size: 16,
    },
  ],
  graphShapeNormalize: true,
  workerUrl: DEFAULT_WORKER_URL,
  heliusKey: "",
  cardDesignV2: false,  // false = classic V1 design, true = new V2 design
  defaultCardV2: {},    // global V2 card defaults (never mixed with V1's defaultCard)
  // shareCard: removed — card appearance is now per-rank (rank.card), see DEFAULT_CARD below
  // ── Rank definitions (editable in admin) ─────────────────────────────────
  pnlRanks: [
    { min: 1000, name: "PHANTASM", color: "#000000", g1: "#f9fafa", g2: "#e6e4ec", shape: "PHANTASM", card: { shapeSize: 54, shapeX: 250, shapeY: 26, ghostSize: 90, ghostX: null, ghostY: null, showGhost: true, borderWidth: 8, borderOpacity: 0.25, gradientAngle: 135, g1Stop: 0, g1Opacity: 1, midStop: 35, midColor: "#59e8b9", endStop: 100, endColor: "#0a3e66", slabOpacity: 0.06, slabLineWidth: 2, slabLineOpacity: 0.3, dividerWidth: 2, dividerOpacity: 0.3, dividerDash: "4,4", rankFontSize: 29, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(0,0,0,0.5)" } },
    { min: 500, name: "ORACLE", color: "#a3ffff", g1: "#009b9e", g2: "#002e2d", shape: "VOID", card: { shapeSize: 44, shapeX: 256, shapeY: 28, ghostSize: 75, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 32, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 200, name: "SENTIENT", color: "#d7a6fc", g1: "#ae00ff", g2: "#0b001f", shape: "SENTIENT", card: { shapeSize: 46, shapeX: 254, shapeY: 34, ghostSize: 90, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 30, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 100, name: "IMMORTAL", color: "#fe4d4d", g1: "#c1121f", g2: "#1a0000", shape: "IMMORTAL", card: { shapeSize: 44, shapeX: 258, shapeY: 32, ghostSize: 80, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 31, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 50, name: "HYPERION", color: "#ff9e42", g1: "#e85d04", g2: "#1a0800", shape: "HYPERION", card: { shapeSize: 48, shapeX: 254, shapeY: 30, ghostSize: 90, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 33, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 20, name: "SUPREME", color: "#5c67ff", g1: "#172dd3", g2: "#000119", shape: "SUPREME", card: { shapeSize: 50, shapeX: 252, shapeY: 28, ghostSize: 85, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 30, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 10, name: "ASCENDANT", color: "#04f14b", g1: "#01c12e", g2: "#030303", shape: "ASCENDANT", svgPath: "<path xmlns=\"http://www.w3.org/2000/svg\" id=\"Фигура 1 copy 2\" fill-rule=\"evenodd\" class=\"s0\" d=\"m196.89 131.35h-71.06l71.06 45.4h-193.89l71.06-45.4h-71.06l71.06-45.41h-71.06l96.95-61.94 96.94 61.94h-71.06z\"/>", svgViewBox: "0 0 200 200", svgCenter: [100, 100], svgScale: 0.01, card: { shapeSize: 50, shapeX: 256, shapeY: 20, ghostSize: 100, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#001401", endStop: 100, endColor: "#030303", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 26, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 5, name: "IMPERIAL", color: "#ff006f", g1: "#b7016b", g2: "#1f0015", shape: "IMPERIAL", card: { shapeSize: 44, shapeX: 256, shapeY: 30, ghostSize: 85, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 35, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 2, name: "DIAMOND", color: "#fc83f2", g1: "#870e90", g2: "#230024", shape: "DIAMOND", svgPath: -Infinity, svgViewBox: -Infinity, svgCenter: [100, 100], svgScale: 0.01, card: { shapeSize: 40, shapeX: 260, shapeY: 30, ghostSize: 85, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 32, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 1, name: "PLATINUM", color: "#12cefd", g1: "#11576e", g2: "#061b28", shape: "SENTIENT", svgPath: "<path xmlns=\"http://www.w3.org/2000/svg\" id=\"Фигура 1 copy 2\" fill-rule=\"evenodd\" class=\"s0\" d=\"m196.89 131.35h-71.06l71.06 45.4h-193.89l71.06-45.4h-71.06l71.06-45.41h-71.06l96.95-61.94 96.94 61.94h-71.06z\"/>", svgViewBox: "0 0 200 200", card: { shapeSize: 44, shapeX: 256, shapeY: 26, ghostSize: 95, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 32, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 0.5, name: "GOLD", color: "#ffce2e", g1: "#b38609", g2: "#1a0f00", shape: "GOLD", card: { shapeSize: 32, shapeX: 264, shapeY: 30, ghostSize: 70, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 36, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 0.2, name: "SILVER", color: "#cee0e8", g1: "#4b5563", g2: "#111827", shape: "SILVER", card: { shapeSize: 44, shapeX: 252, shapeY: 32, ghostSize: 90, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 36, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: 0.1, name: "BRONZE", color: "#f39339", g1: "#8f5c28", g2: "#180800", shape: "BRONZE", card: { shapeSize: 40, shapeX: 258, shapeY: 30, ghostSize: 85, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 31, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.22)" } },
    { min: 0, name: "IRON", color: "#7f8590", g1: "#374151", g2: "#0a0a0a", shape: "IRON", card: { shapeSize: 48, shapeX: 258, shapeY: 22, ghostSize: 90, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 42, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
    { min: -Infinity, name: "REKT", color: "#fa0019", g1: "#9b0020", g2: "#1a0000", shape: "REKT", card: { shapeSize: 44, shapeX: 254, shapeY: 36, ghostSize: 85, ghostX: null, ghostY: null, showGhost: true, borderWidth: 3.5, borderOpacity: 0.48, gradientAngle: 135, g1Stop: 0, g1Opacity: 0.68, midStop: 44, midColor: "#0a0a0a", endStop: 100, endColor: "#040404", slabOpacity: 0.07, slabLineWidth: 0.9, slabLineOpacity: 0.28, dividerWidth: 1, dividerOpacity: 0.6, dividerDash: "4,4", rankFontSize: 38, solFontSize: 12, walletLabelFontSize: 12, showChart: true, useRankColor: true, customColor: "#ffffff", minorTextColor: "rgba(255,255,255,0.5)" } },
  ],
};

// ── DEFAULT_CARD: per-rank card visual settings ────────────────────────────────
// Every rank stores its own card:{} object. Missing keys fall back to these values.
// This is the single source of truth for what's customizable per rank.
const DEFAULT_CARD = {
  // ── Shape (real, foreground)
  shapeSize:   40,     // size in px
  shapeX:      null,   // null = auto (right-aligned). explicit px from left
  shapeY:      52,     // px from top
  // ── Ghost (background echo of shape)
  ghostSize:   110,
  ghostX:      null,   // null = same anchor as shape
  ghostY:      null,   // null = same anchor as shape
  showGhost:   true,
  // ── Border
  borderWidth:   1.1,
  borderOpacity: 0.48,
  // ── Background gradient
  gradientAngle: 135,    // degrees (0 = top→bottom, 90 = left→right, 135 = TL→BR)
  g1Stop:        0,      // first stop position %
  g1Opacity:     0.68,   // first stop opacity (uses rank.g1 color)
  midStop:       44,     // mid stop position %
  midColor:      "#0a0a0a",
  endStop:       100,
  endColor:      "#040404",
  // ── Diagonal accent slab
  slabOpacity:      0.07,
  slabLineWidth:    0.9,
  slabLineOpacity:  0.28,
  // ── Ticket divider (dashed horizontal line at notch)
  dividerWidth:   1,
  dividerOpacity: 0.6,
  dividerDash:    "4,4",
  // ── Typography
  rankFontSize:        30,
  solFontSize:          9,   // "SOL" label under PnL number
  walletLabelFontSize:  8,   // "X wallets · ALL" sub-label
  // ── Display toggles
  showChart:    true,
  useRankColor: true,        // use rank.color as accent, or customColor below
  customColor:  "#ffffff",
  // ── Minor text color (wallet label, SOL label, % return)
  minorTextColor: "rgba(255,255,255,0.22)",
  notchStyle: "semicircle",  // "semicircle" | "triangle"
  // ── Layout — all positions and paddings
  cardPad:          24,   // left/right padding (px)
  rankNameY:        54,   // rank name baseline Y
  dividerLineY:     65,   // horizontal divider below rank name
  walletLabelY:     80,   // wallet label baseline Y
  pnlY:            192,   // PnL number baseline Y
  currencyLabelY:  212,   // "SOL" / currency label baseline Y
  pctReturnY:      244,   // % return baseline Y
  pctReturnSize:    20,   // % return font size
  pnlLetterSpacing: -2,   // PnL number letter spacing
};

// ── (no mock data) ────────────────────────────────────────────────────────────

// ── TIME FILTER ────────────────────────────────────────────────────────────────
const TIME_FILTERS = ["TODAY", "YESTERDAY", "WEEK", "MONTH", "ALL"];
// tzOffset: hours to add to UTC to get "local" midnight. e.g. Poland=+1/+2, Georgia=+4
function filterByTime(trades, f, tzOffset = 0, customDay = null) {
  if (f === "ALL" && !customDay) return trades;
  const nowUTC = Date.now();
  const nowLocal = nowUTC + tzOffset * 3600000;
  const d = new Date(nowLocal);
  if (customDay) {
    const [cy, cm, cd] = customDay.split("-").map(Number);
    const dayStart = Date.UTC(cy, cm - 1, cd) - tzOffset * 3600000;
    const dayEnd   = dayStart + 86400000;
    return trades.filter(t => { const ts = new Date(t.ts).getTime(); return ts >= dayStart && ts < dayEnd; });
  }
  if (f === "TODAY") {
    const midnightLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffset * 3600000;
    return trades.filter((t) => new Date(t.ts).getTime() >= midnightLocal);
  }
  if (f === "YESTERDAY") {
    const todayMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffset * 3600000;
    const yestMidnight  = todayMidnight - 86400000;
    return trades.filter((t) => { const ts = new Date(t.ts).getTime(); return ts >= yestMidnight && ts < todayMidnight; });
  }
  if (f === "WEEK") {
    const cutoff = nowUTC - 7 * 86400000;
    return trades.filter((t) => new Date(t.ts).getTime() >= cutoff);
  }
  if (f === "MONTH") {
    const cutoff = nowUTC - 30 * 86400000;
    return trades.filter((t) => new Date(t.ts).getTime() >= cutoff);
  }
  return trades;
}

// ── CURVE BUILDER ─────────────────────────────────────────────────────────────
// Groups ALL trades per wallet:mint into a single position.
// PnL = totalSold - totalBought. No cycle detection needed.
// Open positions (only buys, no sells yet) show as negative until closed.
function buildCurve(trades) {
  const curve = [{ label: "START", idx: 0, cumPnl: 0, tradePnl: 0, fee: 0 }];
  let cum = 0;
  const positions = {}; // wallet:mint → accumulator

  for (const t of [...trades].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const mint = t.mint ?? t.token;
    const k = (t.wallet ? `${t.wallet}:` : "") + mint;
    if (!positions[k]) positions[k] = { solIn: 0, solOut: 0, fees: 0, token: t.token, mint, wallet: t.wallet ?? null, lastTs: t.ts, lastSellTs: null };
    positions[k].lastTs = t.ts;
    positions[k].fees += t.fee || 0;
    if (t.type === "buy")  positions[k].solIn  += t.sol;
    else if (t.type === "sell") { positions[k].solOut += t.sol; positions[k].lastSellTs = t.ts; }
  }

  // Sort positions: closed ones by last sell time, open ones by last trade time
  const sorted = Object.values(positions).sort((a, b) =>
    new Date(a.lastSellTs ?? a.lastTs) - new Date(b.lastSellTs ?? b.lastTs)
  );

  for (const p of sorted) {
    const net = p.solOut - p.solIn; // negative if still holding
    const isStable = isStablecoin(p.mint, p.token);
    if (!isStable) cum += net; // stables don't count toward cumulative PnL
    const ts = p.lastSellTs ?? p.lastTs;
    curve.push({
      label:    p.token ?? p.mint?.slice(0,6) ?? "?",
      idx:      curve.length,
      cumPnl:   +cum.toFixed(9),
      tradePnl: +net.toFixed(9),
      fee:      +p.fees.toFixed(9),
      solIn:    p.solIn,
      solOut:   p.solOut,
      time:     ts?.slice(5,16).replace("T"," "),
      token:    p.token,
      mint:     p.mint,
      wallet:   p.wallet,
      closeTs:  new Date(ts).getTime(),
      isOpen:   !p.lastSellTs,
      isStable,
    });
  }

  return curve;
}

// ── MERGED CURVE BUILDER ──────────────────────────────────────────────────────
// Merges same-token trades across wallets into one point per trading cycle.
// A cycle closes when cumulative solOut >= cumulative solIn (fully exited).
// This prevents old closed positions from merging with new ones on the same token.
function buildMergedCurve(trades) {
  const curve = [{ label: "START", idx: 0, cumPnl: 0, tradePnl: 0, fee: 0 }];
  let cum = 0;

  // Group by mint + calendar day (UTC date string YYYY-MM-DD)
  // Same token on same day → one merged point; different days → separate points
  const dayOf = ts => (ts ?? "").slice(0, 10); // "2025-03-22T..." → "2025-03-22"

  const buckets = {}; // "mint::day" → accumulator
  for (const t of [...trades].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const mint = t.mint ?? t.token;
    const day  = dayOf(t.ts);
    const key  = mint + "::" + day;
    if (!buckets[key]) buckets[key] = { solIn: 0, solOut: 0, fees: 0, token: t.token, mint, lastTs: t.ts, lastSellTs: null, wallets: {} };
    const b = buckets[key];
    b.lastTs = t.ts;
    b.fees  += t.fee || 0;
    const wk = t.wallet ?? "unknown";
    if (!b.wallets[wk]) b.wallets[wk] = { solIn: 0, solOut: 0 };
    if (t.type === "buy") {
      b.solIn += t.sol; b.wallets[wk].solIn += t.sol;
    } else if (t.type === "sell") {
      b.solOut += t.sol; b.wallets[wk].solOut += t.sol;
      b.lastSellTs = t.ts;
    }
  }

  // Sort buckets by close time (last sell) or last trade time
  const sorted = Object.values(buckets).sort((a, b) =>
    new Date(a.lastSellTs ?? a.lastTs) - new Date(b.lastSellTs ?? b.lastTs)
  );

  for (const p of sorted) {
    const net = p.solOut - p.solIn;
    const isStable = isStablecoin(p.mint, p.token);
    if (!isStable) cum += net;
    const ts = p.lastSellTs ?? p.lastTs;
    const walletBreakdown = Object.entries(p.wallets).map(([wallet, wd]) => ({
      wallet,
      net: +(wd.solOut - wd.solIn).toFixed(9),
    }));
    curve.push({
      label:    p.token ?? p.mint?.slice(0, 6) ?? "?",
      idx:      curve.length,
      cumPnl:   +cum.toFixed(9),
      tradePnl: +net.toFixed(9),
      fee:      +p.fees.toFixed(9),
      solIn:    p.solIn,
      solOut:   p.solOut,
      time:     ts?.slice(5, 16).replace("T", " "),
      token:    p.token,
      mint:     p.mint,
      wallet:   null,
      walletBreakdown,
      closeTs:  new Date(ts).getTime(),
      isOpen:   !p.lastSellTs,
      isStable,
    });
  }
  return curve;
}

const fmt = (n, d = 3) => (+(n ?? 0)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (n) => (n >= 0 ? "+" : "");

// ── Currency conversion ────────────────────────────────────────────────────────
const CURRENCY_SYMBOLS = { SOL: "", USD: "$", EUR: "€", PLN: "zł", UAH: "₴", KZT: "₸", GBP: "£" };
const CURRENCY_DECIMALS = { SOL: 3, USD: 2, EUR: 2, PLN: 2, UAH: 0, KZT: 0, GBP: 2 };
// Global rate store: SOL price in USD + fiat rates vs USD
let _solUsd = null;     // SOL/USD price
let _fiatRates = {};    // { EUR: 0.92, PLN: 4.0, UAH: 41.5, GBP: 0.79 }
let _ratesFetchedAt = 0;

async function fetchRates() {
  const now = Date.now();
  if (now - _ratesFetchedAt < 5 * 60 * 1000) return; // cache 5 min
  try {
    // SOL price from Binance (no key needed, CORS open)
    const solRes = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    if (solRes.ok) { const j = await solRes.json(); _solUsd = parseFloat(j.price); }
  } catch {}
  try {
    // Fiat rates vs USD from open.er-api.com (free, no key, CORS open)
    const fiatRes = await fetch("https://open.er-api.com/v6/latest/USD");
    if (fiatRes.ok) { const j = await fiatRes.json(); _fiatRates = j.rates ?? {}; }
  } catch {}
  if (_solUsd || Object.keys(_fiatRates).length) _ratesFetchedAt = now;
}

function solToDisplay(solAmount, currency) {
  if (!currency || currency === "SOL") return solAmount;
  if (!_solUsd) return null; // rates not loaded yet
  const usd = solAmount * _solUsd;
  if (currency === "USD") return usd;
  if (currency === "KZT") { const r = _fiatRates.KZT; return r ? usd * r : null; }
  const rate = _fiatRates[currency];
  return rate ? usd * rate : null;
}

function fmtC(solAmount, S, d) {
  const cur = S?.currency ?? "SOL";
  const converted = solToDisplay(solAmount, cur);
  const decimals = d ?? CURRENCY_DECIMALS[cur] ?? 2;
  if (converted === null) { const s = solAmount < 0 ? "-" : "+"; return s + fmt(Math.abs(solAmount), d ?? 3) + " SOL"; }
  const absStr = fmt(Math.abs(converted), decimals);
  const sign = converted < 0 ? "-" : "+";
  if (cur === "SOL") return sign + absStr + " SOL";
  const sym = CURRENCY_SYMBOLS[cur] ?? (cur + " ");
  return sign + sym + absStr;
}

// ── GLOBAL SPOTLIGHT ──────────────────────────────────────────────────────────
const cardRegistry = new Set();
function GlobalSpotlight({ S }) {
  useEffect(() => {
    const h = (e) => cardRegistry.forEach((fn) => fn(e.clientX, e.clientY, S));
    window.addEventListener("mousemove", h, { passive: true });
    return () => window.removeEventListener("mousemove", h);
  }, [S]);
  return null;
}

// Reusable hook: attaches spotlight canvas to any container ref
function useSpotlight() {
  const elRef = useRef(null);
  const cvRef = useRef(null);
  useEffect(() => {
    const paint = (mx, my, settings) => {
      const el = elRef.current, cv = cvRef.current;
      if (!el || !cv) return;
      const r = el.getBoundingClientRect(), W = r.width, H = r.height;
      if (cv.width !== Math.round(W) || cv.height !== Math.round(H)) {
        cv.width = Math.round(W); cv.height = Math.round(H);
      }
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      const lx = mx - r.left, ly = my - r.top;
      const bx = Math.max(0, Math.min(W, lx)), by = Math.max(0, Math.min(H, ly));
      const dist = Math.hypot(lx - bx, ly - by);
      const falloff = Math.max(0, 1 - dist / (settings.spotlightWidth * 0.55));
      if (falloff <= 0.001) return;
      const c = settings.accentGreen;
      const rr = parseInt(c.slice(1,3),16), gg = parseInt(c.slice(3,5),16), bb = parseInt(c.slice(5,7),16);
      const op = falloff * settings.spotlightOpacity;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, settings.spotlightWidth);
      g.addColorStop(0, `rgba(${rr},${gg},${bb},${op})`);
      g.addColorStop(0.45, `rgba(${rr},${gg},${bb},${op * 0.25})`);
      g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(0.75, 0.75, W - 1.5, H - 1.5);
      ctx.stroke();
    };
    cardRegistry.add(paint);
    return () => cardRegistry.delete(paint);
  }, []);
  return { elRef, cvRef };
}

function BorderCard({ children, style, S, className = "" }) {
  const { elRef, cvRef } = useSpotlight();
  return (
    <div ref={elRef}
      style={{ position: "relative", background: S.bgCard, border: `1px solid ${S.borderColor}`, ...style }}
      className={className}
    >
      <canvas ref={cvRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }} />
      <div style={{ position: "relative", zIndex: 2 }}>{children}</div>
    </div>
  );
}

// ── TERMINALS ─────────────────────────────────────────────────────────────────
const TERMINALS = [
  { id: "padre",  name: "Padre",      url: "https://trade.padre.gg/trade/solana/{mint}" },
  { id: "gmgn",   name: "GMGN",       url: "https://gmgn.ai/sol/token/{mint}" },
  { id: "axiom",  name: "Axiom",      url: "https://axiom.trade/t/{mint}" },
  { id: "bullx",  name: "BullX",      url: "https://bullx.io/terminal?chainId=1399811149&address={mint}" },
  { id: "photon", name: "Photon",     url: "https://photon-sol.tinyastro.io/en/r/@soltrack/{mint}" },
  { id: "dex",    name: "DexScreener",url: "https://dexscreener.com/solana/{mint}" },
  { id: "solscan",name: "Solscan",    url: "https://solscan.io/token/{mint}" },
];
function terminalUrl(terminalId, mint) {
  const t = TERMINALS.find(t => t.id === terminalId) ?? TERMINALS[0];
  return t.url.replace("{mint}", mint);
}

// ── GRAPH SHAPE RENDERER ─────────────────────────────────────────────────────
// Returns SVG path `d` for a shape centered at (cx, cy) with given radius
function shapePath(shape, cx, cy, r) {
  switch (shape) {
    case "circle":   return null; // rendered as <circle>
    case "square":   return `M${cx-r},${cy-r}h${2*r}v${2*r}h${-2*r}z`;
    case "diamond":  return `M${cx},${cy-r}l${r},${r}l${-r},${r}l${-r},${-r}z`;
    case "triangle": return `M${cx},${cy-r}l${r*0.87},${r*1.5}h${-r*1.74}z`;
    case "triangle_down": return `M${cx},${cy+r}l${r*0.87},${-r*1.5}h${-r*1.74}z`;
    case "star4": {
      const or=r, ir=r*0.4;
      const pts = Array.from({length:8},(_,i)=>{const a=Math.PI/4*i-Math.PI/2,rad=i%2===0?or:ir;return[cx+rad*Math.cos(a),cy+rad*Math.sin(a)];});
      return "M"+pts.map(p=>p.join(",")).join("L")+"z";
    }
    case "star5": {
      const or=r, ir=r*0.38;
      const pts = Array.from({length:10},(_,i)=>{const a=Math.PI/5*i-Math.PI/2,rad=i%2===0?or:ir;return[cx+rad*Math.cos(a),cy+rad*Math.sin(a)];});
      return "M"+pts.map(p=>p.join(",")).join("L")+"z";
    }
    case "hexagon": {
      const pts = Array.from({length:6},(_,i)=>{const a=Math.PI/3*i;return[cx+r*Math.cos(a),cy+r*Math.sin(a)];});
      return "M"+pts.map(p=>p.join(",")).join("L")+"z";
    }
    case "pentagon": {
      const pts = Array.from({length:5},(_,i)=>{const a=Math.PI*2/5*i-Math.PI/2;return[cx+r*Math.cos(a),cy+r*Math.sin(a)];});
      return "M"+pts.map(p=>p.join(",")).join("L")+"z";
    }
    case "cross": {
      const t=r*0.28;
      return `M${cx-t},${cy-r}h${2*t}v${r-t}h${r-t}v${2*t}h${-(r-t)}v${r-t}h${-2*t}v${-(r-t)}h${-(r-t)}v${-2*t}h${r-t}z`;
    }
    case "x": {
      const a=r*0.7,b=r*0.22;
      return `M${cx-a},${cy-a+b}l${-b},${b}l${a-b},${a-b}l${-(a-b)},${a-b}l${b},${b}l${a-b},${-(a-b)}l${a-b},${a-b}l${b},${-b}l${-(a-b)},${-(a-b)}l${a-b},${-(a-b)}l${-b},${-b}l${-(a-b)},${a-b}z`;
    }
    default:         return null;
  }
}
const SHAPES = ["circle","square","diamond","triangle","triangle_down","star4","star5","hexagon","pentagon","cross","x"];

function resolveShape(tradePnl, rules, normalize) {
  // Find first matching rule
  const sorted = [...rules].sort((a, b) => {
    // Sort descending by abs(threshold) so specific rules win
    return Math.abs(b.threshold) - Math.abs(a.threshold);
  });
  for (const r of sorted) {
    if (r.dir === "above" && tradePnl >= r.threshold) return r;
    if (r.dir === "below" && tradePnl <  r.threshold) return r;
  }
  return { shape: "circle", size: 7 };
}

// ── SVG PNL GRAPH (zoomable + pannable) ──────────────────────────────────────
function PnlGraph({ data, color, S, height = 210, wallets = [], zoom: zoomProp, panX: panXProp, onZoomChange, onPanChange, onPointClick }) {
  const contRef = useRef(null);
  const svgRef  = useRef(null);
  const [dims, setDims]   = useState({ w: 800, h: height });
  const [zoomLocal, setZoomLocal]   = useState(1);
  const [panXLocal, setPanXLocal]   = useState(0);
  const [hov, setHov]     = useState(null);
  const isDragging = useRef(false);
  const dragStart  = useRef({ x: 0, panX: 0 });

  // Use controlled props if provided, otherwise use local state
  const zoom    = zoomProp  ?? zoomLocal;
  const panX    = panXProp  ?? panXLocal;
  const setZoom = onZoomChange ?? setZoomLocal;
  const setPanX = onPanChange  ?? setPanXLocal;
  useEffect(() => {
    if (!contRef.current) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(contRef.current);
    return () => ro.disconnect();
  }, []);

  // Padding: top has zoom-label row, bottom has ticker labels
  const PAD = { top: 28, right: 16, bottom: 76, left: 54 };
  const W = dims.w, H = dims.h;
  const innerW = W - PAD.left - PAD.right;
  const n = data.length;
  const visible = Math.max(2, Math.round(n / zoom));
  const maxPan = Math.max(0, n - visible);
  const clampedPan = Math.max(0, Math.min(panX, maxPan));
  const startIdx = Math.floor(clampedPan);
  const endIdx   = Math.min(n - 1, startIdx + visible - 1);
  // Strip stables before LOD — prevents them from being selected as bucket min/max
  const rawVisData = data.slice(startIdx, endIdx + 1)
    .filter(d => d.label === "START" || !(d.isStable ?? isStablecoin(d.mint, d.token)));

  // LOD: when many points visible, keep only the most significant ones.
  // Always render ≤300 points. Within each bucket keep the min and max
  // tradePnl so spikes are never lost, just the flat middle gets thinned.
  const visData = useMemo(() => {
    const MAX_PTS = S.graphLodPoints ?? 300;
    if (rawVisData.length <= MAX_PTS) return rawVisData;
    const bucketSize = rawVisData.length / MAX_PTS;
    const result = [rawVisData[0]];
    for (let b = 0; b < MAX_PTS - 1; b++) {
      const lo = Math.floor(b * bucketSize);
      const hi = Math.floor((b + 1) * bucketSize);
      const bucket = rawVisData.slice(lo, hi);
      if (!bucket.length) continue;
      let minPt = bucket[0], maxPt = bucket[0];
      for (const pt of bucket) {
        if (pt.tradePnl < minPt.tradePnl) minPt = pt;
        if (pt.tradePnl > maxPt.tradePnl) maxPt = pt;
      }
      // Add min then max (or just one if they're the same point)
      if (minPt === maxPt) result.push(minPt);
      else result.push(minPt, maxPt);
    }
    result.push(rawVisData[rawVisData.length - 1]);
    // Re-sort by original index to preserve left-to-right order
    return result.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  }, [rawVisData, S.graphLodPoints]);

  // rawVisData is already stable-free (filtered before LOD)
  const vals = visData.length > 1 ? visData.map(d => d.cumPnl) : [0];
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const rangeV = maxV - minV || 1;
  const toX = (i) => PAD.left + (i / (visData.length - 1 || 1)) * innerW;
  const toY = (v)  => PAD.top  + (1 - (v - minV) / rangeV) * (H - PAD.top - PAD.bottom);
  const linePoints = visData.map((d, i) => ({ x: toX(i), y: toY(d.cumPnl), d }));
  const points = linePoints;

  // Simple green/red point colors — no intensity normalization
  const ptColor = (pnl) => pnl > 0 ? S.accentGreen : pnl < 0 ? S.accentRed : "#888888";

  const c  = color;
  const rr = parseInt(c.slice(1,3),16), gg = parseInt(c.slice(3,5),16), bb = parseInt(c.slice(5,7),16);

  // "Nice" y-axis ticks: round step to a power-of-10 multiple (0.1, 0.2, 0.5, 1, 2, 5…)
  const yTicks = useMemo(() => {
    const niceStep = (range, targetCount) => {
      if (range <= 0) return 0.1;
      const rawStep = range / targetCount;
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const norm = rawStep / mag;
      const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
      return nice * mag;
    };
    const innerH = H - PAD.top - PAD.bottom;
    const _toY = (v) => PAD.top + (1 - (v - minV) / rangeV) * innerH;
    const step = niceStep(rangeV, 5);
    const start = Math.ceil((minV - step * 0.001) / step) * step;
    const ticks = [];
    for (let i = 0; i < 20; i++) {
      const v = +(start + step * i).toFixed(8);
      if (v > maxV + step * 0.01) break;
      ticks.push({ v: +v.toFixed(4), y: _toY(v) });
    }
    return ticks.slice(0, 10);
  }, [minV, maxV, rangeV, H, PAD.top, PAD.bottom]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const svg = svgRef.current;
    let ptX = 0;
    if (svg) {
      try {
        const svgPt = svg.createSVGPoint();
        svgPt.x = e.clientX; svgPt.y = e.clientY;
        ptX = svgPt.matrixTransform(svg.getScreenCTM().inverse()).x;
      } catch {
        const rect = svg.getBoundingClientRect();
        ptX = (e.clientX - rect.left) * (dims.w / rect.width);
      }
    }
    setZoom(prev => {
      const next = Math.max(1, Math.min(n / 2, prev * factor));
      const fracX = (ptX - PAD.left) / innerW;
      const pivotIdx = clampedPan + fracX * visible;
      const newVisible = n / next;
      setPanX(Math.max(0, pivotIdx - fracX * newVisible));
      return next;
    });
  }, [n, clampedPan, visible, innerW, dims]);

  useEffect(() => {
    const el = contRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onMouseDown = (e) => { isDragging.current = true; dragStart.current = { x: e.clientX, panX: clampedPan }; };
  const onMouseMove = useCallback((e) => {
    if (isDragging.current) {
      const dx = e.clientX - dragStart.current.x;
      setPanX(Math.max(0, Math.min(maxPan, dragStart.current.panX - (dx / innerW) * visible)));
    }
    const svg = svgRef.current;
    if (!svg) return;
    // Use SVG's own coordinate transform — handles CSS zoom, devicePixelRatio, transforms
    let pt;
    try {
      const svgPt = svg.createSVGPoint();
      svgPt.x = e.clientX;
      svgPt.y = e.clientY;
      pt = svgPt.matrixTransform(svg.getScreenCTM().inverse());
    } catch {
      const rect = svg.getBoundingClientRect();
      pt = { x: (e.clientX - rect.left) * (dims.w / rect.width),
             y: (e.clientY - rect.top)  * (dims.h / rect.height) };
    }
    const mx = pt.x, my = pt.y;
    let best = -1, bestD = 99999;
    points.forEach((p, i) => { const d = Math.hypot(p.x - mx, p.y - my); if (d < bestD) { bestD = d; best = i; } });
    setHov(best >= 0 && bestD < 80 ? best : null);
  }, [points, visible, innerW, maxPan, dims]);

  const onMouseUp = () => { isDragging.current = false; };
  const hovP = hov != null ? points[hov] : null;
  const hovD = hov != null ? visData[hov] : null;
  const pnlC = (pv) => pv > 0 ? S.accentGreen : pv < 0 ? S.accentRed : S.textMid;
  const pct  = (pnl, cost) => cost > 0 ? ((pnl / cost) * 100).toFixed(1) : null;
  const rules = S.graphShapeRules ?? DEFAULT_SETTINGS.graphShapeRules;
  const maxAbsPnl = Math.max(0.001, ...visData.slice(1).map(d => Math.abs(d.tradePnl)));

  return (
    <div ref={contRef} style={{ position: "relative", width: "100%", height,
      cursor: isDragging.current ? "grabbing" : zoom > 1 ? "grab" : "default", userSelect: "none" }}>

      {/* Zoom label row — sits in the top padding, never overlaps data */}
      <div style={{ position: "absolute", top: 4, left: PAD.left, right: PAD.right, zIndex: 10,
        display: "flex", alignItems: "center", justifyContent: "space-between", pointerEvents: "none" }}>
        <span style={{ fontSize: 8, color: S.textDim, fontFamily: "'DM Mono',monospace", opacity: zoom > 1 ? 1 : 0.45 }}>
          {zoom > 1 ? `${Math.round(zoom)}× · ${visData.length} trades` : n > 4 ? "scroll to zoom" : ""}
        </span>
        {zoom > 1 && (
          <button onClick={() => { setZoom(1); setPanX(0); }}
            style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim,
              pointerEvents: "all", fontSize: 8, padding: "1px 6px", cursor: "pointer",
              fontFamily: "'DM Mono',monospace", letterSpacing: ".05em" }}>
            RESET
          </button>
        )}
      </div>

      <svg ref={svgRef} width="100%" height="100%"
        onMouseMove={onMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp}
        onMouseLeave={() => { setHov(null); isDragging.current = false; }}
        style={{ display: "block", overflow: "visible" }}>

        <defs>
          {/* Segment gradients keyed by linePoints index */}
          {linePoints.slice(1).map((p, i) => {
            const prev = linePoints[i];
            return (
              <linearGradient key={i} id={`seg${i}`} x1={prev.x} y1="0" x2={p.x} y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stopColor={ptColor(prev.d.tradePnl)} />
                <stop offset="100%" stopColor={ptColor(p.d.tradePnl)} />
              </linearGradient>
            );
          })}
        </defs>

        {/* Grid */}
        {yTicks.map((t, i) => (
          <line key={i} x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y}
            stroke={S.borderColor} strokeWidth="1" opacity="0.5" />
        ))}
        {yTicks.map((t, i) => (
          <text key={i} x={PAD.left - 6} y={t.y + 4} textAnchor="end"
            fill={S.textDim} fontSize="9" fontFamily="DM Mono">{t.v}</text>
        ))}

        {/* Glow layer */}
        {S.graphGlowIntensity > 0 && linePoints.length > 1 && (
          <polyline points={linePoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill="none"
            stroke={`rgba(${rr},${gg},${bb},${S.graphGlowIntensity * 0.012})`}
            strokeWidth={S.graphLineWidth + S.graphGlowWidth * 0.18}
            strokeLinejoin="round" strokeLinecap="round"
            style={{ filter: `blur(${S.graphGlowWidth * 0.28}px)` }} />
        )}

        {/* Zero line */}
        {minV < 0 && maxV > 0 && (
          <line x1={PAD.left} y1={toY(0)} x2={W - PAD.right} y2={toY(0)}
            stroke={S.textDim} strokeWidth="1" strokeDasharray="3,4" opacity="0.35" />
        )}

        {/* Colored segments — continuous through non-stable points only */}
        {linePoints.slice(1).map((p, i) => {
          const prev = linePoints[i];
          return (
            <line key={i}
              x1={prev.x.toFixed(1)} y1={prev.y.toFixed(1)}
              x2={p.x.toFixed(1)}   y2={p.y.toFixed(1)}
              stroke={`url(#seg${i})`}
              strokeWidth={S.graphLineWidth}
              strokeLinecap="round" />
          );
        })}

        {/* Crosshair — rendered BEFORE shapes so it sits behind dots */}
        {hovP && hovD && hovD.tradePnl !== undefined && (() => {
          // Line is always neutral white; label color reflects cumulative profit/loss
          const cumCol = hovD.cumPnl >= 0 ? S.accentGreen : S.accentRed;
          const hy = hovP.y;
          return (
            <g key="crosshair">
              <line x1={PAD.left} y1={hy} x2={W - PAD.right} y2={hy}
                stroke="#ffffff" strokeWidth="1" strokeDasharray="3,5" opacity="0.22" />
              <rect x={0} y={hy - 9} width={PAD.left - 4} height={18} fill={S.bgCard} />
              <text x={PAD.left - 6} y={hy + 4} textAnchor="end"
                fill={cumCol} fontSize="9" fontFamily="DM Mono" fontWeight="bold">
                {hovD.cumPnl >= 0 ? "+" : ""}{hovD.cumPnl.toFixed(3)}
              </text>
            </g>
          );
        })()}

        {/* Trade point shapes */}
        {points.slice(1).map((p, i) => {
          const isStable = p.d.isStable ?? isStablecoin(p.d.mint, p.d.token);
          const col = isStable ? "#555566" : ptColor(p.d.tradePnl);
          const isHov = hov === i + 1;
          const rule = resolveShape(p.d.tradePnl, rules);
          const sizeScale = S.graphShapeNormalize ? (0.5 + Math.min(1, Math.abs(p.d.tradePnl) / maxAbsPnl)) : 1;
          const r = (rule.size / 2) * sizeScale * (isHov ? 1.3 : 1) * (isStable ? 0.7 : 1);
          const d = shapePath(rule.shape, p.x, p.y, r);
          const commonProps = {
            fill: S.bgCard, stroke: col,
            strokeWidth: isHov ? 2.5 : 1.5,
            opacity: isStable ? 0.5 : 1,
            style: { filter: isStable ? "none" : `drop-shadow(0 0 ${isHov ? 7 : 3}px ${col})` }
          };
          const clickProps = (!isStable && onPointClick) ? {
            onClick: (e) => { e.stopPropagation(); onPointClick(p.d); },
            style: { ...commonProps.style, cursor: "pointer" },
          } : {};
          return d
            ? <path key={i} d={d} {...commonProps} {...clickProps} />
            : <circle key={i} cx={p.x} cy={p.y} r={r} {...commonProps} {...clickProps} />;
        })}

        {/* Hover tooltip */}
        {hovP && hovD && hovD.tradePnl !== undefined && (() => {
          const col = ptColor(hovD.tradePnl);
          const tradePct = pct(hovD.tradePnl, hovD.solIn);
          // Single wallet label (non-merged point)
          const walletLabel = hovD.wallet
            ? (wallets.find(w => w.hash === hovD.wallet || w.address === hovD.wallet)?.label ?? hovD.wallet.slice(0,6) + "…")
            : null;
          // Merged point: show per-wallet breakdown
          const breakdown = hovD.walletBreakdown ?? null;
          const breakdownRows = breakdown
            ? breakdown.map(b => ({
                label: wallets.find(w => w.hash === b.wallet || w.address === b.wallet)?.label ?? b.wallet?.slice(0,6) ?? "?",
                net: b.net,
              }))
            : null;
          const extraRows = breakdownRows ? breakdownRows.length : (walletLabel ? 1 : 0);
          const hasShare = !!onPointClick;
          const baseH = tradePct ? 90 : 76;
          const TW = breakdown ? 190 : 168;
          const TH = baseH + extraRows * 13 + (hasShare ? 14 : 0);
          const tx = hovP.x + TW + 12 > W ? hovP.x - TW - 8 : hovP.x + 12;
          const ty = Math.max(PAD.top, Math.min(H - PAD.bottom - TH, hovP.y - TH / 2));
          let y = ty;
          return (
            <g key="tooltip">
              <rect x={tx} y={ty} width={TW} height={TH} fill={S.bgCard} stroke={col} strokeWidth="1" opacity="0.97" />
              <rect x={tx} y={ty} width={3} height={TH} fill={col} />
              <text x={tx+10} y={(y+=16)} fill={hovD.isStable ? "#888899" : S.textMid} fontSize="10" fontFamily="DM Mono" fontWeight="bold">
                {hovD.label}{hovD.isStable ? " (stable)" : ""}
              </text>
              <text x={tx+10} y={(y+=14)} fill={S.textDim} fontSize="9"  fontFamily="DM Mono">{hovD.time}</text>
              <text x={tx+10} y={(y+=16)} fill={pnlC(hovD.tradePnl)} fontSize="10" fontFamily="DM Mono">
                trade {fmtC(hovD.tradePnl, S)}
              </text>
              {tradePct && (
                <text x={tx+10} y={(y+=16)} fill={pnlC(hovD.tradePnl)} fontSize="11" fontFamily="DM Mono" fontWeight="bold">
                  {hovD.tradePnl >= 0 ? "+" : ""}{tradePct}%
                </text>
              )}
              {!tradePct && void (y += 0)}
              <text x={tx+10} y={(y+=16)} fill={pnlC(hovD.cumPnl)} fontSize="9" fontFamily="DM Mono">
                total: {fmtC(hovD.cumPnl, S)}
              </text>
              {/* Per-wallet breakdown for merged points */}
              {breakdownRows && breakdownRows.map((b, bi) => (
                <text key={bi} x={tx+10} y={(y+=13)} fill={pnlC(b.net)} fontSize="8" fontFamily="DM Mono">
                  {b.label}: {fmtC(b.net, S)}
                </text>
              ))}
              {/* Single wallet label for non-merged points */}
              {!breakdownRows && walletLabel && (
                <text x={tx+10} y={(y+=13)} fill={S.textDim} fontSize="8" fontFamily="DM Mono">
                  {walletLabel}
                </text>
              )}
              {/* Click to share hint */}
              {hasShare && (
                <text x={tx+10} y={(y+=14)} fill={S.textDim} fontSize="8" fontFamily="DM Mono" opacity="0.5">
                  click to share
                </text>
              )}
            </g>
          );
        })()}
        {/* X-axis ticker labels — clickable terminal links, below data area */}
        {(() => {
          const maxLabels = Math.floor(innerW / 52);
          const step = Math.max(1, Math.ceil((points.length - 1) / maxLabels));
          return points.filter((_, i) => i > 0 && (i % step === 0 || i === points.length - 1)).map((p) => {
            const url = p.d.mint ? terminalUrl(S.terminalId ?? "padre", p.d.mint) : null;
            return (
              <g key={`tick_${p.d.label}_${p.d.idx ?? p.d.time}`}
                transform={`translate(${p.x},${H - PAD.bottom + 18})`}
                onClick={() => url && window.open(url, "_blank", "noopener")}
                style={{ cursor: url ? "pointer" : "default" }}>
                <text textAnchor="middle" fill={url ? ptColor(p.d.tradePnl) : S.textDim}
                  fontSize="8" fontFamily="DM Mono"
                  style={{ textDecoration: url ? "underline" : "none", opacity: 0.8 }}>
                  {p.d.label}
                </text>
              </g>
            );
          });
        })()}
      </svg>
    </div>
  );
}

function BarTip({ active, payload, S }) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  const col = d.payload?.tradePnl >= 0 ? S.accentGreen : S.accentRed;
  const val = Math.abs(d.value);
  const decimals = S.pnlHistoDecimals ?? 4;
  return (
    <div style={{ background: S.bgBase, border: `1px solid ${S.borderColor}`, padding: "8px 12px", fontFamily: "'DM Mono',monospace", fontSize: 11, pointerEvents: "none" }}>
      <div style={{ color: col, fontWeight: 600, marginBottom: 3 }}>{d.payload.label}</div>
      <div style={{ color: S.textMid }}>pnl: <span style={{ color: col }}>{fmtC(d.value, S, decimals)}</span></div>
    </div>
  );
}

function GlowCursor({ x, y, width, height, fill = "#00ffb4" }) {
  const cx = x + width / 2;
  return (
    <g>
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={fill} strokeWidth="1" opacity="0.25" strokeDasharray="3,3" />
      <circle cx={cx} cy={y} r="4" fill={fill} opacity="0.8" style={{ filter: `drop-shadow(0 0 4px ${fill})` }} />
    </g>
  );
}

// ── CALENDAR HEATMAP ──────────────────────────────────────────────────────────
function buildDayMap(trades, tzOffset = 0) {
  // Returns { "YYYY-MM-DD": { pnl, trades, wins, losses, volBought, volSold } }
  // PnL attributed to the day of the last sell for each wallet:mint position.
  const toLocalDay = (ts) => {
    const ms = new Date(ts).getTime() + tzOffset * 3600000;
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), day = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  };
  const map = {};
  const pos = {};

  for (const t of [...trades].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const tMint = t.mint ?? t.token;
    const tStable = isStablecoin(tMint, t.token);
    const day = toLocalDay(t.ts);
    if (!map[day]) map[day] = { pnl: 0, trades: 0, wins: 0, losses: 0, volBought: 0, volSold: 0 };
    // Count trades + volume, but skip stable volume from vol stats
    map[day].trades++;
    if (!tStable) {
      if (t.type === "buy")  map[day].volBought += t.sol || 0;
      if (t.type === "sell") map[day].volSold   += t.sol || 0;
    }

    const k = (t.wallet ? `${t.wallet}:` : "") + tMint;
    // Store token symbol in pos so isStablecoin can use it as fallback
    if (!pos[k]) pos[k] = { solIn: 0, solOut: 0, lastSellDay: null, lastDay: day, token: t.token, mint: tMint };
    pos[k].lastDay = day;
    if (t.type === "buy")  pos[k].solIn  += t.sol;
    else if (t.type === "sell") { pos[k].solOut += t.sol; pos[k].lastSellDay = day; }
  }

  // Attribute each position's net PnL to its close day — skip stablecoins
  for (const p of Object.values(pos)) {
    // p.mint and p.token are now stored — symbol fallback works correctly
    if (isStablecoin(p.mint, p.token)) continue;
    const day = p.lastSellDay ?? p.lastDay;
    if (!map[day]) map[day] = { pnl: 0, trades: 0, wins: 0, losses: 0, volBought: 0, volSold: 0 };
    const net = p.solOut - p.solIn;
    map[day].pnl += net;
    if (net > 0) map[day].wins++; else if (net < 0) map[day].losses++;
  }

  return map;
}

function CalendarHeatmap({ trades, tf, tzOffset = 0, S, onDayClick }) {
  const pnlColor = (n) => n > 0 ? S.accentGreen : n < 0 ? S.accentRed : S.textMid;
  const [hovDay, setHovDay] = useState(null);
  const [hovPos, setHovPos] = useState({ x: 0, y: 0 });
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [hovMonth, setHovMonth] = useState(null);
  const [hovMonthPos, setHovMonthPos] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const [containerW, setContainerW] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(e => setContainerW(e[0].contentRect.width));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setCalYear(new Date().getFullYear()); }, [tf]);

  const dayMap = useMemo(() => buildDayMap(trades, tzOffset), [trades, tzOffset]);
  const pnlValues = Object.values(dayMap).map(d => d.pnl).filter(v => v !== 0);
  const maxAbs = pnlValues.length ? Math.max(...pnlValues.map(Math.abs)) : 1;

  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const DAYS = ["M","T","W","T","F","S","S"];

  // Build weeks
  const weeks = useMemo(() => {
    const jan1 = new Date(calYear, 0, 1);
    const dec31 = new Date(calYear, 11, 31);
    const start = new Date(jan1);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    const end = new Date(dec31);
    end.setDate(end.getDate() + (6 - (end.getDay() + 6) % 7));
    const localIso = (d) => {
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
      return `${y}-${m}-${day}`;
    };
    const allWeeks = []; let week = []; const cur = new Date(start);
    while (cur <= end) {
      week.push({ date: localIso(cur), inYear: cur.getFullYear() === calYear });
      if (week.length === 7) { allWeeks.push(week); week = []; }
      cur.setDate(cur.getDate() + 1);
    }
    return allWeeks;
  }, [calYear]);

  // Dynamic cell size to fill container width (accounting for day labels ~20px)
  const nWeeks = weeks.length;
  const GAP = 2;
  const CELL = Math.max(10, Math.floor((containerW - 24 - nWeeks * GAP) / nWeeks));

  const dayColor = (day) => {
    const d = dayMap[day];
    if (!d || d.pnl === 0) return S.bgCard;
    const base = d.pnl > 0 ? S.accentGreen : S.accentRed;
    const intensity = Math.min(1, Math.abs(d.pnl) / maxAbs);
    const alpha = Math.round((0.15 + intensity * 0.85) * 255).toString(16).padStart(2,"0");
    return base + alpha;
  };
  const dayGlow = (day) => {
    const d = dayMap[day];
    if (!d || d.pnl === 0) return "none";
    const base = d.pnl > 0 ? S.accentGreen : S.accentRed;
    const intensity = Math.min(1, Math.abs(d.pnl) / maxAbs);
    return `0 0 ${6 + intensity * 10}px ${base}${Math.round(intensity * 0.6 * 255).toString(16).padStart(2,"0")}`;
  };

  const monthLabels = useMemo(() => {
    const labels = [];
    weeks.forEach((week, wi) => {
      const firstInYear = week.find(d => d.inYear);
      if (!firstInYear) return;
      const date = new Date(firstInYear.date);
      if (date.getDate() <= 7) labels.push({ month: MONTHS[date.getMonth()], x: wi * (CELL + GAP) });
    });
    return labels;
  }, [weeks, CELL]);

  const yearStats = useMemo(() => {
    const days = Object.entries(dayMap).filter(([d]) => d.startsWith(String(calYear)));
    const totalPnl   = days.reduce((s, [, v]) => s + v.pnl, 0);
    const tradeDays  = days.filter(([, v]) => v.trades > 0).length;
    const winDays    = days.filter(([, v]) => v.pnl > 0).length;
    const lossDays   = days.filter(([, v]) => v.pnl < 0).length;
    const bestDay    = days.reduce((b, [d, v]) => v.pnl > 0 && v.pnl > (b?.pnl ?? -Infinity) ? { date: d, ...v } : b, null);
    const worstDay   = days.reduce((w, [d, v]) => v.pnl < 0 && v.pnl < (w?.pnl ?? Infinity)  ? { date: d, ...v } : w, null);
    return { totalPnl, tradeDays, winDays, lossDays, bestDay, worstDay };
  }, [dayMap, calYear]);

  const hovData = hovDay ? dayMap[hovDay] : null;

  return (
    <div className="fade-up">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div className="ts-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: "#fff", letterSpacing: ".12em", marginBottom: 2 }}>ACTIVITY CALENDAR</div>
          <div className="ts-dim" style={{ fontSize: 9, color: S.textDim, letterSpacing: ".1em" }}>FULL HISTORY · CLOSED POSITIONS · CLICK DAY FOR SHARE CARD</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button className="sb" onClick={() => setCalYear(y => y - 1)} style={{ padding: "4px 10px", "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }}>←</button>
          <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: "#fff", minWidth: 48, textAlign: "center" }}>{calYear}</span>
          <button className="sb" onClick={() => setCalYear(y => y + 1)} style={{ padding: "4px 10px", "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }} disabled={calYear >= new Date().getFullYear()}>→</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 14 }}>
        {[
          { label: "YEAR PnL",    val: fmtC(yearStats.totalPnl, S), color: yearStats.totalPnl >= 0 ? S.accentGreen : S.accentRed },
          { label: "ACTIVE DAYS", val: yearStats.tradeDays,  color: S.textPrimary },
          { label: "GREEN DAYS",  val: yearStats.winDays,    color: S.accentGreen },
          { label: "RED DAYS",    val: yearStats.lossDays,   color: S.accentRed },
          { label: "BEST DAY",    val: yearStats.bestDay  ? fmtC(yearStats.bestDay.pnl, S)  : "—", color: S.accentBest ?? "#ffd700" },
          { label: "WORST DAY",   val: yearStats.worstDay ? fmtC(yearStats.worstDay.pnl, S)      : "—", color: S.accentRed },
        ].map(s => (
          <BorderCard key={s.label} S={S} style={{ padding: "11px 14px" }}>
            <div style={{ color: S.textDim, fontSize: 9, letterSpacing: ".12em", marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13, color: s.color, textShadow: `0 0 10px ${s.color}44` }}>{s.val}</div>
          </BorderCard>
        ))}
      </div>

      <BorderCard S={S} style={{ padding: "20px 24px 16px" }}>
        <div ref={containerRef} style={{ width: "100%" }}>
          <div style={{ position: "relative" }}>
            {/* Day labels */}
            <div style={{ position: "absolute", left: -18, top: 18 }}>
              {DAYS.map((d, i) => (
                <div key={i} style={{ height: CELL + GAP, display: "flex", alignItems: "center", fontSize: 8, color: S.textDim, fontFamily: "'DM Mono',monospace", lineHeight: 1 }}>{i % 2 === 1 ? d : ""}</div>
              ))}
            </div>
            {/* Month labels */}
            <div style={{ display: "flex", position: "relative", height: 14, marginBottom: 4 }}>
              {monthLabels.map((ml, i) => (
                <div key={i} style={{ position: "absolute", left: ml.x, fontSize: 8, color: S.textDim, fontFamily: "'Orbitron',monospace", letterSpacing: ".08em" }}>{ml.month}</div>
              ))}
            </div>
            {/* Grid */}
            <div style={{ display: "flex", gap: GAP }}>
              {weeks.map((week, wi) => (
                <div key={wi} style={{ display: "flex", flexDirection: "column", gap: GAP }}>
                  {week.map((day, di) => {
                    const hasData  = dayMap[day.date];
                    const isHov    = hovDay === day.date;
                    const isBest   = yearStats.bestDay?.date  === day.date;
                    const isWorst  = yearStats.worstDay?.date === day.date;
                    const accentBest = S.accentBest ?? "#ffd700";
                    return (
                      <div key={di} style={{
                        width: CELL, height: CELL,
                        background: day.inYear
                          ? isBest  ? accentBest
                          : isWorst ? S.accentRed
                          : dayColor(day.date)
                          : "transparent",
                        border: day.inYear
                          ? `1px solid ${hasData && !isBest && !isWorst ? "transparent" : isBest ? accentBest : isWorst ? S.accentRed : S.borderColor}`
                          : "none",
                        boxShadow: isHov
                          ? `0 0 0 1px ${S.accentGreen}`
                          : isBest  ? `0 0 5px ${accentBest}99`
                          : isWorst ? `0 0 5px ${S.accentRed}99`
                          : day.inYear && hasData ? dayGlow(day.date) : "none",
                        cursor: hasData && onDayClick ? "pointer" : "default",
                        transition: "box-shadow .1s",
                      }}
                        onMouseEnter={e => { if (day.inYear) { setHovDay(day.date); setHovPos({ x: e.clientX, y: e.clientY }); } }}
                        onMouseMove={e => setHovPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHovDay(null)}
                        onClick={() => hasData && onDayClick && onDayClick(day.date)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Legend */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
              <span className="ts-small" style={{ fontSize: 8, color: S.textDim, fontFamily: "'DM Mono',monospace" }}>LESS</span>
              {[0.12, 0.35, 0.55, 0.75, 1.0].map((op, i) => (
                <div key={i} style={{ width: CELL, height: CELL, background: `rgba(${parseInt(S.accentGreen.slice(1,3),16)},${parseInt(S.accentGreen.slice(3,5),16)},${parseInt(S.accentGreen.slice(5,7),16)},${op})` }} />
              ))}
              <span className="ts-small" style={{ fontSize: 8, color: S.textDim, fontFamily: "'DM Mono',monospace" }}>MORE</span>
            </div>
          </div>
        </div>
      </BorderCard>

      {/* Monthly breakdown */}
      <div style={{ marginTop: 14 }}>
        <div className="ts-mono" style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: S.textDim, letterSpacing: ".12em", marginBottom: 10 }}>MONTHLY BREAKDOWN</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
          {MONTHS.map((month, mi) => {
            const monthKey = `${calYear}-${String(mi + 1).padStart(2, "0")}`;
            const monthDays = Object.entries(dayMap).filter(([d]) => d.startsWith(monthKey));
            const pnl      = monthDays.reduce((s, [, v]) => s + v.pnl, 0);
            const trades   = monthDays.reduce((s, [, v]) => s + v.trades, 0);
            const winDays  = monthDays.filter(([, v]) => v.pnl > 0).length;
            const lossDays = monthDays.filter(([, v]) => v.pnl < 0).length;
            const volBought = monthDays.reduce((s, [, v]) => s + (v.volBought || 0), 0);
            const volSold   = monthDays.reduce((s, [, v]) => s + (v.volSold   || 0), 0);
            const activeDays = monthDays.filter(([, v]) => v.trades > 0).length;
            const isEmpty = trades === 0;
            return (
              <div key={month}
                onClick={() => !isEmpty && onDayClick && onDayClick(monthKey)}
                onMouseEnter={e => { if (!isEmpty) { setHovMonth({ key: monthKey, pnl, trades, winDays, lossDays, activeDays, volBought, volSold }); setHovMonthPos({ x: e.clientX, y: e.clientY }); } }}
                onMouseMove={e => setHovMonthPos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHovMonth(null)}
                style={{ padding: "10px 12px", opacity: isEmpty ? 0.35 : 1,
                  cursor: !isEmpty && onDayClick ? "pointer" : "default",
                  background: S.bgCard, border: `1px solid ${S.borderColor}`,
                  transition: "border-color .12s" }}>
                <div className="ts-dim" style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: S.textDim, letterSpacing: ".1em", marginBottom: 6 }}>{month}</div>
                <div className="ts-mono" style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 12, color: pnlColor(pnl), textShadow: isEmpty ? "none" : `0 0 8px ${pnlColor(pnl)}44`, marginBottom: 4 }}>
                  {isEmpty ? "—" : fmtC(pnl, S)}
                </div>
                {!isEmpty && (
                  <div className="ts-dim" style={{ fontSize: 9, color: S.textDim, fontFamily: "'DM Mono',monospace", lineHeight: 1.5 }}>
                    <span style={{ color: S.accentGreen }}>{winDays}W</span> · <span style={{ color: S.accentRed }}>{lossDays}L</span> / {activeDays}d
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating tooltips — portaled to document.body to escape CSS zoom */}
      {hovMonth && createPortal((() => {
        const m = hovMonth;
        const TW = 230, TH = 140;
        let lx = hovMonthPos.x + 16, ty = hovMonthPos.y - 10;
        if (lx + TW > window.innerWidth - 8) lx = hovMonthPos.x - TW - 8;
        if (ty + TH > window.innerHeight - 8) ty = window.innerHeight - TH - 8;
        const col = m.pnl >= 0 ? S.accentGreen : S.accentRed;
        return (
          <div className="sol-tooltip" style={{
            position: "fixed", left: lx, top: ty,
            background: S.bgCard, border: `1px solid ${col}`,
            padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontSize: 11,
            pointerEvents: "none", zIndex: 99999, whiteSpace: "nowrap",
            boxShadow: `0 0 16px ${col}22`,
          }}>
            <div className="sol-tt-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: S.textDim, letterSpacing: ".1em", marginBottom: 6 }}>{m.key}</div>
            <div className="sol-tt-val" style={{ color: col, fontWeight: 600, fontSize: 14, marginBottom: 6, textShadow: `0 0 8px ${col}55` }}>
              {fmtC(m.pnl, S, 4)}
            </div>
            <div style={{ color: S.textDim, marginBottom: 2 }}>
              Win / Loss days: <span style={{ color: S.accentGreen }}>{m.winDays}W</span> / <span style={{ color: S.accentRed }}>{m.lossDays}L</span> / {m.activeDays}d
            </div>
            <div style={{ color: S.textDim, marginBottom: 2 }}>Vol bought: <span style={{ color: S.textPrimary }}>{fmtC(m.volBought ?? 0, S, 3)}</span></div>
            <div style={{ color: S.textDim }}>Vol sold: <span style={{ color: S.textPrimary }}>{fmtC(m.volSold ?? 0, S, 3)}</span></div>
            {onDayClick && <div style={{ color: S.textDim, fontSize: 9, marginTop: 6, opacity: 0.6 }}>click to share</div>}
          </div>
        );
      })(), document.body)}
      {hovDay && createPortal((() => {
        const TW = 220, TH = hovData ? 140 : 60;
        let lx = hovPos.x + 16, ty = hovPos.y - 10;
        if (lx + TW > window.innerWidth - 8) lx = hovPos.x - TW - 8;
        if (ty + TH > window.innerHeight - 8) ty = window.innerHeight - TH - 8;
        return (
          <div className="sol-tooltip" style={{
            position: "fixed", left: lx, top: ty,
            background: S.bgCard, border: `1px solid ${hovData ? (hovData.pnl >= 0 ? S.accentGreen : S.accentRed) : S.borderColor}`,
            padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontSize: 11,
            pointerEvents: "none", zIndex: 99999, whiteSpace: "nowrap", minWidth: 190,
            boxShadow: hovData ? `0 0 18px ${hovData.pnl >= 0 ? S.accentGreen : S.accentRed}22` : "none",
          }}>
            <div className="sol-tt-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: S.textDim, letterSpacing: ".1em", marginBottom: 6 }}>
              {new Date(hovDay + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).toUpperCase()}
            </div>
            {hovData ? (
              <>
                <div className="sol-tt-val" style={{ color: hovData.pnl >= 0 ? S.accentGreen : S.accentRed, fontWeight: 600, fontSize: 14, marginBottom: 6, textShadow: `0 0 8px ${hovData.pnl >= 0 ? S.accentGreen : S.accentRed}55` }}>
                  {fmtC(hovData.pnl, S, 4)}
                </div>
                <div style={{ color: S.textDim, marginBottom: 2 }}>Wins / Losses: <span style={{ color: S.accentGreen }}>{hovData.wins}</span> / <span style={{ color: S.accentRed }}>{hovData.losses}</span></div>
                <div style={{ color: S.textDim, marginBottom: 2 }}>Volume bought: <span style={{ color: S.textPrimary }}>{fmtC(hovData.volBought, S, 3)}</span></div>
                <div style={{ color: S.textDim }}>Volume sold: <span style={{ color: S.textPrimary }}>{fmtC(hovData.volSold, S, 3)}</span></div>
                {onDayClick && <div style={{ color: S.textDim, fontSize: 9, marginTop: 6, opacity: 0.6 }}>click to share</div>}
              </>
            ) : (
              <div style={{ color: S.textDim }}>No activity</div>
            )}
          </div>
        );
      })(), document.body)}
    </div>
  );
}

// ── TRADING JOURNAL ──────────────────────────────────────────────────────────
// Inline-editable table. Notes (entryMcap, exitMcap, thesis, mistake) stored in
// localStorage keyed by mint address. PnL auto-populated from closed positions.
const LS_JOURNAL = "soltrack_journal_v1";
function loadJournalNotes() {
  try { return JSON.parse(localStorage.getItem(LS_JOURNAL) || "{}"); } catch { return {}; }
}
function saveJournalNotes(notes) {
  try { localStorage.setItem(LS_JOURNAL, JSON.stringify(notes)); } catch {}
}

function JournalCell({ value, onChange, placeholder = "—", isNumber = false, S, mono = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef(null);

  const commit = () => {
    setEditing(false);
    onChange(draft);
  };

  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  if (!editing) {
    const isEmpty = !value && value !== 0;
    return (
      <div
        onClick={() => { setDraft(value ?? ""); setEditing(true); }}
        title="Click to edit"
        style={{
          cursor: "text", minHeight: 22, padding: "2px 6px", borderRadius: 2,
          color: isEmpty ? S.textDim : (mono ? S.accentGreen : S.textMid),
          fontFamily: mono ? "'DM Mono',monospace" : undefined,
          opacity: isEmpty ? 0.45 : 1,
          border: `1px solid transparent`,
          transition: "border-color .1s",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = S.borderColor}
        onMouseLeave={e => e.currentTarget.style.borderColor = "transparent"}
      >
        {isEmpty ? placeholder : (isNumber ? Number(value).toLocaleString() : value)}
      </div>
    );
  }

  if (isNumber) {
    return (
      <input
        ref={ref} type="number" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{ width: "100%", background: "#111", border: `1px solid ${S.accentGreen}55`,
          color: S.accentGreen, fontFamily: "'DM Mono',monospace", fontSize: 11, padding: "2px 6px",
          boxSizing: "border-box" }}
      />
    );
  }
  return (
    <textarea
      ref={ref} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
      rows={3}
      style={{ width: "100%", background: "#111", border: `1px solid ${S.accentGreen}55`,
        color: S.textMid, fontSize: 10, padding: "4px 6px", resize: "vertical",
        boxSizing: "border-box", fontFamily: "'DM Mono',monospace" }}
    />
  );
}


// ── WALLET SIDEBAR ────────────────────────────────────────────────────────────
function WalletLabel({ w, updateWallet, isActive, col, S, mono }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(w.label);
  const [showPalette, setShowPalette] = useState(false);
  const paletteRef = useRef(null);

  useEffect(() => { setDraft(w.label); }, [w.label]);

  // Close palette on outside click
  useEffect(() => {
    if (!showPalette) return;
    const handler = (e) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target)) setShowPalette(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPalette]);

  const commit = (labelVal) => {
    updateWallet(w.id, { label: labelVal.trim() || w.label });
    setEditing(false);
    setShowPalette(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, position: "relative", width: "100%" }}
        onClick={e => e.stopPropagation()}>
        {/* Color chip */}
        <div
          ref={paletteRef}
          style={{ position: "relative", flexShrink: 0 }}>
          <div
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setShowPalette(p => !p); }}
            title="Pick color"
            style={{ width: 12, height: 12, borderRadius: 2, background: col,
              cursor: "pointer", border: `1px solid ${col}88`,
              boxShadow: showPalette ? `0 0 0 1px ${S.accentGreen}` : "none",
              transition: "box-shadow .1s" }}
          />
          {showPalette && (
            <div style={{ position: "absolute", top: 16, left: 0, zIndex: 999,
              background: S.bgCard, border: `1px solid ${S.borderColor}`,
              padding: 6, display: "flex", flexWrap: "wrap", gap: 4, width: 100,
              boxShadow: "0 4px 16px rgba(0,0,0,0.6)" }}>
              {S.walletColors.map((c, i) => (
                <div key={i}
                  onMouseDown={e => { e.preventDefault(); updateWallet(w.id, { colorIdx: i }); setShowPalette(false); }}
                  style={{ width: 16, height: 16, background: c, borderRadius: 2, cursor: "pointer",
                    border: i === (w.colorIdx ?? 0) ? `1.5px solid #fff` : `1px solid ${c}44`,
                    boxSizing: "border-box", transition: "transform .1s" }}
                  onMouseEnter={e => e.currentTarget.style.transform = "scale(1.25)"}
                  onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
                />
              ))}
            </div>
          )}
        </div>
        {/* Label input */}
        <input
          value={draft}
          autoFocus
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") commit(draft);
            if (e.key === "Escape") { setDraft(w.label); setEditing(false); setShowPalette(false); }
          }}
          style={{ flex: 1, minWidth: 0, background: "#111", border: `1px solid ${col}55`,
            color: col, fontFamily: "'DM Mono',monospace", fontSize: 10,
            padding: "1px 4px", outline: "none", boxSizing: "border-box" }}
        />
      </div>
    );
  }

  return (
    <div className="ts-mono"
      onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
      title="Double-click to rename / pick color"
      style={{ ...mono, fontSize: 10, color: isActive ? col : S.textMid,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "text" }}>
      {w.label}
    </div>
  );
}

function WalletRow({
  w, showArchiveBtn = true,
  syncStates, syncing, loading, errors, activeWallets, balances,
  toggleWallet, refreshWallet, syncHistory, updateWallet, removeWallet,
  getColor, S, mono, dim, green, border,
}) {
  const ss = syncStates[w.address];
  const isSyncing = syncing[w.id];
  const isLoading = !!loading[w.id];
  const isActive = activeWallets.has(w.id);
  const isArchived = !!(w.archived);
  const isExcluded = !!(w.excludeAll);
  const col = getColor(w);
  return (
    <div style={{ borderBottom: `1px solid ${border}18`, opacity: isArchived ? 0.65 : 1 }}>
      <div onClick={() => toggleWallet(w.id)}
        style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 12px",
          cursor: "pointer", borderLeft: `2px solid ${isActive ? col : "transparent"}`,
          background: isActive ? `${col}08` : "transparent", transition: "all .12s" }}>
        <div
          onClick={e => { e.stopPropagation(); updateWallet(w.id, { excludeAll: !isExcluded }); }}
          title={isExcluded ? "Excluded from ALL — click to include" : "Included in ALL — click to exclude"}
          style={{ flexShrink: 0, cursor: "pointer", lineHeight: 1, width: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {isExcluded
            ? <span style={{ fontSize: 16, lineHeight: 1, color: col, opacity: 0.9, fontWeight: 700 }}>⊘</span>
            : <div style={{ width: 14, height: 14, borderRadius: "50%", background: col,
                boxShadow: isActive ? `0 0 8px ${col}99` : "none", transition: "all .15s" }}/>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WalletLabel w={w} updateWallet={updateWallet} isActive={isActive} col={col} S={S} mono={mono} />
          <div className="ts-small" style={{ ...mono, fontSize: 7, color: dim, marginTop: 1,
            userSelect: S.privacyMode ? "none" : "text",
            filter: S.privacyMode ? "blur(4px)" : "none", transition: "filter .2s" }}>
            {w.address}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 10px 4px 21px" }}>
        {balances[w.address] !== undefined && (
          <span className="ts-small" style={{ ...mono, fontSize: 8, color: S.accentGreen, marginRight: 3 }}>
            {balances[w.address].toFixed(3)} SOL
          </span>
        )}
        <span className="ts-small" style={{ ...mono, fontSize: 7, color: dim, flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {(isLoading || isSyncing)
            ? <span style={{ color: S.accentPurple }}>{isLoading ? `${loading[w.id]?.progress ?? 0}tx…` : "syncing…"}</span>
            : ss ? `${ss.totalFetched > 0 ? ss.totalFetched + "tx" : ""}${ss.lastSync ? ` · ${new Date(ss.lastSync).toLocaleDateString("en-US",{month:"numeric",day:"numeric"})}` : ""}` : ""}
        </span>
        {errors[w.id] && (
          <span style={{ ...mono, fontSize: 7, color: S.accentRed }} title={errors[w.id]}>ERR</span>
        )}
        <button onClick={e => { e.stopPropagation(); refreshWallet(w.id); }}
          disabled={isLoading || isSyncing} title="Sync + refresh"
          style={{ background: "none", border: "none", color: (isLoading||isSyncing)?S.accentPurple:dim,
            cursor:(isLoading||isSyncing)?"default":"pointer", fontSize:10, padding:"1px 4px", lineHeight:1 }}
          onMouseEnter={e => { if (!isLoading&&!isSyncing) e.currentTarget.style.color=green; }}
          onMouseLeave={e => { if (!isLoading&&!isSyncing) e.currentTarget.style.color=dim; }}>↺</button>
        <button onClick={e => { e.stopPropagation(); syncHistory(w.id, w.address); }}
          disabled={isSyncing} title="Full history backfill"
          style={{ background:"none", border:"none", color:isSyncing?S.accentPurple:dim,
            cursor:isSyncing?"default":"pointer", fontSize:9, padding:"1px 3px", lineHeight:1, ...mono }}
          onMouseEnter={e => { if (!isSyncing) e.currentTarget.style.color=S.accentPurple; }}
          onMouseLeave={e => { if (!isSyncing) e.currentTarget.style.color=dim; }}>↓</button>
        {showArchiveBtn && (
          <button onClick={e => { e.stopPropagation(); updateWallet(w.id, { archived: !isArchived }); }}
            title={isArchived ? "Unarchive wallet" : "Archive wallet (hidden but counted in ALL)"}
            style={{ background:"none", border:"none", color:isArchived?S.accentFee:dim,
              cursor:"pointer", fontSize:9, padding:"1px 3px", lineHeight:1, opacity:isArchived?1:0.5 }}
            onMouseEnter={e => { e.currentTarget.style.color=S.accentFee; e.currentTarget.style.opacity="1"; }}
            onMouseLeave={e => { e.currentTarget.style.color=isArchived?S.accentFee:dim; e.currentTarget.style.opacity=isArchived?"1":"0.5"; }}>
            {isArchived ? "⊞" : "⊟"}
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); removeWallet(w.id); }}
          title="Remove wallet"
          style={{ background:"none", border:"none", color:dim, cursor:"pointer", fontSize:10, padding:"1px 3px", lineHeight:1 }}
          onMouseEnter={e => e.currentTarget.style.color=S.accentRed}
          onMouseLeave={e => e.currentTarget.style.color=dim}>✕</button>
      </div>
    </div>
  );
}


function PresetNameBtn({ preset, isActive, onApply, onRename, green, border, S, mono }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preset.name);
  useEffect(() => { setDraft(preset.name); }, [preset.name]);
  if (editing) {
    return (
      <input
        value={draft}
        autoFocus
        onChange={e => setDraft(e.target.value.toUpperCase())}
        onBlur={() => { onRename(draft.trim() || preset.name); setEditing(false); }}
        onKeyDown={e => {
          if (e.key === "Enter") { onRename(draft.trim() || preset.name); setEditing(false); }
          if (e.key === "Escape") { setDraft(preset.name); setEditing(false); }
        }}
        style={{ flex: 1, background: "#111", border: `1px solid ${green}55`,
          color: green, fontFamily: "'DM Mono',monospace", fontSize: 9,
          padding: "3px 7px", outline: "none", minWidth: 0 }}
      />
    );
  }
  return (
    <button
      onClick={onApply}
      onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
      title="Click to apply · Double-click to rename"
      style={{ flex: 1, background: isActive ? `${green}18` : "none",
        border: `1px solid ${isActive ? green : border}`,
        color: isActive ? green : S.textMid,
        cursor: "pointer", padding: "3px 7px", fontSize: 9, ...mono,
        textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        boxShadow: isActive ? `0 0 6px ${green}33` : "none",
        transition: "all .12s" }}>
      {isActive && <span style={{ marginRight: 4, fontSize: 7 }}>▶</span>}
      {preset.name}
    </button>
  );
}

function ArchiveSection({ wallets, rowProps, border, dim, mono, S }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: `1px solid ${border}` }}>
      <div onClick={() => setOpen(p => !p)}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
          cursor: "pointer", opacity: 0.6, userSelect: "none" }}>
        <span style={{ color: S.accentFee, fontSize: 8, lineHeight: 1 }}>{open ? "▾" : "▸"}</span>
        <span style={{ ...mono, fontSize: 7, color: dim, letterSpacing: ".1em" }}>
          ARCHIVED ({wallets.length})
        </span>
        <span style={{ ...mono, fontSize: 7, color: dim, marginLeft: "auto" }}>in ALL stats</span>
      </div>
      {open && wallets.map(w => <WalletRow key={w.id} w={w} {...rowProps} />)}
    </div>
  );
}


// ── WALLET KANBAN ──────────────────────────────────────────────────────────────
// Uses dataTransfer for drag data (not React state) to avoid re-render killing drag
function WalletKanban({ wallets, S, setSetting, onClose }) {
  const presets      = S.walletPresets ?? [];
  const walletColors = S.walletColors  ?? [];
  const mono  = { fontFamily: "'DM Mono',monospace" };
  const green = S.accentGreen;
  const dim   = S.textDim;
  const border = S.borderColor;

  const [cols, setCols]         = useState(() => presets.map(p => ({ ...p, walletIds: [...p.walletIds] })));
  const [dragOver, setDragOver] = useState(null); // colId | "palette" | null
  const [newColName, setNewColName] = useState("");
  const [showNewCol, setShowNewCol] = useState(false);
  const [hovPill, setHovPill]   = useState(null); // "colId:walletId"

  const getColor  = (w) => walletColors[w.colorIdx % walletColors.length] ?? green;
  const getWallet = (id) => wallets.find(w => w.id === id);
  const paletteWallets = wallets.filter(w => !w.archived);

  // Encode drag payload in dataTransfer — avoids React re-render killing drag
  const DRAG_KEY = "application/x-soltrack-pill";

  const handleDragStart = (e, walletId, fromColId) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_KEY, JSON.stringify({ walletId, fromColId: fromColId ?? null }));
  };

  const getDragPayload = (e) => {
    try { return JSON.parse(e.dataTransfer.getData(DRAG_KEY)); } catch { return null; }
  };

  const handleDropOnCol = (e, toColId) => {
    e.preventDefault();
    const p = getDragPayload(e);
    if (!p) return;
    setCols(prev => prev.map(c => {
      if (p.fromColId !== null && c.id === p.fromColId && p.fromColId !== toColId)
        return { ...c, walletIds: c.walletIds.filter(id => id !== p.walletId) };
      if (c.id === toColId)
        return c.walletIds.includes(p.walletId) ? c : { ...c, walletIds: [...c.walletIds, p.walletId] };
      return c;
    }));
    setDragOver(null);
  };

  const handleDropOnPalette = (e) => {
    e.preventDefault();
    const p = getDragPayload(e);
    if (!p || p.fromColId === null) { setDragOver(null); return; }
    setCols(prev => prev.map(c =>
      c.id === p.fromColId ? { ...c, walletIds: c.walletIds.filter(id => id !== p.walletId) } : c
    ));
    setDragOver(null);
  };

  const removeFromCol = (colId, walletId) =>
    setCols(p => p.map(c => c.id === colId ? { ...c, walletIds: c.walletIds.filter(id => id !== walletId) } : c));

  const deleteCol = (colId) => setCols(p => p.filter(c => c.id !== colId));

  const addCol = () => {
    if (!newColName.trim()) return;
    setCols(p => [...p, { id: Date.now(), name: newColName.trim().toUpperCase(), walletIds: [] }]);
    setNewColName(""); setShowNewCol(false);
  };

  const save = () => {
    const updated = cols.map(c => {
      const orig = presets.find(p => p.id === c.id);
      return orig ? { ...orig, walletIds: c.walletIds } : { id: c.id, name: c.name, walletIds: c.walletIds };
    });
    setSetting("walletPresets", updated);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.75)",
      backdropFilter: "blur(4px)", display: "flex", flexDirection: "column" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ margin: "40px auto", width: "min(96vw, 1100px)", maxHeight: "80vh",
        background: S.bgBase, border: `1px solid ${border}`, display: "flex",
        flexDirection: "column", overflow: "hidden" }}>

        {/* Title bar */}
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: "#fff", letterSpacing: ".15em" }}>
            WALLET ORGANIZER
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} style={{ ...mono, background: green, border: "none", color: "#000",
              fontSize: 9, padding: "5px 16px", cursor: "pointer", fontWeight: 700, letterSpacing: ".1em" }}>
              SAVE
            </button>
            <button onClick={onClose} style={{ ...mono, background: "none", border: `1px solid ${border}`,
              color: dim, fontSize: 9, padding: "5px 12px", cursor: "pointer" }}>
              CANCEL
            </button>
          </div>
        </div>

        {/* Palette strip */}
        <div onDragOver={e => { e.preventDefault(); setDragOver("palette"); }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }}
          onDrop={handleDropOnPalette}
          style={{ padding: "8px 12px", borderBottom: `1px solid ${border}`, flexShrink: 0,
            background: dragOver === "palette" ? `${S.accentRed}12` : "transparent", transition: "background .15s" }}>
          <div style={{ ...mono, fontSize: 7, color: dim, letterSpacing: ".12em", marginBottom: 6 }}>
            PALETTE — drag to a preset column to add · drag back here to remove
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {paletteWallets.map(w => {
              const color = getColor(w);
              const key = `palette:${w.id}`;
              const isHov = hovPill === key;
              return (
                <div key={w.id} draggable
                  onDragStart={e => handleDragStart(e, w.id, null)}
                  onMouseEnter={() => setHovPill(key)}
                  onMouseLeave={() => setHovPill(null)}
                  style={{ display: "inline-flex", alignItems: "center", padding: "4px 10px",
                    margin: "2px 3px", background: color + "22", border: `1px solid ${color}55`,
                    cursor: "grab", userSelect: "none", position: "relative" }}>
                  <span style={{ ...mono, fontSize: 10, color, fontWeight: 600 }}>
                    {w.label || w.address.slice(0,6) + "…"}
                  </span>
                </div>
              );
            })}
            {paletteWallets.length === 0 && (
              <span style={{ ...mono, fontSize: 9, color: dim, opacity: 0.5 }}>No wallets yet</span>
            )}
          </div>
        </div>

        {/* Columns */}
        <div style={{ flex: 1, overflowX: "auto", overflowY: "hidden",
          display: "flex", gap: 10, padding: "14px", alignItems: "flex-start" }}>
          {cols.map(col => {
            const isOver = dragOver === col.id;
            return (
              <div key={col.id}
                onDragOver={e => { e.preventDefault(); setDragOver(col.id); }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }}
                onDrop={e => handleDropOnCol(e, col.id)}
                style={{ minWidth: 180, maxWidth: 180, background: isOver ? `${green}0a` : S.bgCard,
                  border: `1px solid ${isOver ? green : border}`, flexShrink: 0,
                  display: "flex", flexDirection: "column", transition: "border-color .15s, background .15s" }}>
                {/* Col header */}
                <div style={{ padding: "7px 8px 6px", borderBottom: `1px solid ${border}`,
                  display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ ...mono, fontSize: 9, color: green, letterSpacing: ".12em", fontWeight: 700 }}>
                    {col.name}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ ...mono, fontSize: 8, color: dim }}>{col.walletIds.length}</span>
                    <button onClick={() => deleteCol(col.id)}
                      title="Delete preset"
                      style={{ background: "none", border: "none", color: dim, cursor: "pointer",
                        fontSize: 10, padding: "0 2px", lineHeight: 1, opacity: 0.5 }}
                      onMouseEnter={e => { e.currentTarget.style.color = S.accentRed; e.currentTarget.style.opacity = "1"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = dim; e.currentTarget.style.opacity = "0.5"; }}>
                      ✕
                    </button>
                  </div>
                </div>
                {/* Pills */}
                <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px", minHeight: 80 }}>
                  {col.walletIds.map(id => {
                    const w = getWallet(id);
                    if (!w) return null;
                    const color = getColor(w);
                    const key = `${col.id}:${id}`;
                    const isHov = hovPill === key;
                    return (
                      <div key={id} draggable
                        onDragStart={e => handleDragStart(e, id, col.id)}
                        onMouseEnter={() => setHovPill(key)}
                        onMouseLeave={() => setHovPill(null)}
                        style={{ display: "inline-flex", alignItems: "center", padding: "4px 10px",
                          margin: "2px 3px", background: color + "22", border: `1px solid ${color}55`,
                          cursor: "grab", userSelect: "none", position: "relative" }}>
                        <span style={{ ...mono, fontSize: 10, color, fontWeight: 600 }}>
                          {w.label || w.address.slice(0,6) + "…"}
                        </span>
                        {isHov && (
                          <button onMouseDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); removeFromCol(col.id, id); }}
                            style={{ position: "absolute", top: -5, right: -5, width: 14, height: 14,
                              borderRadius: "50%", background: S.accentRed, border: "none",
                              color: "#fff", fontSize: 8, cursor: "pointer", display: "flex",
                              alignItems: "center", justifyContent: "center", padding: 0 }}>×</button>
                        )}
                      </div>
                    );
                  })}
                  {col.walletIds.length === 0 && (
                    <div style={{ ...mono, fontSize: 8, color: dim, opacity: 0.4, padding: "6px",
                      fontStyle: "italic", pointerEvents: "none" }}>drop here</div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add column */}
          {showNewCol ? (
            <div style={{ minWidth: 180, border: `1px dashed ${green}55`, padding: "12px 10px",
              display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
              <input autoFocus value={newColName}
                onChange={e => setNewColName(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === "Enter") addCol(); if (e.key === "Escape") setShowNewCol(false); }}
                placeholder="PRESET NAME"
                style={{ ...mono, background: "none", border: `1px solid ${border}`, color: "#fff",
                  fontSize: 10, padding: "6px 8px", outline: "none", letterSpacing: ".08em" }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={addCol} style={{ ...mono, background: green, border: "none",
                  color: "#000", fontSize: 8, padding: "4px 10px", cursor: "pointer", fontWeight: 700 }}>ADD</button>
                <button onClick={() => setShowNewCol(false)} style={{ ...mono, background: "none",
                  border: `1px solid ${border}`, color: dim, fontSize: 8, padding: "4px 8px", cursor: "pointer" }}>✕</button>
              </div>
            </div>
          ) : (
            <div onClick={() => setShowNewCol(true)}
              style={{ minWidth: 180, height: 80, border: `1px dashed ${border}`, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = green}
              onMouseLeave={e => e.currentTarget.style.borderColor = border}>
              <span style={{ ...mono, fontSize: 9, color: dim }}>+ NEW PRESET</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WalletSidebar({
  wallets, activeWallets, setActiveWallets, toggleWallet,
  syncStates, syncing, loading, errors,
  refreshWallet, syncHistory, removeWallet, updateWallet,
  showAdd, setSA, newAddr, setNA, newLabel, setNL, doAdd,
  S, getColor, setSetting,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showKanban, setShowKanban] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [showPresetInput, setShowPresetInput] = useState(false);
  const [balances, setBalances] = useState({});
  const { elRef: spotElRef, cvRef: spotCvRef } = useSpotlight();
  const presets = S.walletPresets ?? [];
  const mono = { fontFamily: "'DM Mono',monospace" };
  const bg   = S.bgCard;
  const border = S.borderColor;
  const dim  = S.textDim;
  const green = S.accentGreen;

  // Fetch SOL balances for all wallets via Helius RPC
  // Stable dep string for balance fetch — recalculated only when addresses actually change
  const _walletAddrs = wallets.map(w => w.address).join(",");
  useEffect(() => {
    if (!wallets.length) return;
    const key = S.heliusKey;
    const rpcUrl = key
      ? `https://mainnet.helius-rpc.com/?api-key=${key}`
      : "https://api.mainnet-beta.solana.com";
    let cancelled = false;
    // Batch all wallets into a single RPC request for efficiency + reliability
    const addrs = wallets.map(w => w.address);
    Promise.allSettled(addrs.map(addr =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [addr] }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          const lamports = j?.result?.value;
          return { address: addr, lamports: (lamports !== undefined && lamports !== null) ? lamports : null };
        })
        .catch(() => ({ address: addr, lamports: null }))
    )).then(results => {
      if (cancelled) return;
      const map = {};
      for (const r of results) {
        if (r.status === "fulfilled" && r.value?.lamports !== null)
          map[r.value.address] = r.value.lamports / 1e9;
      }
      setBalances(map);
    });
    return () => { cancelled = true; };
  }, [_walletAddrs, S.heliusKey]);

  const savePresets = (next) => setSetting("walletPresets", next);

  const addPreset = () => {
    const name = newPresetName.trim().toUpperCase();
    if (!name) return;
    const ids = activeWallets.has("combined")
      ? wallets.map(w => w.id)
      : [...activeWallets];
    savePresets([...presets, { id: Date.now(), name, walletIds: ids }]);
    setNewPresetName("");
    setShowPresetInput(false);
  };

  const deletePreset = (id) => savePresets(presets.filter(p => p.id !== id));

  const applyPreset = (preset) => {
    // If already active, deselect → back to ALL
    if (activePresetId === preset.id) {
      setActiveWallets(new Set(["combined"]));
      return;
    }
    const validIds = preset.walletIds.filter(id => wallets.some(w => w.id === id));
    if (validIds.length === 0 || validIds.length === wallets.length) {
      setActiveWallets(new Set(["combined"]));
    } else {
      setActiveWallets(new Set(validIds));
    }
  };

  const fetchPreset = (preset) => {
    const validIds = preset.walletIds.filter(id => wallets.some(w => w.id === id && !w.archived));
    (validIds.length ? validIds : wallets.filter(w => !w.archived).map(w => w.id)).forEach(id => refreshWallet(id));
  };

  // Determine which preset is currently active (if any)
  const activePresetId = (() => {
    if (!presets.length) return null;
    const active = activeWallets.has("combined")
      ? new Set(wallets.map(w => w.id))
      : activeWallets;
    return presets.find(p => {
      const valid = p.walletIds.filter(id => wallets.some(w => w.id === id));
      if (valid.length !== active.size) return false;
      return valid.every(id => active.has(id));
    })?.id ?? null;
  })();

  if (collapsed) {
    return (
      <div ref={spotElRef} style={{ width: 28, flexShrink: 0, background: bg, borderRight: `1px solid ${border}`,
        display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 16, gap: 8, position: "relative" }}>
        <canvas ref={spotCvRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }} />
        <button onClick={() => setCollapsed(false)}
          style={{ background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 4 }}
          title="Expand wallets">▶</button>
        {wallets.map(w => (
          <div key={w.id} style={{ width: 14, height: 14, borderRadius: "50%",
            background: activeWallets.has(w.id) || activeWallets.has("combined") ? getColor(w) : `${getColor(w)}44`,
            boxShadow: activeWallets.has(w.id) || activeWallets.has("combined") ? `0 0 6px ${getColor(w)}` : "none",
          }} title={w.label}/>
        ))}
      </div>
    );
  }

  const W = S.sidebarWidth ?? 210;

  return (
    <div ref={spotElRef} style={{ width: W, flexShrink: 0, background: bg, borderRight: `1px solid ${border}`,
      display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <canvas ref={spotCvRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }} />

      <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 12px 10px", borderBottom: `1px solid ${border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="ts-small" style={{ ...mono, fontSize: 8, letterSpacing: ".14em", color: dim }}>WALLETS</span>
          <button onClick={() => setShowKanban(true)} title="Organize presets"
            style={{ background: "none", border: `1px solid ${border}`, color: dim,
              cursor: "pointer", fontSize: 8, padding: "2px 6px", ...mono, letterSpacing: ".06em",
              lineHeight: 1.4, transition: "border-color .15s, color .15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = green; e.currentTarget.style.color = green; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = border; e.currentTarget.style.color = dim; }}>
            ⊞
          </button>
        </div>
        <button onClick={() => setCollapsed(true)}
          style={{ background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 2 }}
          title="Collapse">◀</button>
      </div>
      {showKanban && (
        <WalletKanban wallets={wallets} S={S} setSetting={setSetting} onClose={() => setShowKanban(false)} />
      )}

      {/* ── Presets (above wallet list) ── */}
        {presets.length > 0 && (
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${border}` }}>
            <div style={{ ...mono, fontSize: 7, color: dim, letterSpacing: ".12em", marginBottom: 5 }}>PRESETS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {presets.map(preset => {
                const isActive = activePresetId === preset.id;
                const anyLoading = preset.walletIds.some(id => (loading[id] || syncing[id]) && wallets.find(w => w.id === id && !w.archived));
                return (
                  <div key={preset.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {/* Name — click to apply, double-click to rename */}
                    <PresetNameBtn
                      preset={preset} isActive={isActive}
                      onApply={() => applyPreset(preset)}
                      onRename={name => savePresets(presets.map(p => p.id === preset.id ? { ...p, name } : p))}
                      green={green} border={border} S={S} mono={mono}
                    />
                    {/* Update wallets to current selection */}
                    <button
                      onClick={() => {
                        const ids = activeWallets.has("combined")
                          ? wallets.map(w => w.id)
                          : [...activeWallets];
                        savePresets(presets.map(p => p.id === preset.id ? { ...p, walletIds: ids } : p));
                      }}
                      title="Update preset to current wallet selection"
                      style={{ background: "none", border: `1px solid ${border}`, color: dim,
                        cursor: "pointer", fontSize: 9, padding: "3px 5px", lineHeight: 1, ...mono }}
                      onMouseEnter={e => { e.currentTarget.style.color = green; e.currentTarget.style.borderColor = `${green}55`; }}
                      onMouseLeave={e => { e.currentTarget.style.color = dim; e.currentTarget.style.borderColor = border; }}>
                      ⊙
                    </button>
                    <button
                      onClick={() => fetchPreset(preset)}
                      disabled={anyLoading}
                      title="Fetch all wallets in this preset"
                      style={{ background: "none", border: `1px solid ${border}`, color: anyLoading ? S.accentPurple : dim,
                        cursor: anyLoading ? "default" : "pointer", fontSize: 9, padding: "3px 5px", lineHeight: 1, ...mono }}
                      onMouseEnter={e => { if (!anyLoading) e.currentTarget.style.color = green; }}
                      onMouseLeave={e => { if (!anyLoading) e.currentTarget.style.color = dim; }}>
                      {anyLoading ? "…" : "↺"}
                    </button>
                    <button onClick={() => deletePreset(preset.id)}
                      style={{ background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 9, padding: "2px 4px" }}
                      onMouseEnter={e => e.currentTarget.style.color = S.accentRed}
                      onMouseLeave={e => e.currentTarget.style.color = dim}>×</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {/* ── Scrollable wallet list ── */}
      <div style={{ flex: 1, overflowY: "auto" }}>

        {/* ALL chip */}
        {wallets.length > 0 && (() => {
          const inAll = wallets.filter(w => !(w.excludeAll)).length;
          const excluded = wallets.filter(w => w.excludeAll).length;
          return (
          <div onClick={() => setActiveWallets(new Set(["combined"]))}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 12px",
              cursor: "pointer", borderLeft: `2px solid ${activeWallets.has("combined") ? green : "transparent"}`,
              background: activeWallets.has("combined") ? `${green}08` : "transparent",
              transition: "all .12s" }}>
            <div style={{ width: 14, height: 14, borderRadius: "50%",
              background: `linear-gradient(135deg,${S.accentPurple},${green})` }}/>
            <span className="ts-mono" style={{ ...mono, fontSize: 10, color: activeWallets.has("combined") ? green : S.textMid }}>
              ALL{" "}
              <span style={{ color: dim }}>({inAll})</span>
              {excluded > 0 && <span style={{ color: S.accentRed, fontSize: 8 }}> −{excluded}</span>}
            </span>
          </div>
          );
        })()}

        {/* Individual wallets */}
        {(() => {
          const rp = { syncStates, syncing, loading, errors, activeWallets, balances,
            toggleWallet, refreshWallet, syncHistory, updateWallet, removeWallet,
            getColor, S, mono, dim, green, border };
          const active   = wallets.filter(w => !w.archived);
          const archived = wallets.filter(w => w.archived);
          return (
            <>
              {active.map(w => <WalletRow key={w.id} w={w} {...rp} />)}
              {archived.length > 0 && (
                <ArchiveSection wallets={archived} rowProps={rp}
                  border={border} dim={dim} mono={mono} S={S} />
              )}
            </>
          );
        })()}

        {/* Add wallet */}
        <div style={{ padding: "8px 12px", borderTop: `1px solid ${border}`, marginTop: 4 }}>
          {showAdd ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <input className="sinp" placeholder="Wallet address..." value={newAddr}
                onChange={e => setNA(e.target.value)}
                onKeyDown={e => e.key === "Enter" && doAdd()}
                style={{ fontSize: 9, padding: "5px 7px" }}/>
              <input className="sinp" placeholder="Label..." value={newLabel}
                onChange={e => setNL(e.target.value)}
                onKeyDown={e => e.key === "Enter" && doAdd()}
                style={{ fontSize: 9, padding: "5px 7px" }}/>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="lbtn" onClick={doAdd} style={{ flex: 1, fontSize: 8, "--accent": green }}>FETCH</button>
                <button onClick={() => setSA(false)}
                  style={{ background: "none", border: `1px solid ${border}`, color: dim, cursor: "pointer", padding: "4px 8px", fontSize: 9 }}>✕</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setSA(true)}
              style={{ width: "100%", background: "none", border: `1px solid ${border}`, color: dim,
                cursor: "pointer", padding: "5px 8px", fontSize: 9, ...mono, letterSpacing: ".08em",
                transition: "color .12s, border-color .12s" }}
              onMouseEnter={e => { e.currentTarget.style.color = green; e.currentTarget.style.borderColor = `${green}55`; }}
              onMouseLeave={e => { e.currentTarget.style.color = dim; e.currentTarget.style.borderColor = border; }}>
              + ADD WALLET
            </button>
          )}
        </div>

        {/* Save preset */}
        {wallets.length > 1 && (
          <div style={{ padding: "4px 12px 10px" }}>
            {showPresetInput ? (
              <div style={{ display: "flex", gap: 4 }}>
                <input className="sinp" placeholder="Preset name..." value={newPresetName}
                  onChange={e => setNewPresetName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addPreset(); if (e.key === "Escape") setShowPresetInput(false); }}
                  style={{ flex: 1, fontSize: 9, padding: "3px 6px" }} autoFocus/>
                <button onClick={addPreset}
                  style={{ background: "none", border: `1px solid ${green}55`, color: green, cursor: "pointer", padding: "3px 7px", fontSize: 9 }}>✓</button>
              </div>
            ) : (
              <button onClick={() => setShowPresetInput(true)}
                style={{ background: "none", border: `1px dashed ${border}`, color: dim,
                  cursor: "pointer", padding: "3px 8px", fontSize: 7, ...mono, width: "100%",
                  letterSpacing: ".08em" }}
                title="Save current wallet selection as a preset">
                + SAVE AS PRESET
              </button>
            )}
          </div>
        )}
      </div>{/* scroll area */}
      </div>{/* z-index wrapper */}
    </div>
  );
}
function MistakeCell({ value, onChange, tags, S }) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(value ?? "");
  const mono = { fontFamily: "'DM Mono',monospace" };

  // Keep local text in sync when value changes externally
  useEffect(() => { setText(value ?? ""); }, [value]);

  const commit = (v) => onChange(v);

  const toggleTag = (tag) => {
    const cur = text;
    const lc = cur.toLowerCase();
    const tagLc = tag.toLowerCase();
    if (lc.includes(tagLc)) {
      // remove: try " · tag", "tag · ", bare "tag"
      let r = cur;
      r = r.replace(new RegExp(' \u00b7 ' + tag.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'gi'), '');
      r = r.replace(new RegExp(tag.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + ' \u00b7 ', 'gi'), '');
      r = r.replace(new RegExp(tag.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'gi'), '');
      r = r.trim().replace(/^\u00b7\s*|\s*\u00b7$/g, '').trim();
      setText(r);
      commit(r);
    } else {
      const next = tag + (cur ? ' \u00b7 ' + cur : '');
      setText(next);
      commit(next);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {/* Tag pills — shown on hover/focus, float above the input */}
      {(focused) && tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
          {tags.map(tag => {
            const active = text.toLowerCase().includes(tag.toLowerCase());
            return (
              <button key={tag}
                onMouseDown={e => { e.preventDefault(); toggleTag(tag); }}
                style={{
                  background: active ? `${S.accentRed}22` : `${S.bgBase}`,
                  border: `1px solid ${active ? S.accentRed : S.borderColor}`,
                  color: active ? S.accentRed : S.textDim,
                  fontFamily: "'DM Mono',monospace", fontSize: 7,
                  padding: "2px 6px", cursor: "pointer",
                  letterSpacing: ".04em", borderRadius: 2,
                  transition: "all .1s",
                }}>
                {active ? "✓ " : ""}{tag}
              </button>
            );
          })}
        </div>
      )}
      <textarea
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(text); }}
        onChange={e => setText(e.target.value)}
        placeholder="what went wrong?"
        rows={focused && text.length > 40 ? 3 : 1}
        style={{
          width: "100%", boxSizing: "border-box",
          background: "transparent",
          border: `1px solid ${focused ? S.borderColor : "transparent"}`,
          color: text ? S.textPrimary : S.textDim,
          ...mono, fontSize: 10, padding: "3px 5px",
          resize: "none", outline: "none",
          lineHeight: 1.4, borderRadius: 0,
          transition: "border-color .1s",
        }}
      />
    </div>
  );
}

function TradingJournal({ closed, S, terminalId, mistakeTags, setMistakeTags }) {
  const [notes, setNotes] = useState(loadJournalNotes);
  const [sortCol, setSortCol] = useState("time");
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState("");
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [newTag, setNewTag] = useState("");
  const { elRef: tagSidebarRef, cvRef: tagSidebarCvRef } = useSpotlight();

  const updateNote = useCallback((mint, field, val) => {
    setNotes(prev => {
      const next = { ...prev, [mint]: { ...(prev[mint] ?? {}), [field]: val } };
      saveJournalNotes(next);
      return next;
    });
  }, []);

  // Deduplicate closed by mint (take last close per mint)
  const rows = useMemo(() => {
    const byMint = {};
    for (const p of closed) {
      if (!byMint[p.mint] || p.closeTs > byMint[p.mint].closeTs) byMint[p.mint] = p;
    }
    return Object.values(byMint);
  }, [closed]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? rows.filter(r => (r.token ?? r.mint ?? "").toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av, bv;
      if (sortCol === "token") { av = (a.token ?? "").toLowerCase(); bv = (b.token ?? "").toLowerCase(); }
      else if (sortCol === "pnl") { av = a.tradePnl ?? 0; bv = b.tradePnl ?? 0; }
      else if (sortCol === "time") { av = a.closeTs ?? 0; bv = b.closeTs ?? 0; }
      else if (sortCol === "entryMcap") { av = +(notes[a.mint]?.entryMcap ?? 0); bv = +(notes[b.mint]?.entryMcap ?? 0); }
      else if (sortCol === "exitMcap")  { av = +(notes[a.mint]?.exitMcap  ?? 0); bv = +(notes[b.mint]?.exitMcap  ?? 0); }
      else { av = 0; bv = 0; }
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ?  1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortCol, sortAsc, notes]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortAsc(p => !p);
    else { setSortCol(col); setSortAsc(false); }
  };

  const exportJournal = () => {
    const headers = ["ticker","mint","close_date","entry_mcap","exit_mcap","pnl_sol","thesis","mistake"];
    const csvRows = sorted.map(pos => {
      const n = notes[pos.mint] ?? {};
      return [
        pos.token ?? pos.mint?.slice(0,8) ?? "",
        pos.mint ?? "",
        pos.time ?? "",
        n.entryMcap ?? "",
        n.exitMcap ?? "",
        (pos.tradePnl ?? 0).toFixed(6),
        `"${(n.thesis ?? "").replace(/"/g, "''")}"`,
        `"${(n.mistake ?? "").replace(/"/g, "''")}"`,
      ].join(",");
    });
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `soltrack-journal-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportJSON = () => {
    const json = JSON.stringify(notes, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `soltrack-journal-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJSON = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
          if (confirm(`Import ${Object.keys(parsed).length} journal entries? This will MERGE with existing notes.`)) {
            setNotes(prev => {
              const merged = { ...prev };
              for (const [mint, n] of Object.entries(parsed)) {
                merged[mint] = { ...(merged[mint] ?? {}), ...n };
              }
              saveJournalNotes(merged);
              return merged;
            });
          }
        } catch(err) { alert("Import failed: " + err.message); }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const pnlColor = (n) => n > 0 ? S.accentGreen : n < 0 ? S.accentRed : S.textMid;
  const mono = { fontFamily: "'DM Mono',monospace" };
  const thStyle = (col) => ({
    padding: "8px 10px", textAlign: "left", fontWeight: 400, fontSize: 9,
    letterSpacing: ".1em", color: sortCol === col ? S.accentGreen : S.textDim,
    cursor: "pointer", whiteSpace: "nowrap", userSelect: "none",
  });

  return (
    <div className="fade-up" style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div className="ts-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: "#fff", letterSpacing: ".12em", marginBottom: 2 }}>
            TRADING JOURNAL
          </div>
          <div className="ts-dim" style={{ fontSize: 9, color: S.textDim, letterSpacing: ".1em" }}>
            {rows.length} positions · click mistake cell to tag · thesis to note
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            className="sinp" placeholder="search ticker..." value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 140, fontSize: 10 }}
          />
          <button onClick={exportJournal}
            style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textMid,
              cursor: "pointer", fontSize: 9, padding: "5px 10px", ...mono,
              letterSpacing: ".06em", transition: "color .12s, border-color .12s" }}
            title="Export as CSV"
            onMouseEnter={e => { e.currentTarget.style.color = S.accentGreen; e.currentTarget.style.borderColor = `${S.accentGreen}66`; }}
            onMouseLeave={e => { e.currentTarget.style.color = S.textMid; e.currentTarget.style.borderColor = S.borderColor; }}>
            ↓ CSV
          </button>
          <button onClick={exportJSON}
            style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textMid,
              cursor: "pointer", fontSize: 9, padding: "5px 10px", ...mono,
              letterSpacing: ".06em", transition: "color .12s, border-color .12s" }}
            title="Export notes as JSON backup"
            onMouseEnter={e => { e.currentTarget.style.color = S.accentGreen; e.currentTarget.style.borderColor = `${S.accentGreen}66`; }}
            onMouseLeave={e => { e.currentTarget.style.color = S.textMid; e.currentTarget.style.borderColor = S.borderColor; }}>
            ↓ JSON
          </button>
          <button onClick={importJSON}
            style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textMid,
              cursor: "pointer", fontSize: 9, padding: "5px 10px", ...mono,
              letterSpacing: ".06em", transition: "color .12s, border-color .12s" }}
            title="Import notes from JSON backup (merges with existing)"
            onMouseEnter={e => { e.currentTarget.style.color = S.accentPurple; e.currentTarget.style.borderColor = `${S.accentPurple}66`; }}
            onMouseLeave={e => { e.currentTarget.style.color = S.textMid; e.currentTarget.style.borderColor = S.borderColor; }}>
            ↑ IMPORT
          </button>
          <button onClick={() => setShowTagEditor(p => !p)}
            style={{ background: showTagEditor ? `${S.accentGreen}18` : "none",
              border: `1px solid ${showTagEditor ? S.accentGreen : S.borderColor}`,
              color: showTagEditor ? S.accentGreen : S.textMid,
              cursor: "pointer", fontSize: 9, padding: "5px 10px", ...mono,
              letterSpacing: ".06em", transition: "all .12s" }}
            title="Edit available mistake tags">
            🏷 TAGS
          </button>
        </div>
      </div>
      <BorderCard S={S} style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${S.borderColor}` }}>
                <th style={thStyle("token")} onClick={() => toggleSort("token")}>
                  TICKER {sortCol === "token" ? (sortAsc ? "↑" : "↓") : ""}
                </th>
                <th style={thStyle("time")} onClick={() => toggleSort("time")}>
                  DATE {sortCol === "time" ? (sortAsc ? "↑" : "↓") : ""}
                </th>
                <th style={thStyle("pnl")} onClick={() => toggleSort("pnl")}>
                  PnL {sortCol === "pnl" ? (sortAsc ? "↑" : "↓") : ""}
                </th>
                <th style={thStyle("entryMcap")} onClick={() => toggleSort("entryMcap")}>ENTRY $</th>
                <th style={thStyle("exitMcap")} onClick={() => toggleSort("exitMcap")}>EXIT $</th>
                <th style={{ ...thStyle("thesis"), cursor: "default" }}>THESIS</th>
                <th style={{ ...thStyle("mistake"), cursor: "default" }}>MISTAKE</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pos) => {
                const n = notes[pos.mint] ?? {};
                return (
                  <tr key={pos.mint} style={{ borderBottom: `1px solid ${S.borderColor}22` }}>
                    <td style={{ padding: "4px 10px", fontFamily: "'Orbitron',monospace", fontSize: 9,
                      color: S.accentGreen, letterSpacing: ".06em", whiteSpace: "nowrap",
                      cursor: pos.mint ? "pointer" : "default" }}
                      onClick={() => {
                        if (!pos.mint) return;
                        window.open(terminalUrl(terminalId, pos.mint), "_blank", "noopener,noreferrer");
                      }}
                      onMouseEnter={e => { if (pos.mint) e.currentTarget.style.opacity = ".7"; }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}>
                      {pos.token ?? pos.mint?.slice(0,8) ?? "?"}
                      {pos.mint && <span style={{ fontSize: 7, opacity: .4, marginLeft: 4 }}>↗</span>}
                    </td>
                    <td style={{ padding: "4px 10px", ...mono, fontSize: 9, color: S.textDim, whiteSpace: "nowrap" }}>
                      {pos.time ?? "—"}
                    </td>
                    <td style={{ padding: "4px 10px", whiteSpace: "nowrap" }}>
                      <span style={{ ...mono, fontWeight: 700, color: pnlColor(pos.tradePnl),
                        fontSize: 10, textShadow: `0 0 8px ${pnlColor(pos.tradePnl)}44` }}>
                        {fmtC(pos.tradePnl, S, 4)}
                      </span>
                    </td>
                    <td style={{ padding: "4px 6px", minWidth: 80 }}>
                      <JournalCell value={n.entryMcap} isNumber onChange={v => updateNote(pos.mint, "entryMcap", v)} placeholder="entry $" S={S} mono />
                    </td>
                    <td style={{ padding: "4px 6px", minWidth: 80 }}>
                      <JournalCell value={n.exitMcap} isNumber onChange={v => updateNote(pos.mint, "exitMcap", v)} placeholder="exit $" S={S} mono />
                    </td>
                    <td style={{ padding: "4px 6px", minWidth: 180, maxWidth: 280 }}>
                      <JournalCell value={n.thesis} onChange={v => updateNote(pos.mint, "thesis", v)} placeholder="what was your thesis?" S={S} />
                    </td>
                    <td style={{ padding: "4px 6px", minWidth: 200, maxWidth: 320 }}>
                      <MistakeCell
                        value={n.mistake}
                        onChange={v => updateNote(pos.mint, "mistake", v)}
                        tags={mistakeTags}
                        S={S}
                      />
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "32px", textAlign: "center", color: S.textDim, fontSize: 10 }}>
                    No closed positions yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </BorderCard>
    </div>{/* end journal main */}

    {/* ── Right sidebar: tag editor ── */}
    {showTagEditor && (
      <div ref={tagSidebarRef} style={{ width: 180, flexShrink: 0, marginLeft: 12,
        background: S.bgCard, border: `1px solid ${S.borderColor}`,
        display: "flex", flexDirection: "column", alignSelf: "flex-start",
        padding: "14px 12px", gap: 6, position: "relative" }}>
        <canvas ref={tagSidebarCvRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }} />
        <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="ts-dim" style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: "#fff", letterSpacing: ".12em", marginBottom: 4 }}>MISTAKE TAGS</div>
        <div style={{ ...mono, fontSize: 8, color: S.textDim, lineHeight: 1.5, marginBottom: 4 }}>
          Tags appear when you focus a mistake cell. Click to toggle.
        </div>
        {mistakeTags.map((tag, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input value={tag}
              onChange={e => { const next = [...mistakeTags]; next[i] = e.target.value; setMistakeTags(next); }}
              style={{ flex: 1, background: "#0a0a0a", border: `1px solid ${S.borderColor}`,
                color: S.textMid, ...mono, fontSize: 9, padding: "3px 6px" }} />
            <button onClick={() => setMistakeTags(mistakeTags.filter((_, j) => j !== i))}
              style={{ background: "none", border: "none", color: S.textDim, cursor: "pointer", fontSize: 11, padding: "0 3px", lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.color = S.accentRed}
              onMouseLeave={e => e.currentTarget.style.color = S.textDim}>×</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, borderTop: `1px solid ${S.borderColor}`, paddingTop: 8, marginTop: 2 }}>
          <input value={newTag} onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && newTag.trim()) { setMistakeTags([...mistakeTags, newTag.trim()]); setNewTag(""); }}}
            placeholder="add tag…"
            style={{ flex: 1, background: "#0a0a0a", border: `1px solid ${S.borderColor}`,
              color: S.textMid, ...mono, fontSize: 9, padding: "3px 6px" }} />
          <button onClick={() => { if (newTag.trim()) { setMistakeTags([...mistakeTags, newTag.trim()]); setNewTag(""); }}}
            style={{ background: "none", border: `1px solid ${S.accentGreen}55`, color: S.accentGreen,
              cursor: "pointer", fontSize: 9, padding: "2px 7px" }}>+</button>
        </div>
        <button onClick={() => setMistakeTags([...DEFAULT_SETTINGS.mistakeTags])}
          style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim,
            ...mono, fontSize: 8, cursor: "pointer", padding: "4px", letterSpacing: ".06em" }}>
          RESET DEFAULTS
        </button>
        </div>{/* z-index wrapper */}
      </div>
    )}
  </div>
  );
}


function ColorRow({ label, k, S, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${S.borderColor}` }}>
      <span className="ts-head" style={{ color: S.textMid, fontSize: 11 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span className="ts-mono" style={{ color: S.textDim, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{S[k]}</span>
        <div style={{ position: "relative", width: 24, height: 24, border: `1px solid ${S.borderColor}`, overflow: "hidden", cursor: "pointer" }}>
          <div style={{ position: "absolute", inset: 0, background: S[k] }} />
          <input type="color" value={S[k]} onChange={(e) => onChange(k, e.target.value)} style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }} />
        </div>
      </div>
    </div>
  );
}

function SliderRow({ label, k, min, max, step = 1, S, onChange }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: `1px solid ${S.borderColor}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="ts-head" style={{ color: S.textMid, fontSize: 11 }}>{label}</span>
        <span className="ts-mono" style={{ color: S.textDim, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{S[k]}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={S[k]} onChange={(e) => onChange(k, +e.target.value)} style={{ width: "100%", accentColor: S.accentGreen }} />
    </div>
  );
}

// ── WALLET STATE ──────────────────────────────────────────────────────────────
function useWalletData(S, clientToken = "") {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [syncStates, setSyncStates] = useState({}); // address -> syncState
  const [syncing, setSyncing] = useState({}); // id -> bool (deep backfill in progress)
  const abortRefs = useRef({});
  const walletsRef = useRef(wallets);
  const apiKeyRef = useRef(S.workerUrl);
  const heliusKeyRef = useRef(S.heliusKey);
  const clientTokenRef = useRef(clientToken);
  useEffect(() => { apiKeyRef.current = S.workerUrl; }, [S.workerUrl]);
  useEffect(() => { heliusKeyRef.current = S.heliusKey; }, [S.heliusKey]);
  useEffect(() => { clientTokenRef.current = clientToken; }, [clientToken]);
  useEffect(() => { walletsRef.current = wallets; }, [wallets]);

  // Save wallet list (address + label + colorIdx only, not trades) on every change
  useEffect(() => {
    if (wallets.length === 0) return;
    saveLS("soltrack_wallets", wallets.map(w => ({ address: w.address, label: w.label, colorIdx: w.colorIdx, archived: w.archived ?? false, excludeAll: w.excludeAll ?? false })));
  }, [wallets]);

  // Restore wallets on mount:
  // 1. From localStorage (same domain, instant)
  // 2. From server (cross-device / domain change) — needs token which is set after login
  useEffect(() => {
    const saved = loadLS("soltrack_wallets", []);
    if (saved.length) {
      const restored = saved.map((w, i) => ({ id: `w_${i}_${w.address.slice(0,6)}`, ...w, trades: [], loaded: false }));
      setWallets(restored);
      restoreRef.current = restored;
    }
  }, []);

  const restoreRef = useRef([]);

  // Fetch wallets from server after token and workerUrl are both available
  // Covers: new device, domain change, or fresh install where localStorage is empty
  useEffect(() => {
    const token = localStorage.getItem("soltrack_user_token") ?? "";
    if (!S.workerUrl || !token) return;
    const base = sanitizeWorkerUrl(S.workerUrl);
    fetch(`${base}/user/wallets`, {
      headers: { "Authorization": `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.wallets?.length) return;
        setWallets(prev => {
          const existing = new Set(prev.map(w => w.address));
          const maxColor = prev.length ? Math.max(...prev.map(w => w.colorIdx)) + 1 : 0;
          const newWallets = data.wallets
            .filter(sw => !existing.has(sw.address))
            .map((sw, i) => ({
              id: `w_srv_${Date.now()}_${i}`,
              address: sw.address,
              label: sw.label ?? sw.address.slice(0, 8),
              colorIdx: maxColor + i,
              trades: [], loaded: false,
            }));
          if (!newWallets.length) return prev;
          restoreRef.current = [...restoreRef.current, ...newWallets];
          return [...prev, ...newWallets];
        });
      })
      .catch(() => {});
  }, [S.workerUrl]); // re-runs if workerUrl changes; token is stable after login+reload

  useEffect(() => {
    if (!S.workerUrl || !restoreRef.current.length) return;
    const toFetch = restoreRef.current;
    restoreRef.current = [];
    toFetch.forEach(w => runFetch(w.id, w.address));
  }, [S.workerUrl, wallets]);

  const runFetch = useCallback(async (id, address) => {
    const workerUrl = apiKeyRef.current;
    const heliusKey = heliusKeyRef.current;
    if (!workerUrl) {
      setErrors((p) => ({ ...p, [id]: "Worker URL not set. Enter it in Settings." }));
      return;
    }
    abortRefs.current[id]?.abort();
    const ctrl = new AbortController();
    abortRefs.current[id] = ctrl;
    setLoading((p) => ({ ...p, [id]: { progress: 0 } }));
    setErrors((p) => ({ ...p, [id]: null }));

    const userToken = localStorage.getItem("soltrack_user_token") ?? ""; const ct = clientTokenRef.current; const headers = { ...(userToken ? { "Authorization": `Bearer ${userToken}` } : {}), ...(ct ? { "X-Client-Token": ct } : {}) };

    try {
      const base = sanitizeWorkerUrl(workerUrl);
      const res = await fetch(`${base}/wallet`, { method: "POST", signal: ctrl.signal, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ address, heliusKey: heliusKeyRef.current || undefined }) });

      let trades;
      if (res.ok) {
        const data = await res.json();
        trades = data.trades ?? [];
        // Store sync state and server hash for this wallet
        if (data.syncState) {
          setSyncStates(p => ({ ...p, [address]: data.syncState }));
        }
        if (data.wallet?.address) {
          setWallets(p => p.map(w => w.id === id ? { ...w, hash: data.wallet.address } : w));
        }
        trades = trades.map(t => t.mint && TOKEN_SYMBOL_CACHE[t.mint] ? { ...t, token: TOKEN_SYMBOL_CACHE[t.mint] } : t);
      } else if (res.status === 403) {
        throw new Error("This wallet has been banned from SOLTRACK");
      } else if (res.status === 401) {
        throw new Error("SESSION_EXPIRED");
      } else {
        throw new Error(`Worker returned ${res.status}`);
      }

      setWallets((p) => p.map((w) => w.id === id ? { ...w, trades, loaded: true } : w));
    } catch (e) {
      if (e.name === "AbortError" || e.message === "Aborted") return;
      setErrors((p) => ({ ...p, [id]: e.message }));
      setWallets((p) => p.map((w) => w.id === id ? { ...w, trades: [], loaded: true } : w));
    } finally {
      setLoading((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  }, []);

  // Deep backfill — calls /sync endpoint, then reloads wallet
  const syncHistory = useCallback(async (id, address) => {
    const workerUrl = apiKeyRef.current;
    const heliusKey = heliusKeyRef.current;
    if (!workerUrl) return;
    setSyncing(p => ({ ...p, [id]: true }));
    try {
      const userToken = localStorage.getItem("soltrack_user_token") ?? ""; const ct = clientTokenRef.current; const headers = { ...(userToken ? { "Authorization": `Bearer ${userToken}` } : {}), ...(ct ? { "X-Client-Token": ct } : {}) };
      const base = sanitizeWorkerUrl(workerUrl);
      const res = await fetch(`${base}/sync`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      if (res.ok) {
        const result = await res.json();
        setSyncStates(p => ({
          ...p,
          [address]: { ...p[address], totalFetched: result.totalFetched, oldestFetched: result.oldestTs ? new Date(result.oldestTs).toISOString() : null }
        }));
        // Small delay — gives DB a moment to commit before we read
        await new Promise(r => setTimeout(r, 350));
        // Reload trades from Supabase after backfill
        await runFetch(id, address);
      }
    } catch(e) {
      console.error("syncHistory error:", e);
    } finally {
      setSyncing(p => { const n = {...p}; delete n[id]; return n; });
    }
  }, [runFetch]);

  const addWallet = useCallback(async (address, label, colorIdx) => {
    const id = `w_${Date.now()}`;
    setWallets((p) => [...p, { id, address, label, colorIdx, trades: [], loaded: false }]);
    await runFetch(id, address);
  }, [runFetch]);

  const removeWallet = useCallback((id) => {
    abortRefs.current[id]?.abort();
    setWallets((p) => {
      const w = p.find(w => w.id === id);
      // Unlink from server so cross-device restore doesn't bring it back
      if (w?.address && S.workerUrl) {
        const base = sanitizeWorkerUrl(S.workerUrl);
        const token = localStorage.getItem("soltrack_user_token") ?? "";
        fetch(`${base}/user/wallets/${encodeURIComponent(w.address)}`, {
          method: "DELETE", headers: { "Authorization": `Bearer ${token}` },
        }).catch(() => {});
      }
      const next = p.filter((w) => w.id !== id);
      if (next.length === 0) localStorage.removeItem("soltrack_wallets");
      return next;
    });
  }, [S.workerUrl]);

  const refreshWallet = useCallback(async (id) => {
    const w = walletsRef.current.find((ww) => ww.id === id);
    if (!w) return;
    // First call /sync to pull any new txs from chain into DB, then reload from DB
    await syncHistory(id, w.address);
  }, [syncHistory]);

  const updateWallet = useCallback((id, patch) => {
    setWallets(p => p.map(w => w.id === id ? { ...w, ...patch } : w));
  }, []);

  return { wallets, loading, errors, syncStates, syncing, addWallet, removeWallet, refreshWallet, syncHistory, updateWallet };
}

// ── ONBOARDING ────────────────────────────────────────────────────────────────
function Onboarding({ S, workerUrl: workerUrlProp, onComplete, relogin = false }) {
  const [workerUrl] = useState(workerUrlProp || "");
  const [step, setStep] = useState("connect"); // "connect" | "helius"
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);

  const mono = { fontFamily: "'DM Mono',monospace" };
  const orb  = { fontFamily: "'Orbitron',monospace" };
  const green = "#00ff91";

  const connectWallet = async () => {
    setConnecting(true); setErr("");
    try {
      const provider = window.phantom?.solana || window.solflare || window.solana;
      if (!provider) throw new Error("No Solana wallet found. Install Phantom or Solflare.");

      await provider.connect();
      const pubkeyBytes = provider.publicKey.toBytes();
      const pubkeyHex   = Array.from(pubkeyBytes).map(b => b.toString(16).padStart(2,"0")).join("");

      const effectiveUrl = workerUrl;
      if (!effectiveUrl) throw new Error("Worker URL not set. Enter it above.");
      const base = sanitizeWorkerUrl(effectiveUrl);

      // Get nonce
      const nonceRes = await fetch(`${base}/auth/nonce?pubkey=${pubkeyHex}`);
      if (!nonceRes.ok) throw new Error("Worker unreachable: " + nonceRes.status);
      const { message } = await nonceRes.json();

      // Sign
      const msgBytes = new TextEncoder().encode(message);
      const signed   = await provider.signMessage(msgBytes, "utf8");
      const sigHex   = Array.from(signed.signature).map(b => b.toString(16).padStart(2,"0")).join("");

      // Verify + get JWT
      const verifyRes = await fetch(`${base}/auth/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: pubkeyHex, signature: sigHex, message }),
      });
      if (!verifyRes.ok) throw new Error("Auth failed: " + (await verifyRes.json()).error);
      const { token } = await verifyRes.json();
      localStorage.setItem("soltrack_user_token", token);

      // Re-login: key is already on server, skip has-key check entirely
      if (relogin) {
        onComplete(token);
        return;
      }

      // First login: check if Helius key already stored (e.g. existing user on new device)
      let hasKey = false;
      try {
        const hasKeyRes = await fetch(`${base}/auth/has-key`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (hasKeyRes.ok) {
          const data = await hasKeyRes.json();
          hasKey = data.hasKey ?? false;
        }
      } catch {}

      if (hasKey) {
        onComplete(token);
      } else {
        setStep("helius");
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setConnecting(false);
    }
  };

  const saveHeliusKey = async (key) => {
    if (!key.trim()) return;
    setConnecting(true); setErr("");
    try {
      const effectiveUrl = workerUrl;
      const base  = sanitizeWorkerUrl(effectiveUrl);
      const token = localStorage.getItem("soltrack_user_token");
      const res   = await fetch(`${base}/auth/setup-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ heliusKey: key.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save key: " + (await res.json()).error);
      onComplete(token);
    } catch (e) {
      setErr(e.message);
    } finally {
      setConnecting(false);
    }
  };

  const [heliusInput, setHeliusInput] = useState("");

  return (
    <div style={{ minHeight: "100vh", background: "#010101", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 480, padding: 40, border: "1px solid #262626", background: "#0d0d0d", position: "relative" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: 40, height: 2, background: green }} />
        <div style={{ position: "absolute", top: 0, left: 0, width: 2, height: 40, background: green }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <div style={{ width: 7, height: 7, background: green, boxShadow: `0 0 12px ${green}` }} />
          <span style={{ ...orb, fontWeight: 900, fontSize: 14, letterSpacing: ".2em", color: "#fff" }}>SOLTRACK</span>
          <span style={{ ...mono, fontSize: 9, color: "#919191", letterSpacing: ".1em" }}>SETUP</span>
        </div>

        {/* Privacy notice */}
        <div style={{ marginBottom: 28, padding: "12px 14px", border: "1px solid #1a3a1a", background: "#0a1a0a" }}>
          <div style={{ ...mono, fontSize: 10, color: green, letterSpacing: ".08em", marginBottom: 8 }}>🔒 PRIVACY</div>
          <div style={{ ...mono, fontSize: 10, color: "#919191", lineHeight: 1.8 }}>
            <div>· Your wallets are <span style={{ color: "#fff" }}>never stored as plain addresses</span> — only a cryptographic hash.</div>
            <div>· Your Helius key is <span style={{ color: "#fff" }}>encrypted server-side</span> — nobody can read it, including the admin.</div>
            <div>· Admin can only see <span style={{ color: "#fff" }}>total counts</span> — no addresses, no trade data.</div>
            <div>· Sign in via wallet signature — <span style={{ color: "#fff" }}>no password, no email</span>, no transaction is created.</div>
            <div>· The wallet you sign in with is your <span style={{ color: "#fff" }}>identity key only</span> — it doesn't need to be a trading wallet. Always use the same wallet to sign in to access your data.</div>
          </div>
        </div>

        {step === "connect" && (
          <>

            <div style={{ marginBottom: 28 }}>
              <span style={{ ...mono, fontSize: 11, color: "#f2f2f2", letterSpacing: ".08em" }}>SIGN IN WITH WALLET</span>
              <p style={{ ...mono, fontSize: 10, color: "#919191", marginBottom: 12, marginTop: 8, lineHeight: 1.6 }}>
                Connect your Solana wallet (Phantom, Solflare, etc.) to authenticate.<br/>
                No transaction — just a signature to prove ownership.
              </p>
            </div>
            <button className="lbtn" style={{ "--accent": green, width: "100%", padding: "10px 0", fontSize: 11, letterSpacing: ".15em" }}
              onClick={connectWallet} disabled={connecting}>
              {connecting ? "CONNECTING..." : "CONNECT WALLET →"}
            </button>
          </>
        )}

        {step === "helius" && (
          <>
            <div style={{ marginBottom: 28 }}>
              <span style={{ ...mono, fontSize: 11, color: "#f2f2f2", letterSpacing: ".08em" }}>HELIUS API KEY</span>
              <p style={{ ...mono, fontSize: 10, color: "#919191", marginBottom: 12, marginTop: 8, lineHeight: 1.6 }}>
                Free at <a href="https://helius.dev" target="_blank" rel="noopener" style={{ color: green }}>helius.dev</a> → sign up → Dashboard → API Keys.<br/>
                Your key is encrypted and stored server-side — never exposed in the browser.
              </p>
              <input className="inp" style={{ width: "100%", boxSizing: "border-box" }}
                placeholder="your-helius-api-key"
                value={heliusInput}
                onChange={e => setHeliusInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && saveHeliusKey(heliusInput)}
              />
            </div>
            <button className="lbtn" style={{ "--accent": green, width: "100%", padding: "10px 0", fontSize: 11, letterSpacing: ".15em" }}
              onClick={() => saveHeliusKey(heliusInput)} disabled={connecting || !heliusInput}>
              {connecting ? "SAVING..." : "LAUNCH SOLTRACK →"}
            </button>
          </>
        )}

        {err && <div style={{ ...mono, fontSize: 10, color: "#ff0033", marginTop: 14 }}>{err}</div>}
      </div>
    </div>
  );
}

// ── ADMIN PANEL ───────────────────────────────────────────────────────────────
// ── ADMIN PANEL ───────────────────────────────────────────────────────────────
// ── DEFAULT_CARD_V2: global V2 layout/style settings ─────────────────────────
// Stored in S.defaultCardV2. Keys use v2_ prefix — no conflict with rank.card V1 fields.

// ── ColorField: persistent inline color picker usable anywhere in admin ────────
// Uses a controlled text input + native color swatch. Does NOT use key= on the
// text input, so it never remounts and never loses focus mid-edit.
function ColorField({ value, onChange, style }) {
  const safeHex = v => {
    if (!v) return '#000000';
    const m6 = v.match(/^#[0-9a-fA-F]{6}$/i);
    if (m6) return v.toLowerCase();
    const m3 = v.match(/^#([0-9a-fA-F]{3})$/i);
    if (m3) return '#'+m3[1][0]+m3[1][0]+m3[1][1]+m3[1][1]+m3[1][2]+m3[1][2];
    const rgba = v.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgba) return '#'+[rgba[1],rgba[2],rgba[3]].map(n=>parseInt(n).toString(16).padStart(2,'0')).join('');
    return '#000000';
  };
  const [text, setText] = React.useState(value ?? '#000000');
  // Sync external value changes into local text (e.g. after reset)
  React.useEffect(() => { setText(value ?? '#000000'); }, [value]);
  const commit = (raw) => {
    const v = raw.trim();
    if (/^#[0-9a-fA-F]{3,8}$/i.test(v) || /^rgba?\s*\(/i.test(v)) onChange(v);
  };
  const border = '#262626';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5, ...style }}>
      <div style={{ position:'relative', width:24, height:24, flexShrink:0 }}>
        <div style={{ position:'absolute', inset:0, background:value, border:`1px solid ${border}`, borderRadius:2 }}/>
        <input type="color" value={safeHex(value)}
          onChange={e => { setText(e.target.value); onChange(e.target.value); }}
          style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
      </div>
      <input type="text" value={text}
        onChange={e => { setText(e.target.value); commit(e.target.value); }}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key==='Enter') commit(e.target.value); }}
        spellCheck={false}
        style={{ fontFamily:"'DM Mono',monospace", background:'#111', border:`1px solid ${border}`,
          color:'#ddd', fontSize:9, flex:1, padding:'3px 6px', minWidth:0 }}/>
    </div>
  );
}

// ── Hoisted V2 admin helpers — defined OUTSIDE AdminPanel so they are stable ──
// React component identity is based on the function reference. If these were
// defined inside the IIFE they would be new references on every render, causing
// React to unmount+remount the entire subtree on every state change → black screen.
const ADMIN_GREEN  = '#00ff9d';
const ADMIN_BORDER = '#262626';
const ADMIN_DIM    = '#919191';
const ADMIN_MONO   = { fontFamily:"'DM Mono',monospace" };

function V2AdminSec({ title }) {
  return (
    <div style={{ ...ADMIN_MONO, fontSize:8, color:ADMIN_GREEN, letterSpacing:'.14em',
      borderBottom:`1px solid ${ADMIN_GREEN}22`, paddingBottom:4, marginTop:14, marginBottom:8 }}>
      {title}
    </div>
  );
}
function V2AdminRow({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
      <span style={{ ...ADMIN_MONO, fontSize:8, color:ADMIN_DIM, minWidth:130, flexShrink:0 }}>{label}</span>
      {children}
    </div>
  );
}
function V2AdminSlider({ label, val, min, max, step=1, unit='', onChange }) {
  const safe = Math.min(max, Math.max(min, +val||0));
  return (
    <V2AdminRow label={label}>
      <input type="range" min={min} max={max} step={step} value={safe}
        onChange={e => onChange(+e.target.value)}
        style={{ flex:1, accentColor:ADMIN_GREEN, minWidth:0 }}/>
      <input type="number" step={step} value={val}
        onChange={e => { const v=parseFloat(e.target.value); if(!isNaN(v)) onChange(v); }}
        style={{ ...ADMIN_MONO, background:'#111', border:`1px solid ${ADMIN_BORDER}`,
          color:'#ccc', fontSize:9, width:52, padding:'2px 4px', textAlign:'right', flexShrink:0 }}/>
      {unit && <span style={{ ...ADMIN_MONO, fontSize:8, color:'#444', flexShrink:0 }}>{unit}</span>}
    </V2AdminRow>
  );
}
function V2AdminToggle({ label, checked, onChange }) {
  return (
    <V2AdminRow label={label}>
      <label style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
        <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}
          style={{ accentColor:ADMIN_GREEN, cursor:'pointer' }}/>
        <span style={{ ...ADMIN_MONO, fontSize:9, color:checked ? ADMIN_GREEN : ADMIN_DIM }}>
          {checked ? 'ON' : 'OFF'}
        </span>
      </label>
    </V2AdminRow>
  );
}
function V2AdminColor({ label, value, onChange }) {
  return (
    <V2AdminRow label={label}>
      <ColorField value={value} onChange={onChange} style={{ flex:1 }}/>
    </V2AdminRow>
  );
}


// Per-rank visual settings (gradient, accent) stay in rank.card.
const DEFAULT_CARD_V2 = {
  v2S1Max:          72,    // max PnL font size (binary-searched down if needed)
  v2S2:             22,    // rank name + return % font size
  v2S3:             13,    // all other text
  v2BorderWidth:    1.1,
  v2BorderOpacity:  0.38,
  v2DividerWidth:   1,
  v2DividerOpacity: 0.48,
  v2DividerDash:    '4,4',
  v2BracketLen:     16,
  v2BracketOpacity: 0.18,
  v2VolGraphX:      218,  // vol right-col x (with chart)
  v2VolNgColA:      42,   // BOUGHT col x (no chart)
  v2VolNgColB:      182,  // SOLD col x (no chart)
  v2PnlYOffset:     0,    // shift PnL block from auto-centered position (px)
  v2ReturnLabelGap: 14,   // gap from PnL baseline to RETURN label cap-top
  v2ReturnValGap:   6,    // gap from RETURN label baseline to return value cap-top
  v2NicknameYOff:   -8,   // offset from bottom bracket y
  v2TfGap:          12,   // gap timeframe→logo top
  v2TextAlign:      'center', // 'center'|'left'|'right' — admin default
};


// ── AdminRanksV2: standalone component so hooks/component refs are stable ─────
function AdminRanksV2({
  ranks, selectedRankIdx, setSelectedRankIdx,
  updateRank, addRank, removeRank, saveRanks,
  S, adminPreviewCur, setAdminPreviewCur, ADMIN_PREVIEW_CURS,
  green, border, dim, mono,
}) {
  const sortedRanks = [...ranks].sort((a,b) =>
    (b.min===-Infinity)?-1:(a.min===-Infinity)?1:b.min-a.min);
  const selIdx   = Math.min(selectedRankIdx, sortedRanks.length - 1);
  const previewR = sortedRanks[selIdx] ?? sortedRanks[0];

  if (!previewR) return (
    <div style={{ ...mono, color:dim, fontSize:10 }}>
      No ranks defined.
      <button onClick={addRank} style={{ ...mono, marginLeft:12, background:'none',
        border:`1px solid ${green}55`, color:green, cursor:'pointer', padding:'3px 10px', fontSize:9 }}>
        + ADD FIRST RANK
      </button>
    </div>
  );

  const origIdx   = ranks.findIndex(x => x===previewR || (x.name===previewR.name && x.min===previewR.min));
  const c         = { ...DEFAULT_CARD, ...(previewR.card ?? {}) };
  const updateCard = (k, v) => updateRank(origIdx, 'card', { ...c, [k]: v });

  // Slider / toggle / color helpers — call hoisted components with explicit props
  const sl  = (label, k, min, max, step=1, unit='') =>
    <V2AdminSlider key={k} label={label} val={c[k] ?? DEFAULT_CARD[k] ?? min}
      min={min} max={max} step={step} unit={unit} onChange={v => updateCard(k, v)}/>;
  const tog = (label, k) =>
    <V2AdminToggle key={k} label={label} checked={!!(c[k] ?? DEFAULT_CARD[k])}
      onChange={v => updateCard(k, v)}/>;
  const col = (label, k) =>
    <V2AdminColor key={k} label={label} value={c[k] ?? DEFAULT_CARD[k] ?? '#000000'}
      onChange={v => updateCard(k, v)}/>;
  const rcol = (label, field) =>
    <V2AdminColor key={field} label={label} value={previewR[field] ?? '#000000'}
      onChange={v => updateRank(origIdx, field, v)}/>;

  return (
    <div style={{ display:'flex', gap:0, alignItems:'flex-start', minHeight:600 }}>

      {/* LEFT: rank picker + settings */}
      <div style={{ width:380, flexShrink:0, borderRight:`1px solid ${border}`, paddingRight:20,
        overflowY:'auto', maxHeight:'calc(100vh - 100px)' }}>

        {/* Toolbar */}
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14 }}>
          <div style={{ flex:1, position:'relative' }}>
            <select value={selIdx} onChange={e => setSelectedRankIdx(+e.target.value)}
              style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
                padding:'5px 28px 5px 10px', fontSize:10, width:'100%', cursor:'pointer',
                appearance:'none', WebkitAppearance:'none' }}>
              {sortedRanks.map((r,i) => (
                <option key={i} value={i}>{r.name}{r.min===-Infinity?' (< 0)':`(≥ ${r.min})`}</option>
              ))}
            </select>
            <div style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
              color:dim, pointerEvents:'none', fontSize:9 }}>▾</div>
          </div>
          <button onClick={addRank}
            style={{ ...mono, background:'none', border:`1px solid ${green}55`, color:green,
              cursor:'pointer', padding:'5px 8px', fontSize:9, whiteSpace:'nowrap' }}>+ NEW</button>
          <button onClick={() => removeRank(origIdx)}
            style={{ ...mono, background:'none', border:'1px solid #ff003355', color:'#ff4444',
              cursor:'pointer', padding:'5px 8px', fontSize:9 }}>× DEL</button>
          <button onClick={saveRanks}
            style={{ ...mono, background:green+'22', border:`1px solid ${green}`, color:green,
              cursor:'pointer', padding:'5px 10px', fontSize:9, whiteSpace:'nowrap' }}>SAVE</button>
        </div>

        {/* IDENTITY */}
        <V2AdminSec title="IDENTITY"/>
        <V2AdminRow label="Name">
          <input value={previewR.name} onClick={e => e.stopPropagation()}
            onChange={e => updateRank(origIdx,'name',e.target.value.toUpperCase())}
            style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
              padding:'3px 7px', fontSize:10, fontWeight:700, flex:1 }}/>
        </V2AdminRow>
        <V2AdminRow label="Min SOL threshold">
          <input type="number" value={previewR.min===-Infinity?'':previewR.min}
            placeholder="-∞ (REKT)" disabled={previewR.min===-Infinity}
            onChange={e => updateRank(origIdx,'min',parseFloat(e.target.value)||0)}
            style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:dim,
              padding:'3px 5px', fontSize:10, flex:1, opacity:previewR.min===-Infinity?0.4:1 }}/>
        </V2AdminRow>
        {rcol("Accent color",      "color")}
        {rcol("Gradient top (G1)", "g1")}
        {rcol("Gradient bottom (G2)", "g2")}

        {/* ACCENT OVERRIDE */}
        <V2AdminSec title="ACCENT OVERRIDE"/>
        {tog("Use rank color", "useRankColor")}
        {!(c.useRankColor ?? DEFAULT_CARD.useRankColor) && col("Custom color", "customColor")}

        {/* GRADIENT */}
        <V2AdminSec title="GRADIENT"/>
        {sl("Angle (°)",     "gradientAngle", 0,   360, 5,    "°")}
        {sl("G1 opacity",    "g1Opacity",     0,   1,   0.05     )}
        {sl("G1 stop (%)",   "g1Stop",        0,   60,  1,    "%")}
        {sl("Mid stop (%)",  "midStop",       10,  90,  1,    "%")}
        {col("Mid color",    "midColor")}
        {sl("End stop (%)",  "endStop",       50,  100, 1,    "%")}
        {col("End color",    "endColor")}

        {/* DISPLAY */}
        <V2AdminSec title="DISPLAY"/>
        {tog("Show PnL chart", "showChart")}

        <div style={{ height:20 }}/>
      </div>

      {/* RIGHT: live preview */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center',
        paddingLeft:28, paddingTop:4, gap:14, position:'sticky', top:0 }}>
        <div style={{ ...mono, fontSize:8, color:dim, letterSpacing:'.12em' }}>LIVE PREVIEW · NEW DESIGN</div>
        <div style={{ transform:'scale(0.82)', transformOrigin:'top center', marginBottom:-80 }}>
          <ShareCardInnerV2
            S={{ ...S, currency: adminPreviewCur }}
            pnlCurve={[]} closed={[]}
            totalPnl={previewR.min === -Infinity ? -1.5 : (previewR.min ?? 0) + 0.5}
            winRate="58.0" tf="ALL" walletLabel={previewR.name} _overrideRank={previewR}/>
        </div>
        <div style={{ ...mono, fontSize:8, color:dim, letterSpacing:'.08em', textAlign:'center', marginTop:4 }}>
          · Changes saved with <span style={{ color:'#fff' }}>SAVE</span> button ·<br/>
          · Border, divider, text sizes → Card V2 tab ·
        </div>
        <div style={{ marginTop:10, display:'flex', gap:4, flexWrap:'wrap', justifyContent:'center' }}>
          {ADMIN_PREVIEW_CURS.map(cur => (
            <button key={cur} onClick={() => setAdminPreviewCur(cur)}
              style={{ ...mono, fontSize:8, padding:'3px 8px',
                background: adminPreviewCur===cur ? green+'22' : 'none',
                border:`1px solid ${adminPreviewCur===cur ? green : border}`,
                color: adminPreviewCur===cur ? green : dim,
                cursor:'pointer', letterSpacing:'.06em' }}>{cur}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ S, setSetting }) {
  const [authed, setAuthed]   = useState(false);
  const [token, setToken]     = useState("");
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const [adminTab, setAdminTab] = useState("wallets"); // "wallets" | "ranks"

  // Load user's local wallet labels for cross-referencing in admin
  const localWalletLabels = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("soltrack_wallets") || "[]");
      return Object.fromEntries(saved.map(w => [w.address, w.label]));
    } catch { return {}; }
  }, []);

  // Live-editable rank list (seeded from S.pnlRanks)
  // Syncs when S.pnlRanks changes (e.g. after /ranks fetch returns server values)
  const [ranks, setRanks] = useState(() =>
    JSON.parse(JSON.stringify(S?.pnlRanks ?? DEFAULT_SETTINGS.pnlRanks))
  );
  const [selectedRankIdx, setSelectedRankIdx] = useState(0);
  const [adminPreviewCur, setAdminPreviewCur] = useState('SOL'); // currency for admin card previews
  const ADMIN_PREVIEW_CURS = ['SOL','USD','EUR','PLN','UAH','KZT','GBP'];
  const prevPnlRanksRef = useRef(S?.pnlRanks);
  useEffect(() => {
    if (S?.pnlRanks !== prevPnlRanksRef.current) {
      prevPnlRanksRef.current = S?.pnlRanks;
      setRanks(JSON.parse(JSON.stringify(S?.pnlRanks ?? DEFAULT_SETTINGS.pnlRanks)));
      setSelectedRankIdx(0);
    }
  }, [S?.pnlRanks]);
  const updateRank = (i, k, v) => setRanks(prev => prev.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const addRank = () => setRanks(prev => [...prev, {
    min: 0, name: "NEW_RANK", color: "#ffffff", g1: "#333333", g2: "#000000", shape: "IMPERIAL"
  }]);
  const removeRank = (i) => setRanks(prev => prev.filter((_, j) => j !== i));
  const saveRanks = async () => {
    const parsed = ranks.map(r => ({
      ...r,
      min: r.name === "REKT" || r.min === "-Infinity" ? -Infinity : parseFloat(r.min),
    }));
    setSetting("pnlRanks", parsed);
    // token is already in component state from OAuth callback
    if (base && token) {
      try {
        const res = await fetch(`${base}/admin/ranks`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ranks: parsed }),
        });
        if (res.ok) alert("Ranks saved and published to all users.");
        else alert("Ranks failed to publish: " + (await res.text()));
      } catch (e) {
        alert("Worker unreachable: " + e.message);
      }
    } else {
      alert("Ranks saved locally. (Connect to worker to publish to all users.)");
    }
  };


  // Read worker URL fresh each time — not at module load time
  const base = sanitizeWorkerUrl(
    S?.workerUrl || loadLS("soltrack_settings", {}).workerUrl || ""
  );

  // Check for OAuth callback token in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) {
      setToken(t);
      setAuthed(true);
      window.history.replaceState({}, "", "/admin");
    }
  }, []);

  useEffect(() => {
    if (!authed || !token) return;
    loadData();
  }, [authed, token]);

  const loadData = async () => {
    setLoading(true); setErr("");
    try {
      const res = await fetch(`${base}/admin/data`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.status === 401) { setAuthed(false); setToken(""); return; }
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const [selected, setSelected] = useState(new Set());
  const toggleSelect = (addr) => setSelected(prev => { const n = new Set(prev); n.has(addr) ? n.delete(addr) : n.add(addr); return n; });
  const toggleAll = () => { const all = (data?.wallets ?? []).map(w => w.address); setSelected(prev => prev.size === all.length ? new Set() : new Set(all)); };

  const batchAction = async (action) => {
    const addrs = [...selected];
    if (!addrs.length) return;
    const labels = { purge: "PURGE trade data", delete: "DELETE COMPLETELY", ban: "BAN", unban: "UNBAN" };
    if (!confirm(`${labels[action]} for ${addrs.length} wallet(s)?\n\n${addrs.map(a => a.slice(0,8)+"…").join("\n")}\n\nCannot be undone.`)) return;
    await fetch(`${base}/admin/batch`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, addresses: addrs }),
    });
    setSelected(new Set());
    loadData();
  };

  const purgeWallet = async (address) => {
    if (!confirm(`PURGE trade data for ${address.slice(0,8)}…?\nDeletes trades + sync state. Wallet stays registered.`)) return;
    await fetch(`${base}/admin/wallet/${address}/purge`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    loadData();
  };
  const deleteWallet = async (address) => {
    if (!confirm(`DELETE ${address.slice(0,8)}… completely?\nRemoves wallet + all trades. Disappears from leaderboard.`)) return;
    await fetch(`${base}/admin/wallet/${address}/delete`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    loadData();
  };
  const banWallet = async (address, banned) => {
    if (banned) {
      await fetch(`${base}/admin/wallet/${address}/unban`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    } else {
      if (!confirm(`Ban wallet ${address.slice(0,8)}…?`)) return;
      await fetch(`${base}/admin/wallet/${address}`, { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } });
    }
    loadData();
  };

  const mono = { fontFamily: "'DM Mono',monospace" };
  const orb  = { fontFamily: "'Orbitron',monospace" };
  const bg   = "#010101";
  const card = "#0d0d0d";
  const border = "#262626";
  const green = "#00ff9d";
  const dim   = "#919191";

  if (!authed) {
    return (
      <div style={{ minHeight: "100vh", background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 380, padding: 40, border: `1px solid ${border}`, background: card }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <div style={{ width: 7, height: 7, background: green, boxShadow: `0 0 12px ${green}` }} />
            <span style={{ ...orb, fontWeight: 900, fontSize: 13, letterSpacing: ".2em", color: "#fff" }}>ADMIN</span>
          </div>
          <p style={{ ...mono, fontSize: 10, color: dim, marginBottom: 24, lineHeight: 1.6 }}>
            Access restricted. Sign in with the GitHub account that owns this worker.
          </p>
          {!base ? (
            <div>
              <p style={{ ...mono, fontSize: 10, color: "#ff9900", marginBottom: 10 }}>Worker URL not found. Enter it below:</p>
              <input className="inp" style={{ width: "100%", boxSizing: "border-box", marginBottom: 12 }}
                placeholder="https://soltrack.YOUR-NAME.workers.dev"
                onBlur={e => { saveLS("soltrack_settings", { ...loadLS("soltrack_settings",{}), workerUrl: sanitizeWorkerUrl(e.target.value) }); window.location.reload(); }}
              />
            </div>
          ) : (
            <button className="lbtn" style={{ "--accent": green, width: "100%", padding: "10px 0", fontSize: 11, letterSpacing: ".15em" }}
              onClick={() => window.location.href = `${base}/admin/login`}>
              SIGN IN WITH GITHUB →
            </button>
          )}
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <a href="/" style={{ ...mono, fontSize: 9, color: dim }}>← back to app</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: bg, padding: "0 0 60px" }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", height: 52, position: "sticky", top: 0, background: `${bg}f2`, backdropFilter: "blur(10px)", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 7, height: 7, background: green, boxShadow: `0 0 8px ${green}` }} />
          <span style={{ ...orb, fontWeight: 900, fontSize: 13, letterSpacing: ".2em", color: "#fff" }}>SOLTRACK ADMIN</span>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {[
            { id:'wallets',  label:'WALLETS'     },
            { id:'ranks',    label:'RANKS (OLD)' },
            { id:'card',     label:'CARD (OLD)'  },
            { id:'ranks_v2', label:'RANKS V2'    },
            { id:'card_v2',  label:'CARD V2'     },
          ].map(({id,label}) => (
            <button key={id} onClick={() => setAdminTab(id)}
              style={{ ...mono, background:"none", border:`1px solid ${adminTab===id?green:border}`,
                color:adminTab===id?green:dim, cursor:"pointer", padding:"4px 12px", fontSize:9, letterSpacing:".1em" }}>
              {label}
            </button>
          ))}
          <button className="lbtn" style={{ "--accent": green, fontSize: 9 }} onClick={loadData}>REFRESH</button>
          <a href="/" style={{ ...mono, fontSize: 9, color: dim, display: "flex", alignItems: "center" }}>← app</a>
        </div>
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
        {err && <div style={{ ...mono, fontSize: 11, color: "#ff0033", marginBottom: 16, padding: "10px 14px", border: "1px solid #ff003355", background: "#ff003311" }}>{err}</div>}
        {loading && <div style={{ ...mono, fontSize: 11, color: dim }}>Loading...</div>}

        {/* ── RANK EDITOR TAB ── */}
        {adminTab === "ranks" && (() => {
          const sortedRanks = [...ranks].sort((a,b) =>
            (b.min===-Infinity||(b.min===-Infinity))?-1:(a.min===-Infinity)?1:b.min-a.min);
          const selIdx   = Math.min(selectedRankIdx, sortedRanks.length - 1);
          const previewR = sortedRanks[selIdx] ?? sortedRanks[0];
          if (!previewR) return <div style={{ ...mono, color:dim, fontSize:10 }}>No ranks defined.</div>;

          const origIdx  = ranks.findIndex(x => x===previewR || (x.name===previewR.name && x.min===previewR.min));
          const c        = { ...DEFAULT_CARD, ...(previewR.card ?? {}) };
          const updateCard = (k, v) => updateRank(origIdx, 'card', { ...c, [k]: v });

          // ── helpers ──────────────────────────────────────────────
          const Section = ({ title }) => (
            <div style={{ ...mono, fontSize:8, color:green, letterSpacing:'.14em',
              borderBottom:`1px solid ${green}22`, paddingBottom:4, marginTop:14, marginBottom:8 }}>
              {title}
            </div>
          );
          const Row = ({ label, children }) => (
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
              <span style={{ ...mono, fontSize:8, color:dim, letterSpacing:'.08em', minWidth:118, flexShrink:0 }}>{label}</span>
              {children}
            </div>
          );

          // Slider: range + typeable number input. Value can exceed slider min/max when typed.
          // nullable=true: checkbox toggles auto (null) vs manual value
          const Slider = ({ label, k, min, max, step=1, unit='', nullable=false }) => {
            const stored = c[k];  // could be null (auto) or a number
            const isAuto = nullable && stored == null;
            const display = isAuto ? (DEFAULT_CARD[k] ?? (min+max)/2) : (stored ?? DEFAULT_CARD[k] ?? min);
            return (
              <Row label={label}>
                {nullable && (
                  <input type="checkbox" checked={!isAuto}
                    onChange={e => updateCard(k, e.target.checked ? DEFAULT_CARD[k] ?? Math.round((min+max)/2) : null)}
                    style={{ accentColor:green, cursor:'pointer', flexShrink:0 }}
                    title={isAuto ? 'click to set manually' : 'click to reset to auto'}/>
                )}
                <input type="range" min={min} max={max} step={step}
                  value={Math.min(max, Math.max(min, display))}
                  disabled={isAuto}
                  onChange={e => updateCard(k, +e.target.value)}
                  style={{ flex:1, accentColor:green, opacity:isAuto?0.25:1, minWidth:0 }}/>
                <input type="number" step={step}
                  value={isAuto ? '' : display}
                  placeholder={isAuto ? 'auto' : ''}
                  disabled={isAuto}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) updateCard(k, v); }}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`,
                    color:isAuto?'#333':'#ccc', fontSize:9, width:46, padding:'2px 4px',
                    textAlign:'right', flexShrink:0 }}/>
                {unit && <span style={{ ...mono, fontSize:8, color:'#444', flexShrink:0 }}>{unit}</span>}
              </Row>
            );
          };

          const Toggle = ({ label, k }) => (
            <Row label={label}>
              <label style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
                <input type="checkbox" checked={c[k] ?? DEFAULT_CARD[k]}
                  onChange={e => updateCard(k, e.target.checked)}
                  style={{ accentColor:green, cursor:'pointer' }}/>
                <span style={{ ...mono, fontSize:9, color:(c[k]??DEFAULT_CARD[k]) ? green : dim }}>
                  {(c[k]??DEFAULT_CARD[k]) ? 'ON' : 'OFF'}
                </span>
              </label>
            </Row>
          );

          // ColorPicker: NO hooks (defined inside IIFE — hooks not allowed).
          // Fully controlled: swatch opens native picker, text field applies on blur/Enter.
          const toHex6 = (val) => {
            if (!val) return '#000000';
            const m6 = val.match(/^#([0-9a-fA-F]{6})$/i);
            if (m6) return val.toLowerCase();
            const m3 = val.match(/^#([0-9a-fA-F]{3})$/i);
            if (m3) { const [,s]=m3; return '#'+s[0]+s[0]+s[1]+s[1]+s[2]+s[2]; }
            const rgba = val.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (rgba) return '#' + [rgba[1],rgba[2],rgba[3]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
            return '#000000';
          };
          const getAlpha = (val) => {
            const m = val?.match(/rgba\s*\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/i);
            return m ? parseFloat(m[1]) : null;
          };
          const applyColorText = (raw, k) => {
            const v = raw.trim();
            if (/^#[0-9a-fA-F]{3}$/.test(v)) updateCard(k, '#' + v[1]+v[1]+v[2]+v[2]+v[3]+v[3]);
            else if (/^#[0-9a-fA-F]{6}$/i.test(v) || /^rgba?\s*\(/i.test(v)) updateCard(k, v);
          };

          const ColorPicker = ({ label, k }) => {
            const val = c[k] ?? DEFAULT_CARD[k] ?? '#000000';
            const hex6 = toHex6(val);
            const alpha = getAlpha(val);
            const isRgba = alpha !== null;

            const onPickerChange = (e) => {
              const hex = e.target.value;
              if (isRgba) {
                const r = parseInt(hex.slice(1,3),16);
                const g = parseInt(hex.slice(3,5),16);
                const b = parseInt(hex.slice(5,7),16);
                updateCard(k, `rgba(${r},${g},${b},${alpha})`);
              } else {
                updateCard(k, hex);
              }
            };

            return (
              <Row label={label}>
                <div style={{ display:'flex', alignItems:'center', gap:5, flex:1, minWidth:0 }}>
                  {/* Swatch + native picker */}
                  <div style={{ position:'relative', width:24, height:24, flexShrink:0, cursor:'pointer', borderRadius:2 }}>
                    <div style={{ position:'absolute', inset:0, background:val,
                      border:`1px solid ${border}`, borderRadius:2 }}/>
                    <input type="color" value={hex6} onChange={onPickerChange}
                      style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
                  </div>
                  {/* Text field — uncontrolled (key=val forces re-init when val changes externally) */}
                  <input type="text" key={val} defaultValue={val}
                    onBlur={e => applyColorText(e.target.value, k)}
                    onKeyDown={e => { if (e.key === 'Enter') applyColorText(e.target.value, k); }}
                    spellCheck={false}
                    placeholder="#rrggbb or rgba(r,g,b,a)"
                    style={{ ...mono, background:'#111', border:`1px solid ${border}`,
                      color:'#ddd', fontSize:9, flex:1, padding:'3px 6px', minWidth:0 }}/>
                  {/* Alpha slider for rgba */}
                  {isRgba && (
                    <input type="range" min={0} max={1} step={0.01} value={alpha}
                      onChange={e => {
                        const r = parseInt(hex6.slice(1,3),16);
                        const g = parseInt(hex6.slice(3,5),16);
                        const b = parseInt(hex6.slice(5,7),16);
                        updateCard(k, `rgba(${r},${g},${b},${+e.target.value})`);
                      }}
                      style={{ width:48, accentColor: green }}
                      title={`Opacity: ${Math.round(alpha*100)}%`}/>
                  )}
                </div>
              </Row>
            );
          };

          return (
          <div style={{ display:'flex', gap:0, alignItems:'flex-start', minHeight:600 }}>

            {/* ── LEFT: rank picker + identity + card settings ── */}
            <div style={{ width:380, flexShrink:0, borderRight:`1px solid ${border}`, paddingRight:20 }}>

              {/* Toolbar */}
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
                {/* Rank selector dropdown */}
                <div style={{ flex:1, position:'relative' }}>
                  <select value={selIdx}
                    onChange={e => setSelectedRankIdx(+e.target.value)}
                    style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
                      padding:'5px 28px 5px 10px', fontSize:10, width:'100%', cursor:'pointer',
                      appearance:'none', WebkitAppearance:'none' }}>
                    {sortedRanks.map((r, i) => (
                      <option key={i} value={i}>
                        {r.name}{r.min===-Infinity ? ' (< 0)' : ` (≥ ${r.min})`}
                      </option>
                    ))}
                  </select>
                  <div style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
                    color:dim, pointerEvents:'none', fontSize:9 }}>▾</div>
                </div>
                <button onClick={addRank}
                  style={{ ...mono, background:'none', border:`1px solid ${green}55`, color:green,
                    cursor:'pointer', padding:'5px 10px', fontSize:9, letterSpacing:'.08em', whiteSpace:'nowrap' }}>
                  + NEW
                </button>
                <button onClick={() => removeRank(origIdx)}
                  style={{ ...mono, background:'none', border:`1px solid #ff003355`, color:'#ff4444',
                    cursor:'pointer', padding:'5px 10px', fontSize:9 }}>
                  × DEL
                </button>
                <button onClick={saveRanks}
                  style={{ ...mono, background:green+'22', border:`1px solid ${green}`, color:green,
                    cursor:'pointer', padding:'5px 10px', fontSize:9, letterSpacing:'.06em', whiteSpace:'nowrap' }}>
                  SAVE
                </button>
              </div>

              {/* Color swatch */}
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 10px',
                background:`${previewR.color}0a`, border:`1px solid ${previewR.color}33` }}>
                <div style={{ width:8, height:8, background:previewR.color,
                  boxShadow:`0 0 8px ${previewR.color}` }}/>
                <span style={{ fontFamily:"'Orbitron',monospace", fontSize:11, fontWeight:700,
                  color:previewR.color, letterSpacing:'.12em' }}>{previewR.name}</span>
                <span style={{ ...mono, fontSize:8, color:dim, marginLeft:'auto' }}>
                  {previewR.min===-Infinity ? '< 0 SOL' : `≥ ${previewR.min} SOL`}
                </span>
              </div>

              {/* ── IDENTITY (name/min/colors/shape) ── */}
              <Section title="IDENTITY"/>

              <Row label="Name">
                <input value={previewR.name} onClick={e => e.stopPropagation()}
                  onChange={e => updateRank(origIdx,'name',e.target.value.toUpperCase())}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
                    padding:'3px 7px', fontSize:10, fontWeight:700, flex:1, boxSizing:'border-box' }}/>
              </Row>
              <Row label="Min SOL threshold">
                <input type="number" value={previewR.min===-Infinity?'':previewR.min}
                  placeholder="-∞ (REKT)"
                  disabled={previewR.min===-Infinity}
                  onChange={e => updateRank(origIdx,'min',parseFloat(e.target.value)||0)}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:dim,
                    padding:'3px 5px', fontSize:10, flex:1, opacity:previewR.min===-Infinity?0.4:1 }}/>
              </Row>
              <Row label="Accent color">
                <div style={{ position:'relative', width:20, height:20, flexShrink:0 }}>
                  <div style={{ position:'absolute', inset:0, background:previewR.color, border:`1px solid ${border}` }}/>
                  <input type="color" value={previewR.color} onChange={e => updateRank(origIdx,'color',e.target.value)}
                    style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
                </div>
                <input type="text" defaultValue={previewR.color}
                  onBlur={e => updateRank(origIdx,'color',e.target.value)}
                  onKeyDown={e => e.key==='Enter' && updateRank(origIdx,'color',e.target.value)}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#ddd', fontSize:9, flex:1, padding:'2px 5px' }}/>
              </Row>
              <Row label="Gradient top (G1)">
                <div style={{ position:'relative', width:20, height:20, flexShrink:0 }}>
                  <div style={{ position:'absolute', inset:0, background:previewR.g1, border:`1px solid ${border}` }}/>
                  <input type="color" value={previewR.g1} onChange={e => updateRank(origIdx,'g1',e.target.value)}
                    style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
                </div>
                <input type="text" defaultValue={previewR.g1}
                  onBlur={e => updateRank(origIdx,'g1',e.target.value)}
                  onKeyDown={e => e.key==='Enter' && updateRank(origIdx,'g1',e.target.value)}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#ddd', fontSize:9, flex:1, padding:'2px 5px' }}/>
              </Row>
              <Row label="Gradient bottom (G2)">
                <div style={{ position:'relative', width:20, height:20, flexShrink:0 }}>
                  <div style={{ position:'absolute', inset:0, background:previewR.g2, border:`1px solid ${border}` }}/>
                  <input type="color" value={previewR.g2} onChange={e => updateRank(origIdx,'g2',e.target.value)}
                    style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
                </div>
                <input type="text" defaultValue={previewR.g2}
                  onBlur={e => updateRank(origIdx,'g2',e.target.value)}
                  onKeyDown={e => e.key==='Enter' && updateRank(origIdx,'g2',e.target.value)}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#ddd', fontSize:9, flex:1, padding:'2px 5px' }}/>
              </Row>
              <Row label="Shape">
                <select value={previewR.shape ?? previewR.name}
                  onChange={e => updateRank(origIdx,'shape',e.target.value)}
                  style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
                    padding:'3px 5px', fontSize:9, flex:1, cursor:'pointer' }}>
                  {RANK_SHAPE_NAMES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Row>
              <Row label="Custom SVG">
                <div style={{ display:'flex', gap:4, flex:1 }}>
                  <label style={{ ...mono, fontSize:8, color:dim, cursor:'pointer', border:`1px dashed ${border}`,
                    padding:'3px 8px', flex:1, textAlign:'center' }} title="Upload custom SVG">
                    {previewR.svgPath ? '↑ RE-UPLOAD SVG' : '↑ UPLOAD SVG'}
                    <input type="file" accept=".svg,image/svg+xml" style={{ display:'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0]; if (!file) return;
                        const reader = new FileReader();
                        reader.onload = ev => {
                          try {
                            const parser = new DOMParser();
                            const doc = parser.parseFromString(ev.target.result, 'image/svg+xml');
                            const svgEl = doc.querySelector('svg');
                            const els = doc.querySelectorAll('path,polygon,polyline,circle,rect,ellipse');
                            if (!els.length) { alert('No shape elements found'); return; }
                            let vb = svgEl?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
                            if (!vb || vb.length < 4) {
                              const w = parseFloat(svgEl?.getAttribute('width') ?? '100');
                              const h = parseFloat(svgEl?.getAttribute('height') ?? '100');
                              vb = [0,0,w,h];
                            }
                            const inner = [...els].map(el => {
                              const cl = el.cloneNode(true);
                              cl.removeAttribute('fill'); cl.removeAttribute('stroke');
                              cl.style.removeProperty('fill'); cl.style.removeProperty('stroke');
                              return cl.outerHTML;
                            }).join('');
                            updateRank(origIdx,'svgPath',inner);
                            updateRank(origIdx,'svgViewBox',vb.join(' '));
                          } catch(err) { alert('SVG parse error: '+err.message); }
                        };
                        reader.readAsText(file);
                        e.target.value = '';
                      }}/>
                  </label>
                  {previewR.svgPath && (
                    <button onClick={() => { updateRank(origIdx,'svgPath',null); updateRank(origIdx,'svgViewBox',null); }}
                      style={{ ...mono, fontSize:8, color:'#ff4444', background:'none',
                        border:'1px solid #ff003333', cursor:'pointer', padding:'3px 7px' }}>✕ CLEAR</button>
                  )}
                </div>
              </Row>

              {/* ── CARD APPEARANCE SETTINGS ── */}
              <div style={{ overflowY:'auto', maxHeight:540 }}>

                <Section title="GRADIENT"/>
                <Slider label="Angle (°)"       k="gradientAngle"  min={0}   max={360} step={5}    unit="°"/>
                <Slider label="G1 opacity"       k="g1Opacity"      min={0}   max={1}   step={0.05} unit=""/>
                <Slider label="G1 stop (%)"      k="g1Stop"         min={0}   max={60}  step={1}    unit="%"/>
                <Slider label="Mid stop (%)"     k="midStop"        min={10}  max={90}  step={1}    unit="%"/>
                <ColorPicker label="Mid color"   k="midColor"/>
                <Slider label="End stop (%)"     k="endStop"        min={50}  max={100} step={1}    unit="%"/>
                <ColorPicker label="End color"   k="endColor"/>

                <Section title="BORDER"/>
                <Slider label="Width (px)"       k="borderWidth"    min={0}   max={8}   step={0.5}  unit="px"/>
                <Slider label="Opacity"          k="borderOpacity"  min={0}   max={1}   step={0.05} unit=""/>

                <Section title="DIAGONAL SLAB"/>
                <Slider label="Fill opacity"     k="slabOpacity"    min={0}   max={0.4} step={0.01} unit=""/>
                <Slider label="Line width"       k="slabLineWidth"  min={0}   max={4}   step={0.1}  unit="px"/>
                <Slider label="Line opacity"     k="slabLineOpacity" min={0}  max={1}   step={0.05} unit=""/>

                <Section title="TICKET DIVIDER (dashed)"/>
                <Slider label="Thickness"        k="dividerWidth"   min={0}   max={6}   step={0.5}  unit="px"/>
                <Slider label="Opacity"          k="dividerOpacity" min={0}   max={1}   step={0.05} unit=""/>
                <Row label="Dash pattern">
                  <input value={c.dividerDash ?? DEFAULT_CARD.dividerDash}
                    onChange={e => updateCard('dividerDash', e.target.value)}
                    placeholder="4,4"
                    style={{ ...mono, background:'#111', border:`1px solid ${border}`, color:'#fff',
                      padding:'3px 7px', fontSize:9, flex:1 }}/>
                  <span style={{ ...mono, fontSize:7, color:dim }}>e.g. 4,4 · 8,2 · 0</span>
                </Row>

                <Section title="SHAPE"/>
                <Toggle label="Use rank color"   k="useRankColor"/>
                {!(c.useRankColor ?? DEFAULT_CARD.useRankColor) && (
                  <ColorPicker label="Custom color" k="customColor"/>
                )}
                <Slider label="Shape size (px)"  k="shapeSize"      min={10}  max={100} step={2}    unit="px"/>
                <Slider label="Shape X pos"      k="shapeX"         min={0}   max={340} step={2}    unit="px" nullable={true}/>
                <Slider label="Shape Y pos"      k="shapeY"         min={0}   max={300} step={2}    unit="px"/>
                <Toggle label="Show ghost"       k="showGhost"/>
                <Slider label="Ghost size (px)"  k="ghostSize"      min={40}  max={260} step={5}    unit="px"/>
                <Slider label="Ghost X pos"      k="ghostX"         min={0}   max={340} step={2}    unit="px" nullable={true}/>
                <Slider label="Ghost Y pos"      k="ghostY"         min={0}   max={300} step={2}    unit="px" nullable={true}/>

                <Section title="TYPOGRAPHY"/>
                <Slider label="Rank name size"       k="rankFontSize"        min={14} max={48} step={1} unit="px"/>
                <Slider label='"SOL" label size'     k="solFontSize"         min={6}  max={20} step={1} unit="px"/>
                <Slider label="Wallet label size"    k="walletLabelFontSize" min={5}  max={16} step={1} unit="px"/>
                <ColorPicker label="Minor text color" k="minorTextColor"/>

                <Section title="DISPLAY"/>
                <Toggle label="Show PnL chart"   k="showChart"/>

                <div style={{ height:20 }}/>
              </div>
            </div>

            {/* ── RIGHT: live preview ── */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center',
              paddingLeft:28, paddingTop:4, gap:14, position:'sticky', top:0 }}>
              <div style={{ ...mono, fontSize:8, color:dim, letterSpacing:'.12em' }}>
                LIVE PREVIEW · changes reflect instantly
              </div>
              <div style={{ transform:'scale(0.82)', transformOrigin:'top center', marginBottom:-80 }}>
                <ShareCardInner
                  S={S}
                  pnlCurve={[]}
                  closed={[]}
                  totalPnl={previewR.min === -Infinity ? -1.5 : (previewR.min ?? 0) + 0.5}
                  winRate="58.0"
                  tf="ALL"
                  walletLabel={previewR.name}
                  _overrideRank={previewR}
                />
              </div>
              <div style={{ ...mono, fontSize:8, color:dim, letterSpacing:'.08em', textAlign:'center', marginTop:4 }}>
                · Changes saved with <span style={{ color:'#fff' }}>SAVE</span> button ·<br/>
                · REKT (min = −∞) catches all negative PnL ·
              </div>
            </div>

          </div>
          );
        })()}
        {adminTab === "card" && (() => {
          // Global DEFAULT_CARD overrides stored in S.defaultCard
          // These apply to ALL ranks unless a rank has its own override
          const dc = S.defaultCard ?? {};
          const setDC = (k, v) => setSetting("defaultCard", { ...dc, [k]: v });
          const num = (k, label, min, max, step=1, unit="") => (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>{label}</label>
              <input type="range" min={min} max={max} step={step}
                value={dc[k] ?? DEFAULT_CARD[k] ?? min}
                onChange={e => setDC(k, +e.target.value)}
                style={{ flex:1, accentColor:green }}/>
              <span style={{ ...mono, fontSize:9, color:green, width:44, textAlign:"right" }}>
                {(dc[k] ?? DEFAULT_CARD[k] ?? min)}{unit}
              </span>
              <button onClick={() => { const nd = {...dc}; delete nd[k]; setSetting("defaultCard", nd); }}
                title="Reset to default"
                style={{ background:"none", border:`1px solid ${border}`, color:dim, cursor:"pointer",
                  fontSize:8, padding:"2px 6px", ...mono, flexShrink:0 }}>↺</button>
            </div>
          );
          const col = (k, label) => (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>{label}</label>
              <input type="color" value={dc[k] ?? DEFAULT_CARD[k] ?? "#000000"}
                onChange={e => setDC(k, e.target.value)}
                style={{ width:32, height:24, border:"none", background:"none", cursor:"pointer" }}/>
              <input type="text" value={dc[k] ?? DEFAULT_CARD[k] ?? ""}
                onChange={e => setDC(k, e.target.value)}
                style={{ flex:1, background:"#0a0a0a", border:`1px solid ${border}`, color:"#fff",
                  ...mono, fontSize:9, padding:"3px 6px" }}/>
              <button onClick={() => { const nd = {...dc}; delete nd[k]; setSetting("defaultCard", nd); }}
                title="Reset to default"
                style={{ background:"none", border:`1px solid ${border}`, color:dim, cursor:"pointer",
                  fontSize:8, padding:"2px 6px", ...mono, flexShrink:0 }}>↺</button>
            </div>
          );
          const Section = ({ title }) => (
            <div style={{ ...mono, fontSize:8, color:green, letterSpacing:".14em",
              borderBottom:`1px solid ${green}22`, paddingBottom:4, marginTop:14, marginBottom:8 }}>
              {title}
            </div>
          );
          // Sample data for live preview
          const previewPnl = dc.previewPnl ?? 1.234;
          const sampleCurve = [
            { cumPnl: 0,    tradePnl: 0 },
            { cumPnl: -0.4, tradePnl: -0.4 },
            { cumPnl: 0.2,  tradePnl: 0.6 },
            { cumPnl: 0.8,  tradePnl: 0.6 },
            { cumPnl: previewPnl, tradePnl: previewPnl - 0.8 },
          ];
          const sampleClosed = [
            { solIn: 0.5, solOut: 0.5 + previewPnl },
          ];
          return (
            <div style={{ padding:"4px 0" }}>
              <div style={{ ...mono, fontSize:9, color:dim, marginBottom:12, lineHeight:1.7 }}>
                Global card defaults — applied to all ranks. Per-rank settings in the Ranks tab override these.
                Click ↺ to reset any field to its built-in default.
              </div>
              {/* Live preview */}
              <div style={{ marginBottom:16, display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ ...mono, fontSize:8, color:green, letterSpacing:".14em" }}>LIVE PREVIEW</div>
                <div style={{ display:"flex", alignItems:"flex-start", gap:12, flexWrap:"wrap" }}>
                  <div style={{ transform:"scale(0.72)", transformOrigin:"top left", flexShrink:0, height:354 }}>
                    <ShareCardInner S={{ ...S, defaultCard: dc }}
                      pnlCurve={sampleCurve} closed={sampleClosed}
                      totalPnl={previewPnl} winRate="66.67" tf="ALL"
                      walletLabel="PREVIEW WALLET" />
                  </div>
                  <div style={{ flex:1, minWidth:160 }}>
                    <div style={{ ...mono, fontSize:8, color:dim, marginBottom:8 }}>PREVIEW PnL VALUE</div>
                    <input type="number" step="0.001"
                      value={previewPnl}
                      onChange={e => setDC("previewPnl", +e.target.value)}
                      style={{ width:"100%", background:"#0a0a0a", border:`1px solid ${border}`,
                        color:"#fff", ...mono, fontSize:11, padding:"5px 8px", boxSizing:"border-box" }}/>
                    <div style={{ ...mono, fontSize:8, color:dim, marginTop:6, lineHeight:1.6, opacity:0.6 }}>
                      Change this to test different PnL magnitudes and see how the font scales.
                    </div>
                  </div>
                </div>
              </div>
              <Section title="LAYOUT" />
              {num("cardPad",         "Left / right padding",  0,  60,  1,  "px")}
              {num("rankNameY",       "Rank name Y",           20, 120, 1,  "px")}
              {num("dividerLineY",    "Divider line Y",        30, 130, 1,  "px")}
              {num("walletLabelY",    "Wallet label Y",        40, 140, 1,  "px")}
              {num("pnlY",            "PnL number Y",          80, 280, 1,  "px")}
              {num("currencyLabelY",  "Currency label Y",      90, 290, 1,  "px")}
              {num("pctReturnY",      "% Return Y",           100, 320, 1,  "px")}
              {num("pctReturnSize",   "% Return font size",    8,  40,  1,  "px")}
              {num("pnlLetterSpacing","PnL letter spacing",  -10,  10,  1,  "")}
              <Section title="BORDERS & DIVIDER" />
              {num("borderWidth",    "Border width",          0,   8,   0.1, "px")}
              {num("borderOpacity",  "Border opacity",        0,   1,   0.01)}
              {num("dividerWidth",   "Divider width",         0,   4,   0.5, "px")}
              {num("dividerOpacity", "Divider opacity",       0,   1,   0.01)}
              <Section title="BACKGROUND GRADIENT" />
              {num("gradientAngle",  "Gradient angle",        0,   360, 5,   "°")}
              {num("g1Stop",         "G1 stop %",             0,   100, 1,   "%")}
              {num("g1Opacity",      "G1 opacity",            0,   1,   0.01)}
              {num("midStop",        "Mid stop %",            0,   100, 1,   "%")}
              {col("midColor",       "Mid color")}
              {num("endStop",        "End stop %",            0,   100, 1,   "%")}
              {col("endColor",       "End color")}
              <Section title="DIAGONAL SLAB" />
              {num("slabOpacity",    "Slab opacity",          0,   0.5, 0.01)}
              {num("slabLineWidth",  "Slab line width",       0,   4,   0.1, "px")}
              {num("slabLineOpacity","Slab line opacity",     0,   1,   0.01)}
              <Section title="TYPOGRAPHY" />
              {num("rankFontSize",         "Rank name font",       8,  52, 1,  "px")}
              {num("solFontSize",          "Currency label font",  6,  16, 1,  "px")}
              {num("walletLabelFontSize",  "Wallet label font",    6,  14, 1,  "px")}
              {col("minorTextColor",       "Minor text color")}
              <Section title="SHAPE" />
              {num("shapeSize",  "Shape size",   10, 100, 2, "px")}
              {num("shapeX",     "Shape X",       0, 340, 2, "px")}
              {num("shapeY",     "Shape Y",       0, 200, 2, "px")}
              {num("ghostSize",  "Ghost size",   20, 200, 5, "px")}
              <Section title="DIVIDER DASH" />
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>Divider dash pattern</label>
                <input type="text" value={dc.dividerDash ?? DEFAULT_CARD.dividerDash}
                  onChange={e => setDC("dividerDash", e.target.value)}
                  placeholder="4,4"
                  style={{ flex:1, background:"#0a0a0a", border:`1px solid ${border}`, color:"#fff",
                    ...mono, fontSize:9, padding:"3px 6px" }}/>
              </div>
            </div>
          );
        })()}

                {/* ── RANKS V2 TAB ── */}
        {adminTab === "ranks_v2" && (
          <AdminRanksV2
            ranks={ranks}
            selectedRankIdx={selectedRankIdx}
            setSelectedRankIdx={setSelectedRankIdx}
            updateRank={updateRank}
            addRank={addRank}
            removeRank={removeRank}
            saveRanks={saveRanks}
            S={S}
            adminPreviewCur={adminPreviewCur}
            setAdminPreviewCur={setAdminPreviewCur}
            ADMIN_PREVIEW_CURS={ADMIN_PREVIEW_CURS}
            green={green}
            border={border}
            dim={dim}
            mono={mono}
          />
        )}

{/* ── CARD V2 TAB ── */}
        {adminTab === "card_v2" && (() => {
          const dc    = S.defaultCardV2 ?? {};
          // setDC merges a single key into S.defaultCardV2
          const setDC = (k, v) => setSetting("defaultCardV2", { ...dc, [k]: v });
          const resetDC = k => { const nd={...dc}; delete nd[k]; setSetting("defaultCardV2", nd); };
          // Read with fallback to DEFAULT_CARD_V2 built-ins
          const gcv = k => dc[k] ?? DEFAULT_CARD_V2[k];

          const V2Sec = ({ title }) => (
            <div style={{ ...mono, fontSize:8, color:green, letterSpacing:".14em",
              borderBottom:`1px solid ${green}22`, paddingBottom:4, marginTop:14, marginBottom:8 }}>
              {title}</div>
          );
          // Number slider + text input + reset
          const N = ({ k, label, min, max, step=1, unit="" }) => {
            const val = gcv(k) ?? min;
            return (
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>{label}</label>
                <input type="range" min={min} max={max} step={step}
                  value={Math.min(max,Math.max(min,+val||0))}
                  onChange={e => setDC(k, +e.target.value)}
                  style={{ flex:1, accentColor:green }}/>
                <span style={{ ...mono, fontSize:9, color:green, width:52, textAlign:"right", flexShrink:0 }}>
                  {val}{unit}
                </span>
                <button onClick={() => resetDC(k)} title="Reset to default"
                  style={{ background:"none", border:`1px solid ${border}`, color:dim,
                    cursor:"pointer", fontSize:8, padding:"2px 6px", ...mono, flexShrink:0 }}>↺</button>
              </div>
            );
          };
          // Text input + reset (for dash pattern etc.)
          const T = ({ k, label, placeholder="" }) => (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>{label}</label>
              <input type="text" value={gcv(k) ?? ''} placeholder={placeholder}
                onChange={e => setDC(k, e.target.value)}
                style={{ flex:1, background:"#0a0a0a", border:`1px solid ${border}`, color:"#fff",
                  ...mono, fontSize:9, padding:"3px 6px" }}/>
              <button onClick={() => resetDC(k)} title="Reset"
                style={{ background:"none", border:`1px solid ${border}`, color:dim,
                  cursor:"pointer", fontSize:8, padding:"2px 6px", ...mono, flexShrink:0 }}>↺</button>
            </div>
          );
          // Segmented alignment selector
          const AlignPicker = ({ k, label, opts }) => {
            const cur = gcv(k);
            return (
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>{label}</label>
                <div style={{ display:"flex", gap:4 }}>
                  {opts.map(opt => (
                    <button key={opt.v} onClick={() => setDC(k, opt.v)}
                      style={{ ...mono, fontSize:8, padding:"3px 10px",
                        background: cur===opt.v ? green+'22' : '#111',
                        border:`1px solid ${cur===opt.v ? green : border}`,
                        color: cur===opt.v ? green : dim,
                        cursor:'pointer', letterSpacing:'.06em', transition:'all .1s' }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => resetDC(k)} title="Reset"
                  style={{ background:"none", border:`1px solid ${border}`, color:dim,
                    cursor:"pointer", fontSize:8, padding:"2px 6px", ...mono, flexShrink:0 }}>↺</button>
              </div>
            );
          };

          const previewPnl = dc.previewPnl ?? 1.234;
          const sampleCurve  = [{cumPnl:0},{cumPnl:-0.3},{cumPnl:0.2},{cumPnl:0.8},{cumPnl:previewPnl}];
          const sampleClosed = [{ solIn:0.5, solOut:0.5+previewPnl }];

          return (
            <div style={{ display:"flex", gap:32, alignItems:"flex-start" }}>

              {/* LEFT: settings */}
              <div style={{ flex:1, minWidth:520, overflowY:'auto', maxHeight:'calc(100vh - 100px)' }}>
                <div style={{ ...mono, fontSize:9, color:dim, marginBottom:12, lineHeight:1.7 }}>
                  Global layout/style for the new V2 card. These apply to all ranks.
                  Per-rank gradient/color overrides live in the Ranks V2 tab.
                  Click ↺ to reset to built-in default.
                </div>

                <V2Sec title="TEXT SIZES"/>
                {N({ k:"v2S1Max",  label:"PnL max font size",     min:36, max:90,  step:1,   unit:"px" })}
                {N({ k:"v2S2",     label:"Rank name / Return %",  min:12, max:36,  step:1,   unit:"px" })}
                {N({ k:"v2S3",     label:"All other text",        min:8,  max:20,  step:1,   unit:"px" })}

                <V2Sec title="TEXT ALIGNMENT (ADMIN DEFAULT)"/>
                {AlignPicker({ k:"v2TextAlign", label:"Default alignment",
                  opts:[{v:'left',label:'◂ LEFT'},{v:'center',label:'● CENTER'},{v:'right',label:'RIGHT ▸'}] })}
                <div style={{ ...mono, fontSize:8, color:dim, marginBottom:8, lineHeight:1.6 }}>
                  Users can override this per-share in the share modal.
                </div>

                <V2Sec title="BORDER"/>
                {N({ k:"v2BorderWidth",   label:"Width",   min:0, max:8,  step:0.1, unit:"px" })}
                {N({ k:"v2BorderOpacity", label:"Opacity", min:0, max:1,  step:0.02         })}

                <V2Sec title="TICKET DIVIDER"/>
                {N({ k:"v2DividerWidth",   label:"Thickness", min:0, max:6,  step:0.25, unit:"px" })}
                {N({ k:"v2DividerOpacity", label:"Opacity",   min:0, max:1,  step:0.02         })}
                {T({ k:"v2DividerDash", label:"Dash pattern", placeholder:"4,4" })}

                <V2Sec title="L-BRACKETS"/>
                {N({ k:"v2BracketLen",     label:"Arm length",  min:4,  max:40,  step:1,  unit:"px" })}
                {N({ k:"v2BracketOpacity", label:"Opacity",     min:0,  max:0.6, step:0.02         })}

                <V2Sec title="PnL BLOCK VERTICAL POSITION"/>
                {N({ k:"v2PnlYOffset",      label:"Y offset from center",  min:-80, max:80,  step:1, unit:"px" })}
                {N({ k:"v2ReturnLabelGap",  label:"Gap PnL→RETURN label",  min:4,   max:40,  step:1, unit:"px" })}
                {N({ k:"v2ReturnValGap",    label:"Gap label→return value", min:2,   max:20,  step:1, unit:"px" })}
                {N({ k:"v2TfGap",           label:"Gap timeframe→logo",     min:4,   max:30,  step:1, unit:"px" })}
                {N({ k:"v2NicknameYOff",    label:"Nickname offset from bracket", min:-30, max:10, step:1, unit:"px" })}

                <V2Sec title="VOLUME POSITIONS"/>
                {N({ k:"v2VolGraphX",  label:"Vol col X (with chart)",    min:180, max:300, step:2, unit:"px" })}
                {N({ k:"v2VolNgColA",  label:"BOUGHT col X (no chart)",   min:10,  max:160, step:2, unit:"px" })}
                {N({ k:"v2VolNgColB",  label:"SOLD col X (no chart)",     min:120, max:260, step:2, unit:"px" })}

                <V2Sec title="DISPLAY"/>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <label style={{ ...mono, fontSize:9, color:dim, width:200, flexShrink:0 }}>Show PnL chart (default)</label>
                  <label style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
                    <input type="checkbox"
                      checked={dc.showChart ?? DEFAULT_CARD.showChart ?? true}
                      onChange={e => setDC('showChart', e.target.checked)}
                      style={{ accentColor:green, cursor:'pointer' }}/>
                    <span style={{ ...mono, fontSize:9,
                      color:(dc.showChart??DEFAULT_CARD.showChart??true)?green:dim }}>
                      {(dc.showChart??DEFAULT_CARD.showChart??true)?'ON':'OFF'}
                    </span>
                  </label>
                  <button onClick={() => resetDC('showChart')} title="Reset"
                    style={{ background:"none", border:`1px solid ${border}`, color:dim,
                      cursor:"pointer", fontSize:8, padding:"2px 6px", ...mono }}>↺</button>
                </div>

                <div style={{ height:20 }}/>
              </div>

              {/* RIGHT: live preview + PnL value input */}
              <div style={{ flexShrink:0, display:"flex", flexDirection:"column", gap:10, position:'sticky', top:0 }}>
                <div style={{ ...mono, fontSize:8, color:green, letterSpacing:".14em" }}>LIVE PREVIEW</div>
                <div style={{ transform:"scale(0.72)", transformOrigin:"top left", height:354, width:245 }}>
                  <ShareCardInnerV2
                    S={{ ...S, defaultCardV2: dc, currency: gcv('previewCurrency') ?? 'SOL' }}
                    pnlCurve={sampleCurve} closed={sampleClosed}
                    totalPnl={previewPnl} winRate="66.67" tf="ALL"
                    walletLabel="PREVIEW"/>
                </div>
                <div style={{ ...mono, fontSize:8, color:dim, marginBottom:4 }}>PREVIEW PnL VALUE</div>
                <input type="number" step="0.001" value={previewPnl}
                  onChange={e => setDC("previewPnl", +e.target.value)}
                  style={{ width:180, background:"#0a0a0a", border:`1px solid ${border}`,
                    color:"#fff", ...mono, fontSize:11, padding:"5px 8px", boxSizing:"border-box" }}/>
                <div style={{ ...mono, fontSize:8, color:dim, lineHeight:1.6, opacity:0.6, maxWidth:180 }}>
                  Change to preview different PnL magnitudes and see font-size scaling.
                </div>
                <div style={{ ...mono, fontSize:8, color:dim, marginTop:8, marginBottom:4 }}>PREVIEW CURRENCY</div>
                <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                  {['SOL','USD','EUR','PLN','UAH','KZT','GBP'].map(c => {
                    const cur = gcv('previewCurrency') ?? 'SOL';
                    return (
                      <button key={c} onClick={() => setDC('previewCurrency', c)}
                        style={{ ...mono, fontSize:8, padding:'3px 7px',
                          background: cur===c ? green+'22' : '#0a0a0a',
                          border:`1px solid ${cur===c ? green : border}`,
                          color: cur===c ? green : dim, cursor:'pointer' }}>{c}</button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

                {adminTab === "wallets" && data && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 24 }}>
              {[
                { label: "UNIQUE WALLETS", value: data.stats?.totalWallets ?? 0 },
                { label: "TOTAL TRADES",   value: (data.stats?.totalTrades ?? 0).toLocaleString() },
                { label: "LAST SYNC",      value: data.stats?.lastSync ? new Date(data.stats.lastSync).toLocaleString() : "—" },
              ].map(s => (
                <div key={s.label} style={{ border: `1px solid ${border}`, background: card, padding: "14px 18px" }}>
                  <div style={{ ...mono, fontSize: 9, color: dim, letterSpacing: ".1em", marginBottom: 6 }}>{s.label}</div>
                  <div style={{ ...mono, fontSize: 20, color: "#fff", fontWeight: 700 }}>{s.value}</div>
                </div>
              ))}
            </div>
            <div style={{ border: `1px solid ${border}`, padding: "16px 18px", background: card }}>
              <div style={{ ...mono, fontSize: 13, color: dim, lineHeight: 1.8 }}>
                <div>Wallet addresses are stored as <span style={{ color: green }}>HMAC-SHA256 hashes</span> — raw addresses are never saved to the database.</div>
                <div>Individual wallet data is not visible here by design.</div>
                <div style={{ marginTop: 8, color: dim, opacity: 0.6, fontSize: 11 }}>To manage a specific wallet, use the purge/delete endpoints directly from the worker dashboard.</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
function loadLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── TRADES TAB with pagination ────────────────────────────────────────────────
function TradesTab({ filtered, wallets, S, getColor, tf, onTokenClick }) {
  const PER_PAGE_OPTIONS = [25, 50, 100, 200, 500];
  const [page, setPage]       = useState(1);
  // Precompute tradeId→wallet map once — avoids O(n²) find() on every row render
  const tradeWalletMap = useMemo(() => {
    const m = {};
    for (const w of wallets) for (const t of (w.trades ?? [])) m[t.id] = w;
    return m;
  }, [wallets]);
  const [perPage, setPerPage] = useState(50);
  const [oldest, setOldest]   = useState(false);

  const sorted = oldest ? [...filtered] : [...filtered].reverse();
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const slice = sorted.slice((page - 1) * perPage, page * perPage);

  // Reset to page 1 when filter changes
  useEffect(() => setPage(1), [filtered, oldest, perPage]);

  const mono = { fontFamily: "'DM Mono',monospace" };
  const btn = (active, onClick, children, extra = {}) => (
    <button onClick={onClick} style={{
      background: "none", border: `1px solid ${active ? S.accentGreen : S.borderColor}`,
      color: active ? S.accentGreen : S.textDim, cursor: "pointer", padding: "4px 9px",
      fontSize: 9, ...mono, letterSpacing: ".05em", ...extra
    }}>{children}</button>
  );

  return (
    <BorderCard S={S} style={{ overflow: "auto" }} className="fade-up">
      {/* Header */}
      <div style={{ padding: "12px 18px 10px", borderBottom: `1px solid ${S.borderColor}`,
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span className="ts-mono" style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "#fff", letterSpacing: ".12em" }}>
          TRADE HISTORY <span style={{ color: S.textDim, fontWeight: 400, fontSize: 9, marginLeft: 10 }}>{tf}</span>
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Latest/Oldest toggle */}
          <div style={{ display: "flex" }}>
            {btn(!oldest, () => setOldest(false), "LATEST")}
            {btn(oldest,  () => setOldest(true),  "OLDEST")}
          </div>
          {/* Per page */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="ts-dim" style={{ ...mono, fontSize: 9, color: S.textDim }}>per page:</span>
            {PER_PAGE_OPTIONS.map(n => btn(perPage === n, () => setPerPage(n), n))}
          </div>
          <span style={{ color: S.textDim, fontSize: 9, ...mono }}>
            {sorted.length} TXS
          </span>
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: S.textDim, fontSize: 9, letterSpacing: ".1em", borderBottom: `1px solid ${S.borderColor}` }}>
            {["WALLET", "TIME", "TOKEN", "TYPE", "SOL", "SIG"].map((h) => (
              <th key={h} style={{ padding: "9px 14px", textAlign: ["SOL"].includes(h) ? "right" : "left", fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.map((t) => {
            const wInfo = tradeWalletMap[t.id];
            return (
              <tr key={t.id} className="tr" style={{ "--border": S.borderColor }}>
                <td style={{ padding: "9px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div className="dot" style={{ background: getColor(wInfo ?? { colorIdx: 0 }), boxShadow: `0 0 4px ${getColor(wInfo ?? { colorIdx: 0 })}88` }} />
                    <span style={{ color: S.textDim, fontSize: 10 }}>{wInfo?.label}</span>
                  </div>
                </td>
                <td style={{ padding: "9px 14px", color: S.textDim, fontSize: 10 }}>{t.ts?.slice(0, 16).replace("T", " ")}</td>
                <td style={{ padding: "9px 14px", color: "#fff", fontFamily: "'Orbitron',monospace", fontSize: 10, letterSpacing: ".06em", cursor: onTokenClick ? "pointer" : undefined }}
                  onClick={() => {
                    const url = t.mint ? terminalUrl(S.terminalId ?? "padre", t.mint) : null;
                    if (url) window.open(url, "_blank", "noopener,noreferrer");
                    else if (onTokenClick) onTokenClick({ mint: t.mint, token: t.token });
                  }}
                  onMouseEnter={(e) => { if (onTokenClick) e.currentTarget.style.color = S.accentGreen; }}
                  onMouseLeave={(e) => { if (onTokenClick) e.currentTarget.style.color = "#fff"; }}>{t.token}</td>
                <td style={{ padding: "9px 14px" }}><span className={`pill pill-${t.type}`} style={{ "--buy": S.accentGreen, "--sell": S.accentRed }}>{t.type.toUpperCase()}</span></td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: t.type === "buy" ? S.accentRed + "99" : S.accentGreen + "99" }}>{fmt(t.sol)}</td>
                <td style={{ padding: "9px 14px" }}>
                  {t.sig && (
                    <a href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noopener noreferrer"
                      style={{ color: S.textDim, fontSize: 10, textDecoration: "none", letterSpacing: ".04em" }}
                      onMouseEnter={(e) => e.target.style.color = S.accentGreen}
                      onMouseLeave={(e) => e.target.style.color = S.textDim}>
                      {t.sig.slice(0, 8)}…↗
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Pagination footer */}
      {totalPages > 1 && (
        <div style={{ padding: "10px 18px", borderTop: `1px solid ${S.borderColor}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ ...mono, fontSize: 9, color: S.textDim }}>
            {(page - 1) * perPage + 1}–{Math.min(page * perPage, sorted.length)} of {sorted.length}
          </span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {btn(false, () => setPage(1), "«", { opacity: page > 1 ? 1 : 0.3 })}
            {btn(false, () => setPage(p => Math.max(1, p - 1)), "‹", { opacity: page > 1 ? 1 : 0.3 })}
            {/* Page numbers: show up to 5 around current */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => Math.abs(p - page) <= 2 || p === 1 || p === totalPages)
              .reduce((acc, p, i, arr) => {
                if (i > 0 && p - arr[i - 1] > 1) acc.push("…");
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) => typeof p === "string"
                ? <span key={`ell${i}`} style={{ ...mono, fontSize: 9, color: S.textDim, padding: "0 4px" }}>…</span>
                : btn(p === page, () => setPage(p), p)
              )}
            {btn(false, () => setPage(p => Math.min(totalPages, p + 1)), "›", { opacity: page < totalPages ? 1 : 0.3 })}
            {btn(false, () => setPage(totalPages), "»", { opacity: page < totalPages ? 1 : 0.3 })}
          </div>
        </div>
      )}
    </BorderCard>
  );
}

// ── TOKEN DETAIL ─────────────────────────────────────────────────────────────
function TokenDetail({ mint, token, trades, wallets, S, getColor, onBack }) {
  const [page, setPage]       = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [oldest, setOldest]   = useState(false);
  const PER_PAGE_OPTIONS = [25, 50, 100, 200];

  // All trades for this mint across selected wallets
  const tokenTrades = useMemo(() =>
    trades.filter(t => (t.mint ?? t.token) === mint)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts)),
    [trades, mint]
  );

  const sorted = oldest ? [...tokenTrades] : [...tokenTrades].reverse();
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const slice = sorted.slice((page - 1) * perPage, page * perPage);

  useEffect(() => setPage(1), [mint, oldest, perPage]);

  // Summary stats
  const buys  = tokenTrades.filter(t => t.type === "buy");
  const sells = tokenTrades.filter(t => t.type === "sell");
  const totalBought = buys.reduce((a, t) => a + (t.sol || 0), 0);
  const totalSold   = sells.reduce((a, t) => a + (t.sol || 0), 0);
  const totalTokensBought = buys.reduce((a, t) => a + (t.amount || 0), 0);
  const totalTokensSold   = sells.reduce((a, t) => a + (t.amount || 0), 0);
  const totalFees = tokenTrades.reduce((a, t) => a + (t.fee || 0), 0);
  const netPnl = totalSold - totalBought;
  const pctReturn = totalBought > 0 ? ((netPnl / totalBought) * 100) : 0;

  // Single position: all buys vs all sells for this token
  const miniCurve = useMemo(() => {
    let solIn = 0, solOut = 0, fees = 0;
    const lastTs = tokenTrades[tokenTrades.length - 1]?.ts;
    for (const t of tokenTrades) {
      fees += t.fee || 0;
      if (t.type === "buy")  solIn  += t.sol;
      else if (t.type === "sell") solOut += t.sol;
    }
    const net = +(solOut - solIn).toFixed(4);
    return [
      { label: "START", idx: 0, cumPnl: 0, tradePnl: 0, fee: 0 },
      { label: token, idx: 1, cumPnl: net, tradePnl: net, fee: +fees.toFixed(5),
        solIn: +solIn.toFixed(4), solOut: +solOut.toFixed(4),
        time: lastTs?.slice(5,16).replace("T"," "), token, mint },
    ];
  }, [tokenTrades, token, mint]);

  const pnlColor = (n) => n > 0 ? S.accentGreen : n < 0 ? S.accentRed : S.textMid;
  const mono = { fontFamily: "'DM Mono',monospace" };

  const btn = (active, onClick, children, extra = {}) => (
    <button onClick={onClick} style={{
      background: "none", border: `1px solid ${active ? S.accentGreen : S.borderColor}`,
      color: active ? S.accentGreen : S.textDim, cursor: "pointer", padding: "4px 9px",
      fontSize: 9, ...mono, letterSpacing: ".05em", ...extra
    }}>{children}</button>
  );

  return (
    <div className="fade-up">
      {/* Back + title */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button onClick={onBack} style={{
          background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim,
          cursor: "pointer", padding: "5px 12px", fontSize: 10, ...mono, letterSpacing: ".06em",
          transition: "color .15s, border-color .15s",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.color = S.accentGreen; e.currentTarget.style.borderColor = S.accentGreen; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = S.textDim; e.currentTarget.style.borderColor = S.borderColor; }}>
          ← BACK
        </button>
        <div>
          <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, color: "#fff", letterSpacing: ".12em" }}>
            {token}
          </div>
          <div style={{ fontSize: 9, color: S.textDim, letterSpacing: ".04em", marginTop: 2, ...mono }}>
            {mint ? `${mint.slice(0, 20)}…${mint.slice(-8)}` : "—"}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {TERMINALS.map(t => (
            <a key={t.id} href={t.url.replace("{mint}", mint)} target="_blank" rel="noopener noreferrer"
              style={{
                background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim,
                padding: "4px 10px", fontSize: 9, textDecoration: "none", ...mono, letterSpacing: ".04em",
                transition: "color .15s, border-color .15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = S.accentGreen; e.currentTarget.style.borderColor = S.accentGreen; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = S.textDim; e.currentTarget.style.borderColor = S.borderColor; }}>
              {t.name} ↗
            </a>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 10 }}>
        {[
          { label: "NET PnL", val: fmtC(netPnl, S), color: pnlColor(netPnl), sub: pctReturn !== 0 ? `${sign(pctReturn)}${Math.abs(pctReturn).toFixed(1)}% return` : null },
          { label: "TOTAL BOUGHT", val: fmtC(totalBought, S), color: S.accentRed + "cc", sub: `${buys.length} buys` },
          { label: "TOTAL SOLD", val: fmtC(totalSold, S), color: S.accentGreen + "cc", sub: `${sells.length} sells` },
          { label: "FEES", val: fmtC(-totalFees, S, 5), color: S.accentFee, sub: `${tokenTrades.length} txs total` },
          { label: "POSITIONS", val: closedPositions.length, color: S.textPrimary, sub: `${buys.length}B · ${sells.length}S` },
        ].map((s) => (
          <BorderCard key={s.label} S={S} style={{ padding: "14px 16px" }}>
            <div style={{ color: S.textDim, fontSize: 9, letterSpacing: ".14em", marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 17, color: s.color, textShadow: `0 0 12px ${s.color}44` }}>{s.val}</div>
            {s.sub && <div style={{ color: S.textDim, fontSize: 9, marginTop: 4, letterSpacing: ".08em" }}>{s.sub}</div>}
          </BorderCard>
        ))}
      </div>

      {/* Mini PnL curve for this token */}
      {miniCurve.length > 1 && (
        <BorderCard S={S} style={{ padding: "16px 16px 10px", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "#fff", letterSpacing: ".1em", marginBottom: 2 }}>
            {token} PnL CURVE
          </div>
          <div style={{ fontSize: 9, color: S.textDim, letterSpacing: ".1em", marginBottom: 12 }}>
            {closedPositions.length} CLOSED POSITIONS
          </div>
          <PnlGraph data={miniCurve} color={pnlColor(netPnl)} S={S} height={160} />
        </BorderCard>
      )}

      {/* Token amount summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <BorderCard S={S} style={{ padding: "14px 16px" }}>
          <div style={{ color: S.textDim, fontSize: 9, letterSpacing: ".14em", marginBottom: 8 }}>TOKENS BOUGHT</div>
          <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 15, color: S.textMid }}>
            {totalTokensBought > 1e6 ? (totalTokensBought / 1e6).toFixed(2) + "M" : totalTokensBought > 1e3 ? (totalTokensBought / 1e3).toFixed(2) + "K" : fmt(totalTokensBought, 2)}
          </div>
          {buys.length > 0 && <div style={{ color: S.textDim, fontSize: 9, marginTop: 4, ...mono }}>avg {fmtC(totalBought / buys.length, S, 4)} / buy</div>}
        </BorderCard>
        <BorderCard S={S} style={{ padding: "14px 16px" }}>
          <div style={{ color: S.textDim, fontSize: 9, letterSpacing: ".14em", marginBottom: 8 }}>TOKENS SOLD</div>
          <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 15, color: S.textMid }}>
            {totalTokensSold > 1e6 ? (totalTokensSold / 1e6).toFixed(2) + "M" : totalTokensSold > 1e3 ? (totalTokensSold / 1e3).toFixed(2) + "K" : fmt(totalTokensSold, 2)}
          </div>
          {sells.length > 0 && <div style={{ color: S.textDim, fontSize: 9, marginTop: 4, ...mono }}>avg {fmtC(totalSold / sells.length, S, 4)} / sell</div>}
        </BorderCard>
      </div>

      {/* Trade table */}
      <BorderCard S={S} style={{ overflow: "auto" }}>
        <div style={{ padding: "12px 18px 10px", borderBottom: `1px solid ${S.borderColor}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "#fff", letterSpacing: ".12em" }}>
            {token} TRADES
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex" }}>
              {btn(!oldest, () => setOldest(false), "LATEST")}
              {btn(oldest,  () => setOldest(true),  "OLDEST")}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span className="ts-dim" style={{ ...mono, fontSize: 9, color: S.textDim }}>per page:</span>
              {PER_PAGE_OPTIONS.map(n => btn(perPage === n, () => setPerPage(n), n))}
            </div>
            <span className="ts-dim" style={{ color: S.textDim, fontSize: 9, ...mono }}>{sorted.length} TXS</span>
          </div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: S.textDim, fontSize: 9, letterSpacing: ".1em", borderBottom: `1px solid ${S.borderColor}` }}>
              {["WALLET", "TIME", "TYPE", "SOL", "AMOUNT", "SIG"].map((h) => (
                <th key={h} style={{ padding: "9px 14px", textAlign: ["SOL", "AMOUNT"].includes(h) ? "right" : "left", fontWeight: 400 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((t) => {
              const wInfo = tradeWalletMap[t.id];
              return (
                <tr key={t.id} className="tr" style={{ "--border": S.borderColor }}>
                  <td style={{ padding: "9px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div className="dot" style={{ background: getColor(wInfo ?? { colorIdx: 0 }), boxShadow: `0 0 4px ${getColor(wInfo ?? { colorIdx: 0 })}88` }} />
                      <span style={{ color: S.textDim, fontSize: 10 }}>{wInfo?.label}</span>
                    </div>
                  </td>
                  <td style={{ padding: "9px 14px", color: S.textDim, fontSize: 10 }}>{t.ts?.slice(0, 16).replace("T", " ")}</td>
                  <td style={{ padding: "9px 14px" }}><span className={`pill pill-${t.type}`} style={{ "--buy": S.accentGreen, "--sell": S.accentRed }}>{t.type.toUpperCase()}</span></td>
                  <td style={{ padding: "9px 14px", textAlign: "right", color: t.type === "buy" ? S.accentRed + "99" : S.accentGreen + "99" }}>{fmt(t.sol)}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right", color: S.textMid, fontSize: 10, ...mono }}>
                    {(t.amount || 0) > 1e6 ? ((t.amount || 0) / 1e6).toFixed(2) + "M" : (t.amount || 0) > 1e3 ? ((t.amount || 0) / 1e3).toFixed(2) + "K" : fmt(t.amount || 0, 2)}
                  </td>
                  <td style={{ padding: "9px 14px" }}>
                    {t.sig && (
                      <a href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noopener noreferrer"
                        style={{ color: S.textDim, fontSize: 10, textDecoration: "none", letterSpacing: ".04em" }}
                        onMouseEnter={(e) => e.target.style.color = S.accentGreen}
                        onMouseLeave={(e) => e.target.style.color = S.textDim}>
                        {t.sig.slice(0, 8)}…↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div style={{ padding: "10px 18px", borderTop: `1px solid ${S.borderColor}`,
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ ...mono, fontSize: 9, color: S.textDim }}>
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, sorted.length)} of {sorted.length}
            </span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {btn(false, () => setPage(1), "«", { opacity: page > 1 ? 1 : 0.3 })}
              {btn(false, () => setPage(p => Math.max(1, p - 1)), "‹", { opacity: page > 1 ? 1 : 0.3 })}
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => Math.abs(p - page) <= 2 || p === 1 || p === totalPages)
                .reduce((acc, p, i, arr) => {
                  if (i > 0 && p - arr[i - 1] > 1) acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) => typeof p === "string"
                  ? <span key={`ell${i}`} style={{ ...mono, fontSize: 9, color: S.textDim, padding: "0 4px" }}>…</span>
                  : btn(p === page, () => setPage(p), p)
                )}
              {btn(false, () => setPage(p => Math.min(totalPages, p + 1)), "›", { opacity: page < totalPages ? 1 : 0.3 })}
              {btn(false, () => setPage(totalPages), "»", { opacity: page < totalPages ? 1 : 0.3 })}
            </div>
          </div>
        )}
      </BorderCard>
    </div>
  );
}

// ── SHARE CARD ────────────────────────────────────────────────────────────────
// PNL_RANKS kept as fallback only — real ranks come from S.pnlRanks
const PNL_RANKS = DEFAULT_SETTINGS.pnlRanks;

function getPnlRank(pnl, ranks) {
  const list = (ranks && ranks.length) ? ranks : PNL_RANKS;
  // Sort descending by min so first match wins
  const sorted = [...list].sort((a, b) => (b.min === -Infinity ? -1 : a.min === -Infinity ? 1 : b.min - a.min));
  return sorted.find(r => pnl >= r.min) ?? sorted[sorted.length - 1];
}

// ── RANK SHAPE PATHS ─────────────────────────────────────────────────────────
// All shapes centered at 0,0; scaled by s
const RANK_SHAPE_FNS = {
  // ── Top-tier shapes (complex, distinctive) ──────────────────────────────
  // TRIDENT: three-pronged weapon — power / mastery
  TRIDENT: s => { const r=s*.52,w=r*.13; return `M 0 ${-r} L ${w} ${-r*.48} L ${r*.4} ${-r*.48} L ${r*.55} ${-r*.84} L ${r*.7} ${-r*.84} L ${r*.65} ${-r*.38} L ${r*.5} ${-r*.27} L ${w} ${-r*.21} L ${w} ${r} L ${-w} ${r} L ${-w} ${-r*.21} L ${-r*.5} ${-r*.27} L ${-r*.65} ${-r*.38} L ${-r*.7} ${-r*.84} L ${-r*.55} ${-r*.84} L ${-r*.4} ${-r*.48} L ${-w} ${-r*.48} Z`; },
  // SIGIL: two overlapping triangles (hexagram / star of David) — mystical (fillRule evenodd for hole)
  SIGIL: s => { const r=s*.55; const t1=Array.from({length:3},(_,k)=>{const a=k*2*Math.PI/3-Math.PI/2;return`${(Math.cos(a)*r).toFixed(2)},${(Math.sin(a)*r).toFixed(2)}`}); const t2=Array.from({length:3},(_,k)=>{const a=k*2*Math.PI/3+Math.PI/2;return`${(Math.cos(a)*r).toFixed(2)},${(Math.sin(a)*r).toFixed(2)}`}); return `M ${t1.join(' L ')} Z M ${t2.join(' L ')} Z`; },
  // NOVA: 12-spike starburst — explosive energy
  NOVA: s => { const p=[]; for(let k=0;k<12;k++){const a=k*Math.PI/6-Math.PI/2,r=k%2===0?s*.55:s*.23;p.push(`${(Math.cos(a)*r).toFixed(2)},${(Math.sin(a)*r).toFixed(2)}`);} return`M ${p.join(' L ')} Z`; },
  // CROWN: king's 3-spike crown — authority
  CROWN: s => { const r=s*.5; return `M ${-r} ${r*.38} L ${-r} ${-r*.08} L ${-r*.65} ${-r*.72} L ${-r*.25} ${-r*.1} L 0 ${-r} L ${r*.25} ${-r*.1} L ${r*.65} ${-r*.72} L ${r} ${-r*.08} L ${r} ${r*.38} Z`; },
  // VOID: ring with hole — compound path, requires evenodd fill
  VOID: s => { const ro=s*.52,ri=s*.23; const outer=Array.from({length:16},(_,k)=>{const a=k*Math.PI/8-Math.PI/2;return`${(Math.cos(a)*ro).toFixed(2)},${(Math.sin(a)*ro).toFixed(2)}`}); const inner=Array.from({length:16},(_,k)=>{const a=(15-k)*Math.PI/8-Math.PI/2;return`${(Math.cos(a)*ri).toFixed(2)},${(Math.sin(a)*ri).toFixed(2)}`}); return `M ${outer.join(' L ')} Z M ${inner.join(' L ')} Z`; },
  // COMET: teardrop / comet — speed and trajectory
  COMET: s => `M 0 ${-s*.52} C ${s*.58} ${-s*.38} ${s*.62} ${s*.18} 0 ${s*.44} C ${-s*.62} ${s*.18} ${-s*.58} ${-s*.38} 0 ${-s*.52} Z`,
  // PRISM: faceted cut gem — refraction / value
  PRISM: s => { const r=s*.52; const pts=[[-r*.4,-r*.55],[r*.4,-r*.55],[r*.62,-r*.22],[r*.56,r*.12],[r*.3,r*.55],[-r*.3,r*.55],[-r*.56,r*.12],[-r*.62,-r*.22]]; return`M ${pts.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} Z`; },
  // SKULL: dome + jaw with 3 teeth — death / rekt
  SKULL: s => { const r=s*.52; const pts=[[0,-r],[r*.5,-r*.86],[r*.82,-r*.56],[r*.95,-r*.15],[r*.82,r*.18],[r*.65,r*.28],[r*.65,r*.52],[r*.42,r*.28],[r*.22,r*.52],[0,r*.28],[-r*.22,r*.52],[-r*.42,r*.28],[-r*.65,r*.52],[-r*.65,r*.28],[-r*.82,r*.18],[-r*.95,-r*.15],[-r*.82,-r*.56],[-r*.5,-r*.86]]; return`M ${pts.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} Z`; },
  // ── Existing shapes (keep for backwards compat + admin selector) ────────
  IMPERIAL:  s => { const o=s*.18,i=s*.55; return`M 0 ${-i} L ${o} ${-o} L ${i} 0 L ${o} ${o} L 0 ${i} L ${-o} ${o} L ${-i} 0 L ${-o} ${-o} Z`; },
  PHANTASM:  s => { const p=[]; for(let k=0;k<8;k++){const a=k*Math.PI/4,r=k%2===0?s*.55:s*.22;p.push(`${(Math.cos(a-Math.PI/2)*r).toFixed(2)},${(Math.sin(a-Math.PI/2)*r).toFixed(2)}`)}return`M ${p.join(" L ")} Z`; },
  ORACLE:    s => `M 0 ${-s*.55} C ${s*.75} ${-s*.55} ${s*.75} ${s*.55} 0 ${s*.55} C ${-s*.75} ${s*.55} ${-s*.75} ${-s*.55} 0 ${-s*.55} Z`,
  SENTIENT:  s => { const p=[]; for(let k=0;k<3;k++){const a0=k*2*Math.PI/3-Math.PI/2,a1=a0+Math.PI/3;p.push(`${(Math.cos(a0)*s*.55).toFixed(2)},${(Math.sin(a0)*s*.55).toFixed(2)}`);p.push(`${(Math.cos(a1)*s*.2).toFixed(2)},${(Math.sin(a1)*s*.2).toFixed(2)}`)}return`M ${p.join(" L ")} Z`; },
  IMMORTAL:  s => { const t=s*.22,e=s*.55; return`M ${-t} ${-e} L ${t} ${-e} L ${t} ${-t} L ${e} ${-t} L ${e} ${t} L ${t} ${t} L ${t} ${e} L ${-t} ${e} L ${-t} ${t} L ${-e} ${t} L ${-e} ${-t} L ${-t} ${-t} Z`; },
  HYPERION:  s => { const p=[]; for(let k=0;k<6;k++){const a0=k*Math.PI/3-Math.PI/2,a1=a0+Math.PI/6;p.push(`${(Math.cos(a0)*s*.55).toFixed(2)},${(Math.sin(a0)*s*.55).toFixed(2)}`);p.push(`${(Math.cos(a1)*s*.2).toFixed(2)},${(Math.sin(a1)*s*.2).toFixed(2)}`)}return`M ${p.join(" L ")} Z`; },
  SUPREME:   s => `M ${-s*.5} ${s*.32} L ${-s*.5} ${-s*.08} L ${-s*.25} ${s*.22} L 0 ${-s*.52} L ${s*.25} ${s*.22} L ${s*.5} ${-s*.08} L ${s*.5} ${s*.32} Z`,
  ASCENDANT: s => [`M ${-s*.5} ${-s*.12} L 0 ${-s*.42} L ${s*.5} ${-s*.12}`,`M ${-s*.5} ${s*.08} L 0 ${-s*.22} L ${s*.5} ${s*.08}`,`M ${-s*.5} ${s*.28} L 0 ${-s*.02} L ${s*.5} ${s*.28}`].join(" "),
  DIAMOND:   s => { const p=Array.from({length:6},(_,k)=>{const a=k*Math.PI/3-Math.PI/6;return`${(Math.cos(a)*s*.55).toFixed(2)},${(Math.sin(a)*s*.55).toFixed(2)}`});return`M ${p.join(" L ")} Z`; },
  PLATINUM:  s => { const t=s*.1,r=s*.52; return`M ${-t} ${-r} L ${t} ${-r} L ${t} ${-t} L ${r} ${-t} L ${r} ${t} L ${t} ${t} L ${t} ${r} L ${-t} ${r} L ${-t} ${t} L ${-r} ${t} L ${-r} ${-t} L ${-t} ${-t} Z`; },
  GOLD:      s => `M 0 ${-s*.55} L ${s*.55} 0 L 0 ${s*.55} L ${-s*.55} 0 Z`,
  SILVER:    s => `M 0 ${-s*.5} L ${s*.5} 0 L 0 ${s*.5} L ${-s*.5} 0 Z`,
  BRONZE:    s => `M 0 ${-s*.55} L ${s*.5} ${s*.42} L ${-s*.5} ${s*.42} Z`,
  IRON:      s => `M ${-s*.5} ${-s*.1} L ${s*.5} ${-s*.1} L ${s*.5} ${s*.1} L ${-s*.5} ${s*.1} Z`,
  REKT:      s => { const t=s*.2,e=s*.55; return`M ${-e} ${-t} L ${-t} ${-e} L 0 ${-e+t} L ${t} ${-e} L ${e} ${-t} L ${e-t} 0 L ${e} ${t} L ${t} ${e} L 0 ${e-t} L ${-t} ${e} L ${-e} ${t} L ${-e+t} 0 Z`; },
  // ── New distinctive shapes ──────────────────────────────────────────────────
  // CROSS: plus / medical cross — clean, symmetric
  CROSS:     s => { const t=s*.18,e=s*.52; return`M ${-t} ${-e} L ${t} ${-e} L ${t} ${-t} L ${e} ${-t} L ${e} ${t} L ${t} ${t} L ${t} ${e} L ${-t} ${e} L ${-t} ${t} L ${-e} ${t} L ${-e} ${-t} L ${-t} ${-t} Z`; },
  // ARROW: upward pointing arrow — bullish / direction
  ARROW:     s => { const r=s*.52; return`M 0 ${-r} L ${r*.6} ${-r*.1} L ${r*.28} ${-r*.1} L ${r*.28} ${r} L ${-r*.28} ${r} L ${-r*.28} ${-r*.1} L ${-r*.6} ${-r*.1} Z`; },
  // LIGHTNING: single bolt — speed / power
  LIGHTNING: s => { const r=s*.52; return`M ${r*.15} ${-r} L ${-r*.5} ${r*.08} L ${-r*.05} ${r*.08} L ${-r*.25} ${r} L ${r*.5} ${-r*.12} L ${r*.05} ${-r*.12} Z`; },
  // SHIELD: classic shield shape — protection / rank
  SHIELD:    s => { const r=s*.52; return`M ${-r} ${-r*.55} L 0 ${-r} L ${r} ${-r*.55} L ${r} ${r*.18} C ${r} ${r*.7} 0 ${r} 0 ${r} C 0 ${r} ${-r} ${r*.7} ${-r} ${r*.18} Z`; },
  // WINGS: spread wings — freedom / ascension
  WINGS:     s => { const r=s*.52; return`M 0 ${-r*.15} L ${r*.35} ${-r*.55} L ${r} ${-r*.45} L ${r*.6} ${r*.1} L ${r*.25} ${r*.55} L 0 ${r*.2} L ${-r*.25} ${r*.55} L ${-r*.6} ${r*.1} L ${-r} ${-r*.45} L ${-r*.35} ${-r*.55} Z`; },
  // EYE: elongated eye / lens shape — perception
  EYE:       s => `M ${-s*.55} 0 C ${-s*.55} ${-s*.38} ${s*.55} ${-s*.38} ${s*.55} 0 C ${s*.55} ${s*.38} ${-s*.55} ${s*.38} ${-s*.55} 0 Z`,
  // HOURGLASS: two triangles tip-to-tip — time
  HOURGLASS: s => { const r=s*.52; return`M ${-r} ${-r} L ${r} ${-r} L 0 0 L ${r} ${r} L ${-r} ${r} L 0 0 Z`; },
  // STAR5: classic 5-point star — achievement
  STAR5:     s => { const p=[]; for(let k=0;k<10;k++){const a=k*Math.PI/5-Math.PI/2,r=k%2===0?s*.55:s*.22;p.push(`${(Math.cos(a)*r).toFixed(2)},${(Math.sin(a)*r).toFixed(2)}`);} return`M ${p.join(' L ')} Z`; },
  // MOON: crescent moon — mysterious
  MOON:      s => `M ${s*.1} ${-s*.52} A ${s*.52} ${s*.52} 0 1 1 ${s*.1} ${s*.52} A ${s*.3} ${s*.3} 0 1 0 ${s*.1} ${-s*.52} Z`,
  // KITE: elongated diamond/kite — direction
  KITE:      s => `M 0 ${-s*.65} L ${s*.38} ${-s*.08} L 0 ${s*.42} L ${-s*.38} ${-s*.08} Z`,
  // HEXAGON: regular hexagon — structure
  HEXAGON:   s => { const p=Array.from({length:6},(_,k)=>{const a=k*Math.PI/3;return`${(Math.cos(a)*s*.52).toFixed(2)},${(Math.sin(a)*s*.52).toFixed(2)}`});return`M ${p.join(' L ')} Z`; },
  // PENTAGON: 5-sided — balance
  PENTAGON:  s => { const p=Array.from({length:5},(_,k)=>{const a=k*2*Math.PI/5-Math.PI/2;return`${(Math.cos(a)*s*.54).toFixed(2)},${(Math.sin(a)*s*.54).toFixed(2)}`});return`M ${p.join(' L ')} Z`; },
  // RECYCLE: triple arrow ring (simplified) — recycled gains
  INFINITY:  s => `M ${-s*.18} 0 C ${-s*.18} ${-s*.38} ${-s*.58} ${-s*.38} ${-s*.58} 0 C ${-s*.58} ${s*.38} ${-s*.18} ${s*.38} ${-s*.18} 0 M ${s*.18} 0 C ${s*.18} ${-s*.38} ${s*.58} ${-s*.38} ${s*.58} 0 C ${s*.58} ${s*.38} ${s*.18} ${s*.38} ${s*.18} 0 Z`,
  // BURST: 6-point angular star — explosion
  BURST:     s => { const p=[]; for(let k=0;k<12;k++){const a=k*Math.PI/6-Math.PI/2,r=k%2===0?s*.55:s*.3;p.push(`${(Math.cos(a)*r).toFixed(2)},${(Math.sin(a)*r).toFixed(2)}`);} return`M ${p.join(' L ')} Z`; },
  // CHALICE: trophy cup — winner
  CHALICE:   s => { const r=s*.52; return`M ${-r*.62} ${-r} L ${r*.62} ${-r} L ${r*.38} ${-r*.18} C ${r*.7} ${r*.1} ${r*.7} ${r*.45} ${r*.22} ${r*.5} L ${r*.18} ${r} L ${-r*.18} ${r} L ${-r*.22} ${r*.5} C ${-r*.7} ${r*.45} ${-r*.7} ${r*.1} ${-r*.38} ${-r*.18} Z`; },
};
const RANK_SHAPE_NAMES = Object.keys(RANK_SHAPE_FNS);

// Tiny inline SVG curve for share card

// The actual share card — diagonal design
function ShareCardInner({ S, pnlCurve, closed, totalPnl, winRate, tf, walletLabel, _overrideRank, cardPnlCompact = false }) {
  const ranks = S.pnlRanks ?? PNL_RANKS;
  const rank  = _overrideRank ?? getPnlRank(totalPnl, ranks);

  // Merge rank's own card settings with defaults — every visual property lives here
  // cardNotchStyle from global settings overrides per-rank default
  // cardNotchStyle is a global user preference — must override rank.card which may have its own notchStyle
  // Merge priority: DEFAULT_CARD < S.defaultCard (global admin) < rank.card (per-rank)
  const c = { ...DEFAULT_CARD, ...(S?.defaultCard ?? {}), ...(rank.card ?? {}), notchStyle: S.cardNotchStyle ?? "semicircle" };

  const totalSolIn  = closed.reduce((s, x) => s + (x.solIn  || 0), 0);
  const totalSolOut = closed.reduce((s, x) => s + (x.solOut || 0), 0);
  const pct   = totalSolIn > 0 ? (totalPnl / totalSolIn) * 100 : 0;
  const isPos = totalPnl >= 0;

  const accentColor = (c.useRankColor ?? true) ? rank.color : (c.customColor ?? "#ffffff");
  const pnlColor    = isPos ? accentColor : "#ff3355";

  // ── Card dimensions ──────────────────────────────────────────────
  const W = 340, R = 12, CUT = 20;
  const PAD = c.cardPad ?? 24;
  const STUB_PAD_TOP = 16, STUB_PAD_BOT = 14;
  const STUB_ROW_H   = c.showChart ? 90 : 80;
  const STUB_TOTAL   = STUB_PAD_TOP + STUB_ROW_H + STUB_PAD_BOT;
  const H   = 490;
  const DIV = H - CUT - STUB_TOTAL;
  const ROW_Y = DIV + CUT + STUB_PAD_TOP;

  // ── Ticket shape path ────────────────────────────────────────────
  const notchStyle = c.notchStyle ?? "semicircle";
  // Triangle notch: pointed inward with rounded corners where diagonal meets card edge
  const buildTrianglePath = () => {
    const NW = CUT, NH = CUT; // notch width (inset) and half-height
    const len = Math.sqrt(NW*NW + NH*NH);
    const dx = NW/len, dy = NH/len;
    const rc = 6; // corner rounding radius
    return [
      `M ${R} 0 L ${W-R} 0 Q ${W} 0 ${W} ${R}`,
      `L ${W} ${DIV-NH-rc}`,
      `Q ${W} ${DIV-NH} ${W-rc*dx} ${DIV-NH+rc*dy}`,
      `L ${W-NW} ${DIV}`,
      `L ${W-rc*dx} ${DIV+NH-rc*dy}`,
      `Q ${W} ${DIV+NH} ${W} ${DIV+NH+rc}`,
      `L ${W} ${H-R} Q ${W} ${H} ${W-R} ${H}`,
      `L ${R} ${H} Q 0 ${H} 0 ${H-R}`,
      `L 0 ${DIV+NH+rc}`,
      `Q 0 ${DIV+NH} ${rc*dx} ${DIV+NH-rc*dy}`,
      `L ${NW} ${DIV}`,
      `L ${rc*dx} ${DIV-NH+rc*dy}`,
      `Q 0 ${DIV-NH} 0 ${DIV-NH-rc}`,
      `L 0 ${R} Q 0 0 ${R} 0 Z`,
    ].join(' ');
  };
  const path = notchStyle === "triangle" ? buildTrianglePath() : [
    `M ${R} 0 L ${W-R} 0 Q ${W} 0 ${W} ${R}`,
    `L ${W} ${DIV-CUT} A ${CUT} ${CUT} 0 0 0 ${W} ${DIV+CUT}`,
    `L ${W} ${H-R} Q ${W} ${H} ${W-R} ${H}`,
    `L ${R} ${H} Q 0 ${H} 0 ${H-R}`,
    `L 0 ${DIV+CUT} A ${CUT} ${CUT} 0 0 0 0 ${DIV-CUT}`,
    `L 0 ${R} Q 0 0 ${R} 0 Z`,
  ].join(' ');

  // ── Shape & ghost positions ──────────────────────────────────────
  const SHAPE_SIZE = c.shapeSize ?? 40;
  const GHOST_SIZE = c.ghostSize ?? 110;
  // SX/SY = top-left of shape bounding box
  const SX = c.shapeX != null ? c.shapeX : W - PAD - SHAPE_SIZE - 2;
  const SY = c.shapeY ?? 52;
  // Shape center
  const SCX = SX + SHAPE_SIZE / 2;
  const SCY = SY + SHAPE_SIZE / 2;
  // Ghost top-left: auto = centered on shape center; manual = explicit top-left
  const GX = c.ghostX != null ? c.ghostX : SCX - GHOST_SIZE / 2;
  const GY = c.ghostY != null ? c.ghostY : SCY - GHOST_SIZE / 2;

  const shapeName = rank.shape ?? rank.name;
  const _baseFn   = RANK_SHAPE_FNS[shapeName] ?? RANK_SHAPE_FNS.IMPERIAL;
  const shapeFn   = rank.svgPath ? () => rank.svgPath : _baseFn;
  const isCustomSvg = !!rank.svgPath;

  // unique ids to avoid conflicts when multiple cards render simultaneously
  const uid    = rank.name.replace(/\W/g,'');
  const clipId = `sc-clip-${uid}`;
  const bgId   = `sc-bg-${uid}`;

  // ── Gradient: angle → SVG x1/y1/x2/y2 ──────────────────────────
  const angleDeg = c.gradientAngle ?? 135;
  const rad = (angleDeg * Math.PI) / 180;
  const gx1 = +(0.5 - 0.5 * Math.sin(rad)).toFixed(4);
  const gy1 = +(0.5 + 0.5 * Math.cos(rad)).toFixed(4);
  const gx2 = +(0.5 + 0.5 * Math.sin(rad)).toFixed(4);
  const gy2 = +(0.5 - 0.5 * Math.cos(rad)).toFixed(4);

  // ── Diagonal slab ────────────────────────────────────────────────
  const slabPts = `0,0 ${W*0.68},0 ${W*0.32},${DIV} 0,${DIV}`;

  // ── Rank name font size (auto-shrink for long names) ─────────────
  const baseFontSize = c.rankFontSize ?? 30;
  const rankFontSize = rank.name.length > 7 ? Math.round(baseFontSize * 0.8)
                     : rank.name.length > 6 ? Math.round(baseFontSize * 0.9)
                     : baseFontSize;

  // ── PnL display string + font size (currency-aware, compact-aware) ────
  const maxPnlFont = 82;
  const _displayCur = S?.currency ?? "SOL";
  const _displayRaw = solToDisplay(totalPnl, _displayCur) ?? totalPnl;
  const _useCompact = cardPnlCompact && Math.abs(_displayRaw) >= 1000;
  const displayStr = (() => {
    const sign = totalPnl < 0 ? "-" : "+";
    if (_useCompact) {
      const k = (Math.abs(_displayRaw) / 1000).toFixed(1);
      const sym = _displayCur !== "SOL" ? (CURRENCY_SYMBOLS[_displayCur] ?? _displayCur + " ") : "";
      return sign + sym + k + "k";
    }
    return fmtC(totalPnl, S, 2);
  })();
  // Font size: binary search for largest size where string fits within PAD→(W-PAD)
  // Orbitron measured character widths (fraction of font-size):
  //   digits 0-9: ~0.60, uppercase: ~0.65, +/-: ~0.50
  //   $ £ €: ~0.65, zł ₴ ₸: ~0.70 (wider multi-byte symbols)
  //   dot/comma: ~0.30, space: ~0.30, k: ~0.60
  const letterSpacing = c.pnlLetterSpacing ?? -2;
  const availW = (W - PAD * 2) * 0.97; // 3% safety margin against measurement error
  const charWeight = (ch) => {
    if (/[0-9]/.test(ch)) return 0.60;
    if (/[A-Z]/.test(ch)) return 0.65;
    if (/[a-z]/.test(ch)) return 0.55;
    if ('$£€'.includes(ch)) return 0.65;
    if ('zł₴₸₽'.includes(ch)) return 0.72;
    if ('+-'.includes(ch)) return 0.50;
    if ('.,'.includes(ch)) return 0.30;
    return 0.55; // fallback for unknown symbols
  };
  const totalCharW = (f) =>
    displayStr.split('').reduce((s, ch) => s + f * charWeight(ch), 0)
    + Math.max(0, letterSpacing) * (displayStr.length - 1);
  let lo = 16, hi = 82;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (totalCharW(mid) <= availW) lo = mid; else hi = mid;
  }
  const pnlFontSize = Math.round(lo);

  // ── Curve ────────────────────────────────────────────────────────
  const MID     = Math.round(W * 0.55);
  const CURVE_W = MID - PAD;
  let cv = null;
  if (c.showChart && pnlCurve && pnlCurve.length >= 2) {
    const vals = pnlCurve.map(d => d.cumPnl);
    const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
    const px = 4, py = 4, iw = CURVE_W - px*2, ih = STUB_ROW_H - py*2;
    const tx = i => px + (i / (vals.length - 1)) * iw;
    const ty = v => py + (1 - (v - mn) / rng) * ih;
    cv = {
      pts: vals.map((v, i) => `${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' '),
      zy: ty(0), hasZero: mn < 0 && mx > 0,
      lastX: tx(vals.length - 1), lastY: ty(vals[vals.length - 1]),
    };
  }

  return (
    <svg width={W} height={H} xmlns="http://www.w3.org/2000/svg" className="no-ts-scale" style={{ display: 'block' }}>
      <defs>
        <clipPath id={clipId}><path d={path}/></clipPath>
        <linearGradient id={bgId} x1={gx1} y1={gy1} x2={gx2} y2={gy2}>
          <stop offset={`${c.g1Stop ?? 0}%`}    stopColor={rank.g1} stopOpacity={c.g1Opacity ?? 0.68}/>
          <stop offset={`${c.midStop ?? 44}%`}   stopColor={c.midColor ?? '#0a0a0a'}/>
          <stop offset={`${c.endStop ?? 100}%`}  stopColor={c.endColor ?? '#040404'}/>
        </linearGradient>
      </defs>

      {/* Background */}
      <path d={path} fill={`url(#${bgId})`}/>

      {/* Diagonal slab */}
      <polygon points={slabPts} fill={accentColor} opacity={c.slabOpacity ?? 0.07} clipPath={`url(#${clipId})`}/>
      <line x1={W*0.68} y1={0} x2={W*0.32} y2={DIV}
        stroke={accentColor} strokeWidth={c.slabLineWidth ?? 0.9}
        opacity={c.slabLineOpacity ?? 0.28} clipPath={`url(#${clipId})`}/>

      {/* Ghost + real shape */}
      <g clipPath={`url(#${clipId})`}>
        {(c.showGhost ?? true) && (
          <g opacity="0.08">
            {isCustomSvg
              ? <svg x={GX} y={GY} width={GHOST_SIZE} height={GHOST_SIZE}
                  viewBox={rank.svgViewBox ?? '0 0 100 100'}
                  preserveAspectRatio="xMidYMid meet" style={{ overflow:'visible' }}>
                  <g fill={accentColor} dangerouslySetInnerHTML={{ __html: rank.svgPath }}/>
                </svg>
              : <path d={shapeFn(GHOST_SIZE)}
                  transform={`translate(${GX + GHOST_SIZE/2},${GY + GHOST_SIZE/2})`}
                  fill={accentColor} fillRule="evenodd"/>}
          </g>
        )}
        <g style={{ filter:`drop-shadow(0 0 12px ${accentColor}cc)` }}>
          {isCustomSvg
            ? <svg x={SX} y={SY} width={SHAPE_SIZE} height={SHAPE_SIZE}
                viewBox={rank.svgViewBox ?? '0 0 100 100'}
                preserveAspectRatio="xMidYMid meet" style={{ overflow:'visible' }}>
                <g fill={accentColor} dangerouslySetInnerHTML={{ __html: rank.svgPath }}/>
              </svg>
            : <path d={shapeFn(SHAPE_SIZE)}
                transform={`translate(${SX + SHAPE_SIZE/2},${SY + SHAPE_SIZE/2})`}
                fill={accentColor} opacity="0.93" fillRule="evenodd"/>}
        </g>
      </g>

      {/* Border */}
      <path d={path} fill="none" stroke={accentColor}
        strokeWidth={c.borderWidth ?? 1.1} opacity={c.borderOpacity ?? 0.48}/>

      {/* Rank name */}
      <text x={PAD} y={c.rankNameY ?? 54} fontFamily="'Orbitron',monospace" fontWeight="900"
        fontSize={rankFontSize} fill={accentColor} letterSpacing="2"
        style={{ filter:`drop-shadow(0 0 10px ${accentColor}88)` }}>{rank.name}</text>
      <line x1={PAD} y1={c.dividerLineY ?? 65} x2="178" y2="65" stroke={accentColor} strokeWidth="0.5" opacity="0.22"/>
      <text x={PAD} y={c.walletLabelY ?? 80} fontFamily="'Orbitron',monospace"
        fontSize={c.walletLabelFontSize ?? 8}
        fill={c.minorTextColor ?? "rgba(255,255,255,0.22)"} letterSpacing="1">{walletLabel} · {tf}</text>

      {/* PnL */}
      <text x={PAD} y={c.pnlY ?? 192} fontFamily="'Orbitron',monospace" fontWeight="900"
        fontSize={pnlFontSize} fill={pnlColor} letterSpacing={c.pnlLetterSpacing ?? -2}
        style={{ filter:`drop-shadow(0 0 18px ${pnlColor}66)` }}>
        {_displayCur === "SOL" ? displayStr.replace(" SOL", "") : displayStr}
      </text>
      <text x={PAD} y={c.currencyLabelY ?? 212} fontFamily="'Orbitron',monospace"
        fontSize={c.solFontSize ?? 9}
        fill={c.minorTextColor ?? "rgba(255,255,255,0.18)"} letterSpacing="5">
        {(_displayCur && _displayCur !== "SOL") ? _displayCur : "SOL"}
      </text>

      {/* % return */}
      <text x={PAD} y={c.pctReturnY ?? 244} fontFamily="'Orbitron',monospace" fontWeight="700"
        fontSize={c.pctReturnSize ?? 20} fill={pnlColor} opacity="0.72">
        {pct >= 0 ? '+' : ''}{fmt(Math.abs(pct), 1)}%
      </text>

      {/* Ticket divider */}
      <line x1={CUT+2} y1={DIV} x2={W-CUT-2} y2={DIV}
        stroke={accentColor}
        strokeWidth={c.dividerWidth ?? 1}
        strokeDasharray={c.dividerDash ?? '4,4'}
        opacity={c.dividerOpacity ?? 0.6}/>

      {/* ── STUB ── */}
      {c.showChart ? (
        <>
          {cv && (
            <svg x={PAD} y={ROW_Y} width={CURVE_W} height={STUB_ROW_H} overflow="visible">
              {cv.hasZero && (
                <line x1="2" y1={cv.zy} x2={CURVE_W-2} y2={cv.zy}
                  stroke="rgba(255,255,255,0.06)" strokeWidth="0.7" strokeDasharray="3,5"/>
              )}
              <polyline points={cv.pts} fill="none" stroke={pnlColor} strokeWidth="1.8"
                strokeLinejoin="round" strokeLinecap="round"/>
              <circle cx={cv.lastX} cy={cv.lastY} r="3" fill={pnlColor}
                style={{ filter:`drop-shadow(0 0 5px ${pnlColor})` }}/>
            </svg>
          )}
          {[
            { label:'BOUGHT', val:fmtC(totalSolIn, S, 1).replace(" SOL",""),  col:'rgba(255,255,255,0.42)', lCol:'rgba(255,255,255,0.2)'  },
            { label:'SOLD',   val:fmtC(totalSolOut, S, 1).replace(" SOL",""), col:accentColor,              lCol:accentColor              },
          ].map((row, i) => {
            const rowH = 42, gap = 6, totalH = rowH*2 + gap;
            const startY = ROW_Y + Math.round((STUB_ROW_H - totalH) / 2);
            const y = startY + i * (rowH + gap);
            return (
              <g key={row.label}>
                <text x={W-PAD} y={y+10} textAnchor="end" fontFamily="'Orbitron',monospace"
                  fontSize="7" fill={row.lCol} letterSpacing="2">{row.label}</text>
                <text x={W-PAD} y={y+30} textAnchor="end" fontFamily="'Orbitron',monospace"
                  fontWeight="700" fontSize="16" fill={row.col}>{row.val}</text>
                <text x={W-PAD} y={y+41} textAnchor="end" fontFamily="'Orbitron',monospace"
                  fontSize="6" fill={row.col} opacity="0.3">{(_displayCur && _displayCur !== "SOL") ? _displayCur : "SOL"}</text>
              </g>
            );
          })}
        </>
      ) : (
        <>
          {[
            { label:'BOUGHT', val:fmtC(totalSolIn, S, 2).replace(" SOL",""),  col:'rgba(255,255,255,0.42)', lCol:'rgba(255,255,255,0.22)', x: PAD   },
            { label:'SOLD',   val:fmtC(totalSolOut, S, 2).replace(" SOL",""), col:accentColor,              lCol:accentColor,              x: W/2+8 },
          ].map(row => (
            <g key={row.label}>
              <text x={row.x} y={ROW_Y+16} fontFamily="'Orbitron',monospace"
                fontSize="8" fill={row.lCol} letterSpacing="2">{row.label}</text>
              <text x={row.x} y={ROW_Y+44} fontFamily="'Orbitron',monospace"
                fontWeight="700" fontSize="22" fill={row.col}>{row.val}</text>
              <text x={row.x} y={ROW_Y+58} fontFamily="'Orbitron',monospace"
                fontSize="7" fill={row.col} opacity="0.3">SOL</text>
            </g>
          ))}
        </>
      )}

      {/* Watermark */}
      <text x={W/2} y={H-8} textAnchor="middle" fontFamily="'Orbitron',monospace"
        fontSize="6" fill="rgba(255,255,255,0.07)" letterSpacing="2">
        {S.appName ?? 'SOLTRACK'}
      </text>
    </svg>
  );
}
// ── V2 CARD: Solana logo helper & constants ───────────────────────────────────
// Logo unit space 215×139: bars h=35, w=180, gap=17, 45°→offset=35
// Bar1(/): TL(35,0) TR(215,0) BR(180,35) BL(0,35)
// Bar2(\): TL(0,52) TR(180,52) BR(215,87) BL(35,87)   ← mirrored
// Bar3(/): TL(35,104) TR(215,104) BR(180,139) BL(0,139)
function _v2Rq(pts, r=5) {
  const n = pts.length;
  const lp = (a,b,t) => [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])];
  const ds = (a,b) => Math.hypot(b[0]-a[0], b[1]-a[1]);
  const nd = pts.map((c,i) => {
    const p = pts[(i-1+n)%n], x = pts[(i+1)%n];
    const t1 = Math.min(r/ds(p,c), .45), t2 = Math.min(r/ds(c,x), .45);
    return { a: lp(c,p,t1), c, b: lp(c,x,t2) };
  });
  const f = v => v.toFixed(2);
  let d = `M${f(nd[0].b[0])},${f(nd[0].b[1])}`;
  for (let i=0; i<n; i++) {
    const j = (i+1)%n;
    d += ` L${f(nd[j].a[0])},${f(nd[j].a[1])} Q${f(nd[j].c[0])},${f(nd[j].c[1])} ${f(nd[j].b[0])},${f(nd[j].b[1])}`;
  }
  return d + 'Z';
}
const V2_LOGO_PATH = [
  _v2Rq([[35,0],[215,0],[180,35],[0,35]]),
  _v2Rq([[0,52],[180,52],[215,87],[35,87]]),
  _v2Rq([[35,104],[215,104],[180,139],[0,139]]),
].join(' ');
const V2_LW = 215, V2_LH = 139;
const v2LS   = fs => (0.72*fs)/V2_LH;
const v2LWpx = fs => V2_LW * v2LS(fs);

const V2_W=340, V2_H=490, V2_PAD=24, V2_BAND_H=50, V2_DIV_Y=370, V2_CUT=20, V2_CORNER=12;
const V2_S2=22, V2_S3=13, V2_MAX_FS=72, V2_GAP=10, V2_BLEN=16;
const V2_BL_X=V2_PAD, V2_BR_X=V2_W-V2_PAD;
const V2_BT_Y=V2_BAND_H+V2_PAD;   // 74
const V2_BB_Y=V2_DIV_Y-V2_PAD;    // 346
const V2_RC=6, V2_RCO=+(6/Math.SQRT2).toFixed(2); // 4.24

const V2_SEMI = (() => {
  const [R,W,H,D,C]=[V2_CORNER,V2_W,V2_H,V2_DIV_Y,V2_CUT];
  return [`M${R},0 L${W-R},0 Q${W},0 ${W},${R}`,
    `L${W},${D-C} A${C},${C} 0 0 0 ${W},${D+C}`,
    `L${W},${H-R} Q${W},${H} ${W-R},${H}`,
    `L${R},${H} Q0,${H} 0,${H-R}`,
    `L0,${D+C} A${C},${C} 0 0 0 0,${D-C}`,
    `L0,${R} Q0,0 ${R},0 Z`].join(' ');
})();
const V2_TRI = (() => {
  const [R,W,H,D,C,rc,rco]=[V2_CORNER,V2_W,V2_H,V2_DIV_Y,V2_CUT,V2_RC,V2_RCO];
  return [`M${R},0 L${W-R},0 Q${W},0 ${W},${R}`,
    `L${W},${D-C-rc}`,`Q${W},${D-C} ${W-rco},${D-C+rco}`,
    `L${W-C},${D}`,`L${W-rco},${D+C-rco}`,`Q${W},${D+C} ${W},${D+C+rc}`,
    `L${W},${H-R} Q${W},${H} ${W-R},${H}`,`L${R},${H} Q0,${H} 0,${H-R}`,
    `L0,${D+C+rc}`,`Q0,${D+C} ${rco},${D+C-rco}`,
    `L${C},${D}`,`L${rco},${D-C+rco}`,`Q0,${D-C} 0,${D-C-rc}`,
    `L0,${R} Q0,0 ${R},0 Z`].join(' ');
})();




function ShareCardInnerV2({ S, pnlCurve, closed, totalPnl, winRate, tf, walletLabel, _overrideRank, cardPnlCompact = false }) {
  const ranks = S.pnlRanks ?? PNL_RANKS;
  const rank  = _overrideRank ?? getPnlRank(totalPnl, ranks);

  // gc = global V2 layout (S.defaultCardV2 → admin Card V2 tab)
  // rc = per-rank visual (rank.card → admin Ranks V2 tab)
  const gc = { ...DEFAULT_CARD_V2, ...(S?.defaultCardV2 ?? {}) };
  const rc = { ...DEFAULT_CARD,    ...(rank.card       ?? {}) };

  const S1_MAX = gc.v2S1Max ?? 72;
  const S2     = gc.v2S2    ?? 22;
  const S3     = gc.v2S3    ?? 13;

  // User bg image (local state in ShareModal, passed through S)
  const bgImage     = S.cardV2BgImage     ?? null;
  const bgTransform = S.cardV2BgTransform ?? { x:0, y:0, scale:1, rotate:0 };
  const bgDarken    = S.cardV2BgDarken    ?? 40; // 0-100

  // Text alignment: user pref overrides admin default
  const textAlign = S.cardV2TextAlign ?? gc.v2TextAlign ?? 'center';

  const notchStyle = S.cardNotchStyle ?? 'semicircle';
  const showChart  = rc.showChart ?? true;
  const ticket     = notchStyle === 'triangle' ? V2_TRI : V2_SEMI;

  // User color override (from ShareModal) takes priority over rank admin setting
  const _useRankColor = S.cardV2UseRankColor ?? (rc.useRankColor ?? true);
  const _customColor  = S.cardV2CustomColor  ?? (rc.customColor  ?? '#ffffff');
  const col      = _useRankColor ? rank.color : _customColor;
  // User show-rank and second-field options
  const showRank    = S.cardV2ShowRank    !== false;  // default true
  const secondField = S.cardV2SecondField ?? null;    // string or null
  const isPos    = totalPnl >= 0;
  const pnlColor = isPos ? col : '#ff3355';

  const _cur = S?.currency ?? 'SOL';
  const _raw = solToDisplay(totalPnl, _cur) ?? totalPnl;
  const isSolCur = !_cur || _cur === 'SOL' || _raw === null || _raw === totalPnl;
  // currencySymbol: used as text prefix when NOT SOL (logo handles SOL case)
  const currencySymbol = isSolCur ? null : (CURRENCY_SYMBOLS[_cur] ?? (_cur + ' '));
  // displayStr: for SOL → number only (logo is shown separately)
  //             for other → symbol + number (logo hidden, symbol shown)
  const displayStr = (() => {
    const val   = isSolCur ? totalPnl : (_raw ?? totalPnl);
    const sign  = val < 0 ? '-' : '+';
    const absV  = Math.abs(val);
    const isCompactable = cardPnlCompact && absV >= 1000;
    if (isCompactable) {
      const k = (absV/1000).toFixed(1);
      return sign + (currencySymbol ?? '') + k + 'k';
    }
    const decimals = isSolCur ? 2 : (CURRENCY_DECIMALS?.[_cur] ?? 2);
    return sign + (currencySymbol ?? '') + fmt(absV, decimals);
  })();
  // volDisplay: format a SOL amount for volume display (no sign)
  const volFmt = (solAmt, dec=1) => {
    const val    = isSolCur ? solAmt : (solToDisplay(solAmt, _cur) ?? solAmt);
    const absV   = Math.abs(val);
    const isComp = cardPnlCompact && absV >= 1000;
    if (isComp) return (currencySymbol ?? '') + (absV/1000).toFixed(1) + 'k';
    const decimals = isSolCur ? dec : (CURRENCY_DECIMALS?.[_cur] ?? 2);
    return (currencySymbol ?? '') + fmt(absV, decimals);
  };

  const totalSolIn  = closed.reduce((s,x) => s + (x.solIn  || 0), 0);
  const totalSolOut = closed.reduce((s,x) => s + (x.solOut || 0), 0);
  const pct    = totalSolIn > 0 ? (totalPnl/totalSolIn)*100 : 0;
  const retStr = `${pct >= 0 ? '+' : ''}${fmt(Math.abs(pct),1)}%`;

  // Gradient (only used when no bgImage)
  const gradA = rc.gradientAngle ?? 135;
  const rad   = (gradA*Math.PI)/180;
  const gx1 = +(0.5-0.5*Math.sin(rad)).toFixed(4);
  const gy1 = +(0.5+0.5*Math.cos(rad)).toFixed(4);
  const gx2 = +(0.5+0.5*Math.sin(rad)).toFixed(4);
  const gy2 = +(0.5-0.5*Math.cos(rad)).toFixed(4);
  const uid    = rank.name.replace(/\W/g,'');
  const bgId   = `v2bg-${uid}`;
  const clipId = `v2clip-${uid}`;

  const BLEN  = gc.v2BracketLen     ?? V2_BLEN;
  const BOPAC = gc.v2BracketOpacity ?? 0.18;

  // Text alignment helpers
  const TX = textAlign==='left' ? V2_BL_X : textAlign==='right' ? V2_BR_X : V2_W/2;
  const TA = textAlign==='left' ? 'start'  : textAlign==='right' ? 'end'   : 'middle';

  // PnL layout computation
  const computeLayout = (fs, numW) => {
    const capH  = 0.72*fs;
    const lScl  = v2LS(fs);
    const lW    = v2LWpx(fs);
    const cw    = lW + V2_GAP + numW;
    let logoX, numX;
    if (textAlign === 'left') {
      logoX = V2_PAD; numX = V2_PAD + lW + V2_GAP;
    } else if (textAlign === 'right') {
      numX = V2_BR_X - numW; logoX = numX - V2_GAP - lW;
    } else {
      const hPad = Math.max(V2_PAD, (V2_W-cw)/2);
      logoX = hPad; numX = hPad + lW + V2_GAP;
    }
    const rlg     = gc.v2ReturnLabelGap ?? 14;
    const rvg     = gc.v2ReturnValGap   ?? 6;
    const blockH  = capH + rlg + S3 + rvg + S2;
    const C_MID   = (V2_BT_Y + (V2_BB_Y - S3 - 16)) / 2;
    const pnlBase = Math.round(C_MID + (gc.v2PnlYOffset??0) - blockH/2 + capH);
    const logoTop = pnlBase - capH;
    const unitMidX = logoX + (lW + V2_GAP + numW)/2;
    const tfX = textAlign==='left' ? V2_PAD : textAlign==='right' ? V2_BR_X : unitMidX;
    return {
      fs, logoX, numX, lScl, lW, capH, pnlBase, logoTop,
      tfX, tfY: logoTop - (gc.v2TfGap??12),
      retLblY: pnlBase + rlg + S3,
      retValY: pnlBase + rlg + S3 + rvg + S2,
    };
  };

  const initialLayout = useMemo(() => {
    const ORB = ch => {
      if (/[0-9]/.test(ch)) return 0.62;
      if ('+-'.includes(ch)) return 0.52;
      if ('.,'.includes(ch)) return 0.28;
      if ('$£€'.includes(ch)) return 0.65;
      if ('zł₴₸₽'.includes(ch)) return 0.72;
      if (/[A-Z]/.test(ch)) return 0.65;
      return 0.55;
    };
    const availW = V2_W - 2*V2_PAD;
    const est    = fs => displayStr.split('').reduce((s,ch) => s+fs*ORB(ch), 0) - 1.5*(displayStr.length-1);
    const cw     = fs => v2LWpx(fs) + V2_GAP + est(fs);
    let fs = S1_MAX;
    if (cw(fs) > availW) {
      let lo=20, hi=S1_MAX;
      for (let i=0;i<40;i++) { const m=(lo+hi)/2; cw(m)<=availW?(lo=m):(hi=m); }
      fs = lo;
    }
    return computeLayout(fs, est(fs));
  }, [displayStr, textAlign, S1_MAX, gc.v2PnlYOffset, gc.v2ReturnLabelGap, gc.v2ReturnValGap, gc.v2TfGap]);

  const [layout, setLayout] = useState(initialLayout);
  const pnlNumRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const el = pnlNumRef.current;
    if (!el) return;
    document.fonts.ready.then(() => {
      if (cancelled || !el.getBBox) return;
      const availW = V2_W - 2*V2_PAD;
      const measure = fs => {
        el.setAttribute('font-size', fs);
        try { return v2LWpx(fs) + V2_GAP + el.getBBox().width; }
        catch { return Infinity; }
      };
      let fs = S1_MAX;
      if (measure(fs) > availW) {
        let lo=20, hi=S1_MAX;
        for (let i=0;i<40;i++) { const m=(lo+hi)/2; measure(m)<=availW?(lo=m):(hi=m); }
        fs = lo;
      }
      el.setAttribute('font-size', fs);
      if (!cancelled) setLayout(computeLayout(fs, el.getBBox().width));
    });
    return () => { cancelled = true; };
  }, [displayStr, textAlign, S1_MAX, gc.v2PnlYOffset, gc.v2ReturnLabelGap, gc.v2ReturnValGap, gc.v2TfGap]);

  const L    = layout;
  const fOrb = `'Orbitron',monospace`;

  // Sparkline
  const STUB_X=24, STUB_Y=400, CURVE_W=176, CURVE_H=76;
  let cv = null;
  if (showChart && pnlCurve && pnlCurve.length >= 2) {
    const vals = pnlCurve.map(d => d.cumPnl);
    const mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||1;
    const px=4,py=4,iw=CURVE_W-px*2,ih=CURVE_H-py*2;
    const tx = i => px + (i/(vals.length-1))*iw;
    const ty = v => py + (1-(v-mn)/rng)*ih;
    cv = {
      pts: vals.map((v,i)=>`${tx(i).toFixed(1)},${ty(v).toFixed(1)}`).join(' '),
      lastX: tx(vals.length-1), lastY: ty(vals[vals.length-1]),
    };
  }

  const WG_X   = gc.v2VolGraphX ?? 218;
  const NG_LXA = gc.v2VolNgColA ?? 42;
  const NG_LXB = gc.v2VolNgColB ?? 182;

  const vlS3=v2LS(S3), vlW3=Math.round(v2LWpx(S3)), vlH3=Math.round(V2_LH*vlS3);
  const vlS2=v2LS(S2), vlW2=Math.round(v2LWpx(S2)), vlH2=Math.round(V2_LH*vlS2);

  const WG_NX  = WG_X   + vlW3 + 5;
  const NG_NXA = NG_LXA + vlW2 + 5;
  const NG_NXB = NG_LXB + vlW2 + 5;

  // With-graph vol: centered in stub zone 400-484 (84px), top_pad=16
  const WG_L1=425, WG_N1=437, WG_L2=456, WG_N2=468;
  // No-graph vol: centered, top_pad=27
  const NG_LBL_Y=436, NG_NUM_Y=458, NG_LOGO_T=NG_NUM_Y-vlH2;

  const nickY = V2_BB_Y + (gc.v2NicknameYOff ?? -8);

  return (
    <svg width={V2_W} height={V2_H} xmlns="http://www.w3.org/2000/svg" className="no-ts-scale" style={{ display:'block' }}>
      <defs>
        <clipPath id={clipId}><path d={ticket}/></clipPath>
        {!bgImage && (
          <linearGradient id={bgId} x1={gx1} y1={gy1} x2={gx2} y2={gy2}>
            <stop offset={`${rc.g1Stop??0}%`}   stopColor={rank.g1} stopOpacity={rc.g1Opacity??0.68}/>
            <stop offset={`${rc.midStop??44}%`}  stopColor={rc.midColor??'#0a0a0a'}/>
            <stop offset={`${rc.endStop??100}%`} stopColor={rc.endColor??'#040404'}/>
          </linearGradient>
        )}
        <linearGradient id={`${uid}stubfade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#000000" stopOpacity="0"/>
          <stop offset="100%" stopColor="#000000" stopOpacity={bgImage ? 0.92 : 0}/>
        </linearGradient>
      </defs>

      {/* Background */}
      {bgImage ? (
        <>
          <path d={ticket} fill="#060606"/>
          <g clipPath={`url(#${clipId})`}>
            <g transform={`translate(${170+(bgTransform.x||0)},${245+(bgTransform.y||0)}) rotate(${bgTransform.rotate||0}) scale(${bgTransform.scale||1})`}>
              <image href={bgImage} x={-170} y={-245} width={V2_W} height={V2_H}
                preserveAspectRatio="xMidYMid slice"/>
            </g>
            {/* Darkening / vignette overlay on the image */}
            {bgDarken > 0 && (
              <rect x="0" y="0" width={V2_W} height={V2_H}
                fill="#000000" opacity={bgDarken/100}/>
            )}
          </g>
          <rect x="0" y={V2_DIV_Y-V2_CUT} width={V2_W} height={V2_H-(V2_DIV_Y-V2_CUT)}
            fill={`url(#${uid}stubfade)`} clipPath={`url(#${clipId})`}/>
        </>
      ) : (
        <path d={ticket} fill={`url(#${bgId})`}/>
      )}

      {/* Band tint + bottom edge */}
      <rect x="0" y="0" width={V2_W} height={V2_BAND_H}
        fill={col} opacity=".08" clipPath={`url(#${clipId})`}/>
      <line x1="0" y1={V2_BAND_H} x2={V2_W} y2={V2_BAND_H}
        stroke={col} strokeWidth=".7" opacity=".2" clipPath={`url(#${clipId})`}/>

      {/* Outer border */}
      <path d={ticket} fill="none" stroke={col}
        strokeWidth={gc.v2BorderWidth ?? 1.1} opacity={gc.v2BorderOpacity ?? 0.38}
        strokeLinejoin="round" strokeLinecap="round"/>

      {/* Stub divider */}
      <line x1="22" y1={V2_DIV_Y} x2="318" y2={V2_DIV_Y}
        stroke={col} strokeDasharray={gc.v2DividerDash ?? '4,4'}
        strokeWidth={gc.v2DividerWidth ?? 1} opacity={gc.v2DividerOpacity ?? 0.48}/>

      {/* L-brackets */}
      <polyline points={`${V2_BL_X},${V2_BT_Y+BLEN} ${V2_BL_X},${V2_BT_Y} ${V2_BL_X+BLEN},${V2_BT_Y}`}
        fill="none" stroke={col} strokeWidth="1" opacity={BOPAC}/>
      <polyline points={`${V2_BR_X-BLEN},${V2_BT_Y} ${V2_BR_X},${V2_BT_Y} ${V2_BR_X},${V2_BT_Y+BLEN}`}
        fill="none" stroke={col} strokeWidth="1" opacity={BOPAC}/>
      <polyline points={`${V2_BL_X},${V2_BB_Y-BLEN} ${V2_BL_X},${V2_BB_Y} ${V2_BL_X+BLEN},${V2_BB_Y}`}
        fill="none" stroke={col} strokeWidth="1" opacity={BOPAC}/>
      <polyline points={`${V2_BR_X-BLEN},${V2_BB_Y} ${V2_BR_X},${V2_BB_Y} ${V2_BR_X},${V2_BB_Y-BLEN}`}
        fill="none" stroke={col} strokeWidth="1" opacity={BOPAC}/>

      {/* Rank name (or username if rank hidden) */}
      <text x={TX} y="33" textAnchor={TA}
        fontFamily={fOrb} fontWeight="900" fontSize={S2}
        fill={col} letterSpacing="2"
        style={{ filter:`drop-shadow(0 0 8px ${col}44)` }}>
        {showRank ? rank.name : walletLabel}
      </text>

      {/* Timeframe */}
      <text x={L.tfX} y={L.tfY} textAnchor={TA}
        fontFamily={fOrb} fontSize={S3}
        fill="rgba(255,255,255,0.62)" letterSpacing="2">{tf || 'ALL TIME'}</text>

      {/* PnL unit: SOL→logo+number, other→text-symbol+number */}
      {isSolCur ? (
        <g transform={`translate(${L.logoX.toFixed(1)},${L.logoTop.toFixed(1)}) scale(${L.lScl.toFixed(4)})`}
          fill={pnlColor} style={{ filter:`drop-shadow(0 0 12px ${pnlColor}44)` }}>
          <path d={V2_LOGO_PATH}/>
        </g>
      ) : null}
      <text ref={pnlNumRef}
        x={isSolCur ? L.numX.toFixed(1) : TX.toFixed ? TX.toFixed(1) : TX}
        y={L.pnlBase}
        textAnchor={isSolCur ? 'start' : TA}
        fontFamily={fOrb} fontWeight="900" fontSize={L.fs}
        fill={pnlColor} letterSpacing="-1.5"
        style={{ filter:`drop-shadow(0 0 18px ${pnlColor}33)` }}>
        {displayStr}
      </text>

      {/* RETURN */}
      <text x={TX} y={L.retLblY} textAnchor={TA}
        fontFamily={fOrb} fontSize={S3}
        fill="rgba(255,255,255,0.62)" letterSpacing="1">RETURN</text>
      <text x={TX} y={L.retValY} textAnchor={TA}
        fontFamily={fOrb} fontWeight="700" fontSize={S2}
        fill={pnlColor} opacity=".88">{retStr}</text>

      {/* Nickname (or second field when rank name is in band) */}
      {showRank ? (
        <text x={TX} y={nickY} textAnchor={TA}
          fontFamily={fOrb} fontSize={S3}
          fill="rgba(255,255,255,0.52)">{walletLabel}</text>
      ) : secondField ? (
        <text x={TX} y={nickY} textAnchor={TA}
          fontFamily={fOrb} fontSize={S3}
          fill="rgba(255,255,255,0.42)">{secondField}</text>
      ) : null}

      {/* STUB */}
      {showChart ? (
        <>
          {cv && (
            <svg x={STUB_X} y={STUB_Y} width={CURVE_W} height={CURVE_H} overflow="visible">
              <polyline points={cv.pts} fill="none" stroke={pnlColor}
                strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
              <circle cx={cv.lastX} cy={cv.lastY} r="3" fill={pnlColor}
                style={{ filter:`drop-shadow(0 0 5px ${pnlColor})` }}/>
            </svg>
          )}
          <text x={WG_X} y={WG_L1} fontFamily={fOrb} fontSize={S3}
            fill="rgba(255,255,255,0.52)">BOUGHT</text>
          {isSolCur && <g transform={`translate(${WG_X},${WG_N1-vlH3}) scale(${vlS3.toFixed(4)})`}
            fill="rgba(255,255,255,0.40)"><path d={V2_LOGO_PATH}/></g>}
          <text x={isSolCur ? WG_NX : WG_X} y={WG_N1} fontFamily={fOrb} fontSize={S3}
            fill="rgba(255,255,255,0.72)">{volFmt(totalSolIn,1)}</text>
          <text x={WG_X} y={WG_L2} fontFamily={fOrb} fontSize={S3}
            fill={col} opacity=".55">SOLD</text>
          {isSolCur && <g transform={`translate(${WG_X},${WG_N2-vlH3}) scale(${vlS3.toFixed(4)})`}
            fill={col} opacity=".68"><path d={V2_LOGO_PATH}/></g>}
          <text x={isSolCur ? WG_NX : WG_X} y={WG_N2} fontFamily={fOrb} fontSize={S3}
            fill={col}>{volFmt(totalSolOut,1)}</text>
        </>
      ) : (
        <>
          <text x={NG_LXA} y={NG_LBL_Y} fontFamily={fOrb} fontSize={S3}
            fill="rgba(255,255,255,0.52)">BOUGHT</text>
          {isSolCur && <g transform={`translate(${NG_LXA},${NG_LOGO_T}) scale(${vlS2.toFixed(4)})`}
            fill="rgba(255,255,255,0.40)"><path d={V2_LOGO_PATH}/></g>}
          <text x={isSolCur ? NG_NXA : NG_LXA} y={NG_NUM_Y} fontFamily={fOrb} fontWeight="700" fontSize={S2}
            fill="rgba(255,255,255,0.80)">{volFmt(totalSolIn,2)}</text>
          <text x={NG_LXB} y={NG_LBL_Y} fontFamily={fOrb} fontSize={S3}
            fill={col} opacity=".60">SOLD</text>
          {isSolCur && <g transform={`translate(${NG_LXB},${NG_LOGO_T}) scale(${vlS2.toFixed(4)})`}
            fill={col} opacity=".78"><path d={V2_LOGO_PATH}/></g>}
          <text x={isSolCur ? NG_NXB : NG_LXB} y={NG_NUM_Y} fontFamily={fOrb} fontWeight="700" fontSize={S2}
            fill={col}>{volFmt(totalSolOut,2)}</text>
        </>
      )}

      <text x={V2_W/2} y={V2_H-8} textAnchor="middle"
        fontFamily={fOrb} fontSize="5"
        fill="rgba(255,255,255,0.06)" letterSpacing="2">{S.appName ?? 'SOLTRACK'}</text>
    </svg>
  );
}

// Share modal — preview only, card appearance configured per-rank in admin
function ShareModal({ S, setSetting, pnlCurve, closed, totalPnl, winRate, tf, walletLabel, onClose }) {
  const ranks = S.pnlRanks ?? PNL_RANKS;
  const rank  = getPnlRank(totalPnl, ranks);
  const captureRef = useRef(null);
  const [capturing, setCapturing] = useState(null); // null | "download" | "copy" | "copied"
  const defaultShowChart = { ...(DEFAULT_CARD), ...(rank.card ?? {}) }.showChart ?? true;
  const [showChart, setShowChart] = useState(defaultShowChart);
  const [customLabel, setCustomLabel] = useState("");
  const [cardTextScale, setCardTextScale] = useState(1.0);
  const [cardPnlCompact, setCardPnlCompact] = useState(false);
  const [useV2Design, setUseV2Design] = useState(S.cardDesignV2 ?? false);
  // V2-only: text alignment (persisted in S) and background image (session-only, not persisted)
  const [v2TextAlign,    setV2TextAlign]    = useState(S.cardV2TextAlign ?? 'center');
  const [v2BgImage,      setV2BgImage]      = useState(null);
  const [v2BgTx,         setV2BgTx]         = useState({ x:0, y:0, scale:1, rotate:0 });
  const [v2BgDarken,     setV2BgDarken]     = useState(40); // 0-100 darkness %
  const [v2UseRankColor, setV2UseRankColor] = useState(true);  // true=rank color, false=custom
  const [v2CustomColor,  setV2CustomColor]  = useState('#ffffff');
  const [v2ShowRank,     setV2ShowRank]     = useState(true);   // show rank name in band
  const [v2SecondField,  setV2SecondField]  = useState('');      // custom text below (when rank hidden)
  const [v2ShowSecond,   setV2ShowSecond]   = useState(false);   // show second field at all
  // Build a merged rank with the user's session overrides applied
  const baseCard = { ...DEFAULT_CARD, ...(rank.card ?? {}) };
  const previewRank = { ...rank, card: {
    ...baseCard,
    showChart,
    solFontSize:         Math.round((baseCard.solFontSize         ?? DEFAULT_CARD.solFontSize)         * cardTextScale),
    walletLabelFontSize: Math.round((baseCard.walletLabelFontSize ?? DEFAULT_CARD.walletLabelFontSize) * cardTextScale),
  }};

  const mono = { fontFamily: "'DM Mono', monospace" };
  const accentColor = rank.color;

  const buildCanvas = async () => {
    const el    = captureRef.current;
    const svgEl = el?.querySelector('svg');
    if (!svgEl) throw new Error('SVG not found');
    const W = +svgEl.getAttribute('width') || 340;
    const H = +svgEl.getAttribute('height') || 490;
    const MARGIN = 32;

    let embeddedFontCSS = '';
    try {
      const gFontsCSS = await fetch(
        'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=DM+Mono:wght@400;500&display=swap'
      ).then(r => r.text());
      const fontUrls = [...new Set(
        [...gFontsCSS.matchAll(/url\(([^)]+)\)/g)]
          .map(m => m[1].replace(/['"]/g, '').trim())
          .filter(u => u.startsWith('https://'))
      )];
      const urlToData = new Map();
      await Promise.all(fontUrls.map(async url => {
        try {
          const buf = await fetch(url).then(r => r.arrayBuffer());
          const arr = new Uint8Array(buf);
          let b64 = '';
          for (let i = 0; i < arr.length; i += 8192)
            b64 += String.fromCharCode(...arr.subarray(i, i + 8192));
          urlToData.set(url, 'data:font/woff2;base64,' + btoa(b64));
        } catch {}
      }));
      embeddedFontCSS = gFontsCSS.replace(
        /url\(['"\s]?([^'"\)\s]+)['"\s]?\)/g,
        (match, url) => urlToData.has(url) ? `url("${urlToData.get(url)}")` : match
      );
    } catch (e) { console.warn('Font embed failed:', e); }

    const serializer = new XMLSerializer();
    let svgStr = serializer.serializeToString(svgEl);
    if (!svgStr.includes('xmlns='))
      svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    if (embeddedFontCSS) {
      const styleTag = `<style type="text/css">${embeddedFontCSS}</style>`;
      if (/<defs[\s/>]/.test(svgStr)) svgStr = svgStr.replace(/(<defs[^>]*>)/, `$1${styleTag}`);
      else svgStr = svgStr.replace(/(<svg[^>]*>)/, `$1<defs>${styleTag}</defs>`);
    }

    const SCALE = 2;
    const canvas = document.createElement('canvas');
    canvas.width  = (W + MARGIN*2) * SCALE;
    canvas.height = (H + MARGIN*2) * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, W + MARGIN*2, H + MARGIN*2);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    await new Promise((res, rej) => {
      const img = new Image();
      img.onload = async () => {
        await new Promise(r => setTimeout(r, 150));
        ctx.drawImage(img, MARGIN, MARGIN, W, H);
        URL.revokeObjectURL(url); res();
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('SVG render failed')); };
      img.src = url;
    });
    return canvas;
  };

  const doCapture = async () => {
    if (capturing) return;
    setCapturing('download');
    try {
      const canvas = await buildCanvas();
      canvas.toBlob(pngBlob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(pngBlob);
        a.download = `soltrack-${rank.name.toLowerCase()}-${Date.now()}.png`;
        a.click(); URL.revokeObjectURL(a.href);
      }, 'image/png');
    } catch(e) { alert('Download failed: ' + e.message); }
    finally { setCapturing(null); }
  };

  const doCopy = async () => {
    if (capturing) return;
    setCapturing('copy');
    try {
      const canvas  = await buildCanvas();
      const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setCapturing('copied');
      setTimeout(() => setCapturing(null), 1500);
    } catch(e) { alert('Copy failed: ' + e.message); setCapturing(null); }
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9000,
      background:'rgba(0,0,0,0.9)', backdropFilter:'blur(14px)',
      display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'#0a0a0a', border:'1px solid #222', display:'flex', gap:0 }}>

        {/* Ranks list sidebar */}
        <div style={{ width:160, borderRight:'1px solid #1a1a1a', padding:'16px 0', display:'flex', flexDirection:'column', gap:2, overflowY:'auto' }}>
          <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', padding:'0 12px 8px' }}>RANKS</div>
          {[...ranks].reverse().map(r => {
            const isCur = r.name === rank.name;
            const threshold = r.min === -Infinity ? null : r.min;
            return (
              <div key={r.name} style={{
                padding:'5px 12px', display:'flex', alignItems:'center', gap:6,
                background: isCur ? `${r.color}18` : 'transparent',
                borderLeft: `2px solid ${isCur ? r.color : 'transparent'}`,
                transition:'all .1s',
              }}>
                <div style={{ width:6, height:6, borderRadius:'50%',
                  background: r.color,
                  border: r.name === 'PHANTASM' ? '1.5px solid #ffffff' : 'none',
                  boxSizing: 'border-box',
                  boxShadow: isCur ? `0 0 6px ${r.color === '#000000' || r.color === '#000' ? '#fff' : r.color}` : 'none',
                  flexShrink:0 }}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <span style={{ ...mono, fontSize:8, color: isCur ? r.color : '#444',
                    fontWeight: isCur ? 700 : 400, letterSpacing:'.06em',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block' }}>
                    {r.name}
                  </span>
                  {threshold !== null && (
                    <span style={{ ...mono, fontSize:7, color: isCur ? `${r.color}99` : '#333' }}>
                      ≥ {threshold} SOL
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Main content */}
        <div style={{ display:'flex', flexDirection:'column' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'12px 18px', borderBottom:'1px solid #1a1a1a' }}>
          <div style={{ fontFamily:"'Orbitron',monospace", fontSize:9, letterSpacing:'.18em', color:'#fff' }}>
            SHARE CARD
            <span style={{ marginLeft:10, color:rank.color, textShadow:`0 0 8px ${rank.color}88` }}>· {rank.name}</span>
          </div>
          <button onClick={onClose}
            style={{ background:'none', border:'none', color:'#555', cursor:'pointer', fontSize:18, lineHeight:1, paddingLeft:16 }}>×</button>
        </div>

        {/* Card */}
        <div style={{ background:'#050505', padding:'32px 28px',
          display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div ref={captureRef} style={{ display:'block', lineHeight:0 }}>
            {useV2Design
              ? <ShareCardInnerV2
                  S={{ ...S, cardV2TextAlign: v2TextAlign, cardV2BgImage: v2BgImage, cardV2BgTransform: v2BgTx,
                    cardV2BgDarken: v2BgDarken,
                    cardV2UseRankColor: v2UseRankColor, cardV2CustomColor: v2CustomColor,
                    cardV2ShowRank: v2ShowRank, cardV2SecondField: v2ShowRank ? null : (v2ShowSecond ? v2SecondField : null) }}
                  pnlCurve={pnlCurve} closed={closed}
                  totalPnl={totalPnl} winRate={winRate} tf={tf}
                  walletLabel={customLabel.trim() || walletLabel}
                  cardPnlCompact={cardPnlCompact}
                  _overrideRank={previewRank}/>
              : <ShareCardInner S={S} pnlCurve={pnlCurve} closed={closed}
                  totalPnl={totalPnl} winRate={winRate} tf={tf}
                  walletLabel={customLabel.trim() || walletLabel}
                  cardPnlCompact={cardPnlCompact}
                  _overrideRank={previewRank}/>}
          </div>
        </div>

        {/* Settings panel — two-column grid: left=universal, right=V2-only */}
        <div style={{ borderTop:'1px solid #1a1a1a', padding:'14px 18px', display:'flex', flexDirection:'column', gap:12 }}>

          {/* Top row: wallet label (full width) */}
          <div>
            <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>WALLET LABEL</div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <input value={customLabel} onChange={e => setCustomLabel(e.target.value)}
                placeholder={walletLabel} maxLength={32}
                style={{ flex:1, background:'#111', border:'1px solid #222', color:'#aaa',
                  outline:'none', fontFamily:"'DM Mono',monospace", fontSize:9,
                  padding:'5px 8px', letterSpacing:'.04em' }} />
              {customLabel && (
                <button onMouseDown={e => { e.preventDefault(); setCustomLabel(''); }}
                  style={{ background:'none', border:'1px solid #222', color:'#555',
                    cursor:'pointer', fontSize:10, padding:'4px 7px', lineHeight:1 }}>×</button>
              )}
            </div>
          </div>

          {/* Control grid */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px 20px' }}>

            {/* ── LEFT COLUMN: universal controls ── */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

              {/* Design + Notch */}
              <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
                <div style={{ flexShrink:0 }}>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>DESIGN</div>
                  <div style={{ display:'flex', gap:4 }}>
                    {[{ id:false, label:'CLASSIC' }, { id:true, label:'NEW' }].map(opt => {
                      const active = useV2Design === opt.id;
                      return (
                        <button key={String(opt.id)}
                          onClick={() => { setUseV2Design(opt.id); setSetting('cardDesignV2', opt.id); }}
                          style={{ ...mono, fontSize:8, padding:'5px 10px',
                            background: active ? accentColor+'1a' : '#111',
                            border:`1px solid ${active ? accentColor : '#222'}`,
                            color: active ? accentColor : '#555',
                            cursor:'pointer', letterSpacing:'.08em', transition:'all .12s' }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ flexShrink:0 }}>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>NOTCH</div>
                  <div style={{ display:'flex', gap:4 }}>
                    {[
                      { id:'semicircle', label:'⌢ SEMI' },
                      { id:'triangle',   label:'△ TRI'  },
                    ].map(opt => {
                      const active = (S.cardNotchStyle ?? 'semicircle') === opt.id;
                      return (
                        <button key={opt.id} onClick={() => setSetting('cardNotchStyle', opt.id)}
                          style={{ ...mono, fontSize:8, padding:'5px 10px',
                            background: active ? accentColor+'1a' : '#111',
                            border:`1px solid ${active ? accentColor : '#222'}`,
                            color: active ? accentColor : '#555',
                            cursor:'pointer', letterSpacing:'.06em', transition:'all .12s' }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Chart + Compact */}
              <div style={{ display:'flex', gap:12 }}>
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>CHART</div>
                  <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}>
                    <input type="checkbox" checked={showChart} onChange={e => setShowChart(e.target.checked)}
                      style={{ accentColor, cursor:'pointer', width:13, height:13 }}/>
                    <span style={{ ...mono, fontSize:8, color: showChart ? accentColor : '#555' }}>
                      {showChart ? 'ON' : 'OFF'}
                    </span>
                  </label>
                </div>
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>COMPACT</div>
                  <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}>
                    <input type="checkbox" checked={cardPnlCompact} onChange={e => setCardPnlCompact(e.target.checked)}
                      style={{ accentColor, cursor:'pointer', width:13, height:13 }}/>
                    <span style={{ ...mono, fontSize:8, color: cardPnlCompact ? accentColor : '#555' }}>1000→1k</span>
                  </label>
                </div>
              </div>

              {/* Text scale — V1 only */}
              {!useV2Design && (
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>
                    TEXT SIZE — <span style={{ color: accentColor }}>{Math.round(cardTextScale*100)}%</span>
                  </div>
                  <input type="range" min={0.4} max={1.8} step={0.05} value={cardTextScale}
                    onChange={e => setCardTextScale(+e.target.value)}
                    style={{ width:'100%', accentColor, display:'block' }} />
                </div>
              )}

              {/* V2: text align */}
              {useV2Design && (
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>TEXT ALIGN</div>
                  <div style={{ display:'flex', gap:4 }}>
                    {[
                      { id:'left',   label:'◂ L' },
                      { id:'center', label:'● C' },
                      { id:'right',  label:'R ▸' },
                    ].map(opt => {
                      const active = v2TextAlign === opt.id;
                      return (
                        <button key={opt.id} onClick={() => {
                          setV2TextAlign(opt.id);
                          setSetting('cardV2TextAlign', opt.id);
                        }}
                          style={{ ...mono, fontSize:8, padding:'5px 10px',
                            background: active ? accentColor+'1a' : '#111',
                            border:`1px solid ${active ? accentColor : '#222'}`,
                            color: active ? accentColor : '#555',
                            cursor:'pointer', letterSpacing:'.06em', transition:'all .12s' }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── RIGHT COLUMN: V2-only controls ── */}
            {useV2Design && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

                {/* Accent color */}
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>ACCENT COLOR</div>
                  <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                    {[{id:true,label:'RANK'},{id:false,label:'CUSTOM'}].map(opt => {
                      const active = v2UseRankColor === opt.id;
                      return (
                        <button key={String(opt.id)} onClick={() => setV2UseRankColor(opt.id)}
                          style={{ ...mono, fontSize:8, padding:'5px 10px',
                            background: active ? accentColor+'1a' : '#111',
                            border:`1px solid ${active ? accentColor : '#222'}`,
                            color: active ? accentColor : '#555',
                            cursor:'pointer', letterSpacing:'.06em', transition:'all .12s' }}>
                          {opt.label}
                        </button>
                      );
                    })}
                    {!v2UseRankColor && (
                      <>
                        <div style={{ position:'relative', width:22, height:22, flexShrink:0 }}>
                          <div style={{ position:'absolute', inset:0, background:v2CustomColor, border:'1px solid #333', borderRadius:2 }}/>
                          <input type="color" value={v2CustomColor} onChange={e => setV2CustomColor(e.target.value)}
                            style={{ position:'absolute', inset:0, opacity:0, width:'100%', height:'100%', cursor:'pointer' }}/>
                        </div>
                        <input type="text" value={v2CustomColor} onChange={e => setV2CustomColor(e.target.value)}
                          style={{ ...mono, background:'#111', border:'1px solid #222', color:'#ddd',
                            fontSize:9, width:72, padding:'3px 6px' }}/>
                      </>
                    )}
                  </div>
                </div>

                {/* Rank title toggle */}
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>RANK TITLE</div>
                  <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                    {[{id:true,label:'SHOW'},{id:false,label:'HIDE'}].map(opt => {
                      const active = v2ShowRank === opt.id;
                      return (
                        <button key={String(opt.id)} onClick={() => setV2ShowRank(opt.id)}
                          style={{ ...mono, fontSize:8, padding:'5px 10px',
                            background: active ? accentColor+'1a' : '#111',
                            border:`1px solid ${active ? accentColor : '#222'}`,
                            color: active ? accentColor : '#555',
                            cursor:'pointer', letterSpacing:'.06em', transition:'all .12s' }}>
                          {opt.label}
                        </button>
                      );
                    })}
                    {!v2ShowRank && (
                      <span style={{ ...mono, fontSize:8, color:'#444' }}>· username takes band</span>
                    )}
                  </div>
                </div>

                {/* Second field — only when rank hidden */}
                {!v2ShowRank && (
                  <div>
                    <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>
                      SECOND FIELD
                      <label style={{ marginLeft:8, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:4 }}>
                        <input type="checkbox" checked={v2ShowSecond} onChange={e => setV2ShowSecond(e.target.checked)}
                          style={{ accentColor, cursor:'pointer' }}/>
                        <span style={{ ...mono, fontSize:7, color: v2ShowSecond ? accentColor : '#444' }}>
                          {v2ShowSecond ? 'ON' : 'OFF'}
                        </span>
                      </label>
                    </div>
                    {v2ShowSecond && (
                      <input value={v2SecondField} onChange={e => setV2SecondField(e.target.value)}
                        placeholder="referral link, quote…" maxLength={60}
                        style={{ width:'100%', background:'#111', border:'1px solid #222', color:'#aaa',
                          ...mono, fontSize:9, padding:'5px 8px', boxSizing:'border-box' }}/>
                    )}
                  </div>
                )}

                {/* Background image */}
                <div>
                  <div style={{ ...mono, fontSize:7, color:'#444', letterSpacing:'.12em', marginBottom:5 }}>BG IMAGE</div>
                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <label style={{ ...mono, fontSize:8, color: v2BgImage ? accentColor : '#555',
                      cursor:'pointer', border:`1px dashed ${v2BgImage ? accentColor+'88' : '#333'}`,
                      padding:'4px 10px', transition:'all .12s', whiteSpace:'nowrap' }}>
                      {v2BgImage ? '↑ REPLACE' : '↑ UPLOAD'}
                      <input type="file" accept="image/*" style={{ display:'none' }}
                        onChange={e => {
                          const file = e.target.files?.[0]; if (!file) return;
                          if (file.size > 4*1024*1024) { alert('Max 4 MB'); return; }
                          const reader = new FileReader();
                          reader.onload = ev => {
                            setV2BgImage(ev.target.result);
                            setV2BgTx({ x:0, y:0, scale:1, rotate:0 });
                            setV2UseRankColor(false);
                          };
                          reader.readAsDataURL(file);
                          e.target.value = '';
                        }}/>
                    </label>
                    {v2BgImage && (<>
                      <button onClick={() => { setV2BgImage(null); setV2BgTx({ x:0, y:0, scale:1, rotate:0 }); setV2BgDarken(40); }}
                        style={{ ...mono, fontSize:8, color:'#ff4444', background:'none',
                          border:'1px solid #ff003333', cursor:'pointer', padding:'4px 8px' }}>✕</button>
                      <button onClick={() => setV2BgTx({ x:0, y:0, scale:1, rotate:0 })}
                        style={{ ...mono, fontSize:8, color:'#555', background:'none',
                          border:'1px solid #333', cursor:'pointer', padding:'4px 8px' }}>↺</button>
                    </>)}
                  </div>
                  {v2BgImage && (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'5px 12px', marginTop:6 }}>
                      {[
                        { key:'darken', label:'DARKEN',  min:0,   max:100, step:1    },
                        { key:'scale',  label:'ZOOM',    min:0.3, max:4,   step:0.05 },
                        { key:'x',      label:'X',       min:-170,max:170, step:2    },
                        { key:'y',      label:'Y',       min:-245,max:245, step:2    },
                        { key:'rotate', label:'ROTATE',  min:0,   max:360, step:1    },
                      ].map(({ key, label, min, max, step }) => {
                        const val = key==='darken' ? v2BgDarken : (v2BgTx[key] ?? (key==='scale'?1:0));
                        const disp = key==='rotate' ? `${val}°` : key==='scale' ? `${(+val).toFixed(2)}×` : key==='darken' ? `${val}%` : val;
                        return (
                          <div key={key}>
                            <div style={{ ...mono, fontSize:7, color:'#444', marginBottom:2 }}>
                              {label} <span style={{ color:accentColor }}>{disp}</span>
                            </div>
                            <input type="range" min={min} max={max} step={step} value={val}
                              onChange={e => key==='darken'
                                ? setV2BgDarken(+e.target.value)
                                : setV2BgTx(prev => ({ ...prev, [key]: +e.target.value }))}
                              style={{ width:'100%', accentColor, display:'block' }}/>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', borderTop:'1px solid #1a1a1a', paddingTop:12 }}>
            <button onClick={doCopy} disabled={!!capturing}
              style={{ ...mono, background:'none', border:`1px solid ${accentColor}55`,
                color:accentColor, cursor:'pointer', padding:'8px 18px', fontSize:9,
                letterSpacing:'.1em', opacity:capturing?0.5:1, transition:'opacity .15s' }}>
              {capturing==='copied' ? '✓ COPIED' : capturing==='copy' ? '…' : '⎘ COPY IMAGE'}
            </button>
            <button onClick={doCapture} disabled={!!capturing}
              style={{ ...mono, background:accentColor+'18', border:`1px solid ${accentColor}`,
                color:accentColor, cursor:'pointer', padding:'8px 24px', fontSize:9,
                letterSpacing:'.1em', boxShadow:`0 0 12px ${accentColor}22`,
                opacity:capturing?0.5:1, transition:'opacity .15s', fontWeight:700 }}>
              {capturing==='download' ? 'RENDERING…' : '↓ DOWNLOAD PNG'}
            </button>
          </div>
        </div>
        </div>{/* end main content */}
      </div>
    </div>
  );
}

function ResetMyDataButton({ S, workerUrl, appSecret }) {
  const [phase, setPhase] = useState("idle"); // idle | confirm | wiping | done | error
  const [errMsg, setErrMsg] = useState("");
  const mono = { fontFamily: "'DM Mono',monospace" };

  const doWipe = async () => {
    setPhase("wiping");
    const clientToken = localStorage.getItem("soltrack_client_token");
    if (!clientToken) { setPhase("error"); setErrMsg("No client token found in this browser."); return; }
    const base = sanitizeWorkerUrl(workerUrl);
    try {
      const userToken = localStorage.getItem("soltrack_user_token") ?? ""; const headers = { "Content-Type": "application/json", ...(userToken ? { "Authorization": `Bearer ${userToken}` } : {}) };
      const res = await fetch(`${base}/wipe`, { method: "POST", headers, body: JSON.stringify({ clientToken }) });
      const data = await res.json();
      if (!res.ok) { setPhase("error"); setErrMsg(data.error ?? "Unknown error"); return; }
      setPhase("done");
    } catch (e) { setPhase("error"); setErrMsg(e.message); }
  };

  if (phase === "idle") return (
    <button onClick={() => setPhase("confirm")}
      style={{ background: "none", border: `1px solid ${S.accentRed}55`, color: S.accentRed, ...mono,
        fontSize: 9, padding: "7px 14px", cursor: "pointer", letterSpacing: ".1em" }}
      onMouseEnter={e => e.currentTarget.style.borderColor = S.accentRed}
      onMouseLeave={e => e.currentTarget.style.borderColor = `${S.accentRed}55`}>
      ⚠ WIPE MY SERVER DATA
    </button>
  );

  if (phase === "confirm") return (
    <div style={{ border: `1px solid ${S.accentRed}44`, padding: "12px 14px", background: `${S.accentRed}08` }}>
      <div style={{ ...mono, fontSize: 9, color: S.accentRed, marginBottom: 8, lineHeight: 1.7 }}>
        This will permanently delete all your trades and wallet history from the server.<br/>
        <strong>This cannot be undone.</strong> Your local wallet list will not be affected.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={doWipe}
          style={{ background: S.accentRed, border: "none", color: "#000", ...mono,
            fontSize: 9, padding: "6px 16px", cursor: "pointer", fontWeight: 700, letterSpacing: ".08em" }}>
          YES, DELETE EVERYTHING
        </button>
        <button onClick={() => setPhase("idle")}
          style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono,
            fontSize: 9, padding: "6px 12px", cursor: "pointer" }}>
          CANCEL
        </button>
      </div>
    </div>
  );

  if (phase === "wiping") return (
    <div style={{ ...mono, fontSize: 9, color: S.textDim }}>
      <span className="spin-ring" style={{ borderColor: `${S.accentRed} transparent transparent transparent`, marginRight: 8 }} />
      Wiping server data...
    </div>
  );

  if (phase === "done") return (
    <div style={{ ...mono, fontSize: 9, color: S.accentGreen, lineHeight: 1.6 }}>
      ✓ Server data wiped successfully.<br/>
      <span style={{ color: S.textDim }}>Re-sync your wallets to start fresh.</span>
    </div>
  );

  return (
    <div style={{ ...mono, fontSize: 9, color: S.accentRed }}>
      Error: {errMsg}
      <button onClick={() => setPhase("idle")} style={{ background: "none", border: "none", color: S.textDim, cursor: "pointer", marginLeft: 8, fontSize: 9 }}>retry</button>
    </div>
  );
}

function MigrateWalletButton({ S, workerUrl }) {
  const [phase, setPhase] = useState("idle"); // idle | confirm | signing | done | error
  const [errMsg, setErrMsg] = useState("");
  const mono = { fontFamily: "'DM Mono',monospace" };

  const doMigrate = async () => {
    setPhase("signing"); setErrMsg("");
    try {
      const provider = window.phantom?.solana || window.solflare || window.solana;
      if (!provider) throw new Error("No Solana wallet found.");
      await provider.connect();

      const pubkeyBytes = provider.publicKey.toBytes();
      const pubkeyHex   = Array.from(pubkeyBytes).map(b => b.toString(16).padStart(2,"0")).join("");
      const base        = sanitizeWorkerUrl(workerUrl);
      const oldToken    = localStorage.getItem("soltrack_user_token") ?? "";

      // Get nonce for new wallet
      const nonceRes = await fetch(`${base}/auth/nonce?pubkey=${pubkeyHex}`);
      if (!nonceRes.ok) throw new Error("Worker unreachable");
      const { message } = await nonceRes.json();

      // Sign with new wallet
      const msgBytes = new TextEncoder().encode(message);
      const signed   = await provider.signMessage(msgBytes, "utf8");
      const sigHex   = Array.from(signed.signature).map(b => b.toString(16).padStart(2,"0")).join("");

      // Call migrate — passes old JWT + new wallet proof
      const res = await fetch(`${base}/auth/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${oldToken}` },
        body: JSON.stringify({ pubkey: pubkeyHex, signature: sigHex, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Migration failed");

      localStorage.setItem("soltrack_user_token", data.token);
      setPhase("done");
    } catch (e) {
      setPhase("error"); setErrMsg(e.message);
    }
  };

  if (phase === "idle") return (
    <button onClick={() => setPhase("confirm")}
      style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim, ...mono,
        fontSize: 9, padding: "7px 14px", cursor: "pointer", letterSpacing: ".08em" }}
      onMouseEnter={e => e.currentTarget.style.borderColor = S.accentGreen}
      onMouseLeave={e => e.currentTarget.style.borderColor = S.borderColor}>
      MIGRATE TO NEW AUTH WALLET
    </button>
  );

  if (phase === "confirm") return (
    <div style={{ border: `1px solid ${S.borderColor}`, padding: "12px 14px" }}>
      <div style={{ ...mono, fontSize: 9, color: S.textDim, marginBottom: 10, lineHeight: 1.7 }}>
        Connect the wallet you want to use as your new sign-in identity.<br/>
        Your Helius key and all tracked wallets will carry over automatically.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={doMigrate}
          style={{ background: "none", border: `1px solid ${S.accentGreen}55`, color: S.accentGreen, ...mono,
            fontSize: 9, padding: "6px 14px", cursor: "pointer" }}>
          CONNECT NEW WALLET
        </button>
        <button onClick={() => setPhase("idle")}
          style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim, ...mono,
            fontSize: 9, padding: "6px 12px", cursor: "pointer" }}>
          CANCEL
        </button>
      </div>
    </div>
  );

  if (phase === "signing") return (
    <div style={{ ...mono, fontSize: 9, color: S.textDim }}>Waiting for wallet signature...</div>
  );

  if (phase === "done") return (
    <div style={{ ...mono, fontSize: 9, color: S.accentGreen, lineHeight: 1.6 }}>
      ✓ Auth wallet migrated. Your new wallet is now the sign-in identity.<br/>
      <span style={{ color: S.textDim }}>No data was lost — all wallets and trades remain intact.</span>
    </div>
  );

  return (
    <div style={{ ...mono, fontSize: 9, color: S.accentRed }}>
      Error: {errMsg}
      <button onClick={() => setPhase("idle")} style={{ background: "none", border: "none", color: S.textDim, cursor: "pointer", marginLeft: 8, fontSize: 9 }}>retry</button>
    </div>
  );
}

function HeliusKeyField({ S, setSetting }) {
  const [heliusInput, setHeliusInput] = useState(S.heliusKey ?? "");
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState("");
  const mono = { fontFamily: "'DM Mono',monospace" };
  useEffect(() => { setHeliusInput(S.heliusKey ?? ""); }, [S.heliusKey]);
  const saveKey = async (val) => {
    const trimmed = val.trim();
    if (!trimmed || trimmed === S.heliusKey) return;
    setKeySaving(true); setKeyStatus("");
    try {
      const base = sanitizeWorkerUrl(S.workerUrl);
      const token = localStorage.getItem("soltrack_user_token") ?? "";
      const res = await fetch(`${base}/auth/setup-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ heliusKey: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSetting("heliusKey", trimmed);
      setKeyStatus("saved");
      setTimeout(() => setKeyStatus(""), 2000);
    } catch {
      setKeyStatus("error");
      setTimeout(() => setKeyStatus(""), 3000);
    } finally { setKeySaving(false); }
  };
  const unchanged = heliusInput === S.heliusKey;
  return (
    <>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="sinp" placeholder="your-helius-api-key" type="password"
          value={heliusInput}
          onChange={e => { setHeliusInput(e.target.value); setKeyStatus(""); }}
          onBlur={e => saveKey(e.target.value)}
          onKeyDown={e => e.key === "Enter" && saveKey(heliusInput)}
          style={{ ...mono }} />
        <button onClick={() => saveKey(heliusInput)}
          disabled={keySaving || !heliusInput.trim() || unchanged} className="sb"
          style={{ padding: "8px 14px",
            borderColor: keyStatus === "saved" ? S.accentGreen : keyStatus === "error" ? S.accentRed : S.accentGreen + "44",
            color: keyStatus === "saved" ? S.accentGreen : keyStatus === "error" ? S.accentRed : S.accentGreen,
            opacity: (keySaving || !heliusInput.trim() || unchanged) ? 0.4 : 1,
            "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }}>
          {keySaving ? "…" : keyStatus === "saved" ? "✓ SAVED" : keyStatus === "error" ? "✗ FAIL" : "SAVE"}
        </button>
        {S.heliusKey && (
          <button onClick={() => { setSetting("heliusKey", ""); setHeliusInput(""); }} className="sb"
            style={{ padding: "8px 10px", borderColor: S.accentRed + "44", color: S.accentRed,
              "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }}>CLR</button>
        )}
      </div>
      {keyStatus === "error" && (
        <div style={{ color: S.accentRed, fontSize: 9, ...mono, marginTop: 4 }}>
          Failed to update on server — check connection.
        </div>
      )}
    </>
  );
}

function SettingsPanel({ S, setSetting, setS }) {
  const orb = { fontFamily: "'Orbitron',monospace" };
  const mono = { fontFamily: "'DM Mono',monospace" };

  // ── Export/Import presets (heliusKey is NEVER exported — it's a secret API key)
  const PRESET_SKIP_KEYS = ["heliusKey", "appSecret", "userToken"];
  const exportPreset = () => {
    const safe = Object.fromEntries(Object.entries(S).filter(([k]) => !PRESET_SKIP_KEYS.includes(k)));
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `soltrack-preset-${Date.now()}.json`; a.click();
  };
  const importPreset = () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json";
    inp.onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader(); r.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          // Strip secret keys from imported file, preserve current heliusKey
          PRESET_SKIP_KEYS.forEach(k => delete parsed[k]);
          const merged = { ...DEFAULT_SETTINGS, ...parsed, heliusKey: S.heliusKey, appSecret: S.appSecret };
          setS(merged);
          saveLS("soltrack_settings", merged);
        } catch { alert("Invalid preset file"); }
      }; r.readAsText(file);
    }; inp.click();
  };

  const exportWallets = () => {
    const data = wallets.map(w => ({
      address:    w.address,
      label:      w.label,
      colorIdx:   w.colorIdx,
      archived:   w.archived   ?? false,
      excludeAll: w.excludeAll ?? false,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `soltrack-wallets-${Date.now()}.json`;
    a.click();
  };

  const importWallets = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json";
    inp.onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = async (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (!Array.isArray(parsed)) { alert("Invalid wallet file — expected an array."); return; }
          const existing = new Set(wallets.map(w => w.address));
          const maxColor = wallets.length ? Math.max(...wallets.map(w => w.colorIdx ?? 0)) + 1 : 0;
          const toAdd = parsed
            .filter(w => w.address && !existing.has(w.address))
            .map((w, i) => ({
              id:         `w_imp_${Date.now()}_${i}`,
              address:    w.address,
              label:      w.label ?? w.address.slice(0, 8),
              colorIdx:   w.colorIdx ?? (maxColor + i),
              archived:   w.archived   ?? false,
              excludeAll: w.excludeAll ?? false,
              trades: [], loaded: false,
            }));
          if (!toAdd.length) { alert("No new wallets to import."); return; }
          setWallets(prev => [...prev, ...toAdd]);
          toAdd.forEach(w => runFetch(w.id, w.address));
        } catch { alert("Invalid wallet file."); }
      };
      r.readAsText(file);
    };
    inp.click();
  };

  // ── Graph shape rules editor
  const rules = S.graphShapeRules ?? DEFAULT_SETTINGS.graphShapeRules;
  const setRules = (r) => setSetting("graphShapeRules", r);
  const addRule = () => setRules([...rules, { dir: "above", threshold: 0, shape: "circle", size: 8 }]);
  const delRule = (i) => setRules(rules.filter((_, j) => j !== i));
  const updRule = (i, k, v) => setRules(rules.map((r, j) => j === i ? { ...r, [k]: v } : r));

  const sectionTitle = (t) => (
    <div className="ts-mono" style={{ ...orb, fontSize: 10, color: "#fff", letterSpacing: ".14em", marginBottom: 14 }}>{t}</div>
  );
  const fieldLabel = (t) => (
    <div className="ts-mono" style={{ color: S.textMid, fontSize: 10, letterSpacing: ".08em", marginBottom: 6 }}>{t}</div>
  );
  const divider = { borderBottom: `1px solid ${S.borderColor}` };
  const sbtn = (label, onClick, accent) => (
    <button onClick={onClick} style={{
      background: "none", border: `1px solid ${accent ?? S.borderColor}`,
      color: accent ?? S.textMid, cursor: "pointer", padding: "7px 14px",
      ...mono, fontSize: 10, letterSpacing: ".08em"
    }}>{label}</button>
  );

  return (
    <div className="fade-up" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

      {/* LEFT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Colors */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("COLORS")}
          {[
            ["Profit / green", "accentGreen"], ["Loss / red", "accentRed"],
            ["Best day", "accentBest"],
            ["Background", "bgBase"], ["Card", "bgCard"],
            ["Border", "borderColor"], ["Text primary", "textPrimary"], ["Text mid", "textMid"], ["Text dim", "textDim"],
          ].map(([l, k]) => <ColorRow key={k} label={l} k={k} S={S} onChange={setSetting} />)}
        </BorderCard>

        {/* Wallet colors */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("WALLET COLORS")}
          <div style={{ fontSize: 9, color: S.textDim, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>
            Double-click a wallet name to rename and pick its color from this swatch.
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
            {S.walletColors.map((c, i) => (
              <div key={i} style={{ position: "relative", width: 24, height: 24 }}
                onMouseEnter={e => e.currentTarget.querySelector(".del-btn").style.opacity = "1"}
                onMouseLeave={e => e.currentTarget.querySelector(".del-btn").style.opacity = "0"}>
                <div style={{ width: 24, height: 24, background: c, border: `1px solid ${S.borderColor}`, cursor: "pointer", position: "relative", overflow: "hidden" }}>
                  <input type="color" value={c}
                    onChange={e => { const n = [...S.walletColors]; n[i] = e.target.value; setSetting("walletColors", n); }}
                    style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }} />
                </div>
                {S.walletColors.length > 1 && (
                  <button className="del-btn"
                    onMouseDown={e => { e.preventDefault(); const n = S.walletColors.filter((_, j) => j !== i); setSetting("walletColors", n); }}
                    style={{ position: "absolute", top: -5, right: -5, width: 12, height: 12,
                      background: S.accentRed, border: "none", borderRadius: "50%",
                      color: "#fff", fontSize: 8, lineHeight: 1, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      opacity: 0, transition: "opacity .1s", padding: 0 }}>×</button>
                )}
              </div>
            ))}
            {/* Add color button — onBlur not onChange to avoid adding on every drag step */}
            <div style={{ position: "relative", width: 24, height: 24,
              border: `1px dashed ${S.borderColor}`, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: S.textDim, fontSize: 14, overflow: "hidden" }}
              title="Pick a color to add">
              +
              <input type="color" defaultValue="#00ff55"
                onBlur={e => { setSetting("walletColors", [...S.walletColors, e.target.value]); e.target.value = "#00ff55"; }}
                style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }} />
            </div>
          </div>
        </BorderCard>

        {/* Graph shape rules */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("GRAPH — POINT SHAPES")}
          <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={!!S.graphShapeNormalize} onChange={e => setSetting("graphShapeNormalize", e.target.checked)}
                style={{ accentColor: S.accentGreen }} />
              <span style={{ ...mono, fontSize: 10, color: S.textMid }}>Normalize shape size to PnL magnitude</span>
            </label>
          </div>
          <div style={{ fontSize: 9, color: S.textDim, ...mono, marginBottom: 10 }}>
            Rules are evaluated top-to-bottom. First match wins.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rules.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: `1px solid ${S.borderColor}22`, background: `${S.bgBase}88` }}>
                {/* dir */}
                <select value={r.dir} onChange={e => updRule(i, "dir", e.target.value)}
                  style={{ background: S.bgCard, border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono, fontSize: 9, padding: "2px 4px" }}>
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
                {/* threshold */}
                <input type="number" step="0.01" value={r.threshold}
                  onChange={e => updRule(i, "threshold", +e.target.value)}
                  style={{ width: 64, background: S.bgCard, border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono, fontSize: 9, padding: "2px 5px" }} />
                <span style={{ color: S.textDim, fontSize: 9, ...mono }}>SOL →</span>
                {/* shape */}
                <select value={r.shape} onChange={e => updRule(i, "shape", e.target.value)}
                  style={{ background: S.bgCard, border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono, fontSize: 9, padding: "2px 4px" }}>
                  {SHAPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {/* size */}
                <input type="number" min="4" max="32" value={r.size}
                  onChange={e => updRule(i, "size", +e.target.value)}
                  style={{ width: 46, background: S.bgCard, border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono, fontSize: 9, padding: "2px 5px" }} />
                <span style={{ color: S.textDim, fontSize: 9, ...mono }}>px</span>
                <button onClick={() => delRule(i)} style={{ background: "none", border: "none", color: S.accentRed, cursor: "pointer", fontSize: 12, padding: "0 4px", marginLeft: "auto" }}>✕</button>
              </div>
            ))}
          </div>
          <button onClick={addRule} style={{ marginTop: 10, background: "none", border: `1px dashed ${S.borderColor}`, color: S.textDim,
            ...mono, fontSize: 9, padding: "5px 14px", cursor: "pointer", width: "100%" }}>
            + ADD RULE
          </button>
        </BorderCard>
      </div>

      {/* RIGHT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Visuals */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("VISUALS")}
          <SliderRow label="UI Scale — scales everything including text" k="uiZoom" min={0.7} max={1.6} step={0.05} S={S} onChange={setSetting} />
          <SliderRow label="Text Scale — text only, does not move layout" k="textScale" min={0.8} max={1.6} step={0.05} S={S} onChange={setSetting} />
          <SliderRow label="Sidebar width"      k="sidebarWidth"       min={140} max={320}  step={10}   S={S} onChange={setSetting} />
          <SliderRow label="Graph height"        k="graphHeight"        min={140} max={600}  step={10}   S={S} onChange={setSetting} />
          <SliderRow label="Graph detail (LOD) — lower = faster with many trades" k="graphLodPoints" min={30} max={600} step={10} S={S} onChange={setSetting} />
          <SliderRow label="Spotlight width"    k="spotlightWidth"     min={0}   max={1000} step={10}   S={S} onChange={setSetting} />
          <SliderRow label="Spotlight opacity"  k="spotlightOpacity"   min={0}   max={1}    step={0.05} S={S} onChange={setSetting} />
          <div style={{ color: S.textDim, fontSize: 9, marginTop: 6, fontFamily: "'DM Mono',monospace", lineHeight: 1.6 }}>
            Zoom: <span style={{ color: S.accentGreen }}>{((S.uiZoom ?? 1) * 100).toFixed(0)}%</span>
            {" · "}Text: <span style={{ color: S.accentGreen }}>{((S.textScale ?? 1) * 100).toFixed(0)}%</span>
            {" · "}Sidebar: <span style={{ color: S.accentGreen }}>{S.sidebarWidth ?? 210}px</span>
            <span style={{ color: S.textDim }}> — zoom scales all, text scales text only</span>
          </div>
        </BorderCard>

        {/* Graph */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("GRAPH")}
          <SliderRow label="Line width" k="graphLineWidth" min={1} max={6} step={0.5} S={S} onChange={setSetting} />
          <label style={{ display:"flex", alignItems:"center", gap:8, marginTop:10, cursor:"pointer" }}>
            <input type="checkbox" checked={!!S.graphMergeTokens}
              onChange={e => setSetting("graphMergeTokens", e.target.checked)}
              style={{ accentColor: S.accentGreen }} />
            <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:S.textMid, lineHeight:1.5 }}>
              Merge same-token positions across wallets into one point
              <span style={{ display:"block", color:S.textDim, fontSize:8 }}>
                Tooltip shows per-wallet breakdown. Respects active wallet selection.
              </span>
            </span>
          </label>
        </BorderCard>

        {/* Currency */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("DISPLAY CURRENCY")}
          <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginBottom: 10, lineHeight: 1.6 }}>
            All SOL amounts convert using live rates.
            {S.currency !== "SOL" && _solUsd && (
              <span style={{ color: S.accentGreen, marginLeft: 6 }}>1 SOL = ${fmt(_solUsd, 2)}</span>
            )}
            {S.currency !== "SOL" && !_solUsd && (
              <span style={{ color: S.accentFee, marginLeft: 6 }}>loading…</span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {["SOL", "USD", "EUR", "PLN", "UAH", "GBP", "KZT"].map(cur => (
              <button key={cur} onClick={() => setSetting("currency", cur)}
                style={{ background: S.currency === cur ? `${S.accentGreen}18` : "none",
                  fontFamily: "'DM Mono',monospace",
                  border: `1px solid ${S.currency === cur ? S.accentGreen : S.borderColor}`,
                  color: S.currency === cur ? S.accentGreen : S.textDim,
                  cursor: "pointer", padding: "4px 12px", fontSize: 9, letterSpacing: ".08em",
                  transition: "all .12s" }}>
                {cur} {CURRENCY_SYMBOLS[cur] ?? ""}
              </button>
            ))}
          </div>
        </BorderCard>

        {/* General */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("CONNECTION")}
          <div style={{ marginBottom: 12 }}>
            {fieldLabel("HELIUS API KEY")}
            <HeliusKeyField S={S} setSetting={setSetting} />
            <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>
              Get a free key at <a href="https://helius.dev" target="_blank" rel="noopener"
                style={{ color: S.accentGreen }}>helius.dev</a> → Dashboard → API Keys
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            {fieldLabel("WORKER URL")}
            <div style={{ display: "flex", gap: 6 }}>
              <input className="sinp" placeholder="https://soltrack.YOUR-NAME.workers.dev"
                value={S.workerUrl} onChange={e => setSetting("workerUrl", sanitizeWorkerUrl(e.target.value))}
                onBlur={e => { saveLS("soltrack_settings", { ...loadLS("soltrack_settings",{}), workerUrl: sanitizeWorkerUrl(e.target.value) }); }} />
              {S.workerUrl !== DEFAULT_WORKER_URL && S.workerUrl && (
                <button onClick={() => setSetting("workerUrl", DEFAULT_WORKER_URL)} className="sb"
                  style={{ padding: "8px 12px", borderColor: S.accentRed + "44", color: S.accentRed,
                    "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }}>↺</button>
              )}
            </div>
            <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginTop: 4 }}>
              Default: <span style={{ color: S.textMid }}>{DEFAULT_WORKER_URL}</span>
            </div>
          </div>

          <div style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              {fieldLabel("PRIVACY MODE")}
              <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginTop: 2 }}>
                Blurs wallet addresses in sidebar
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", flexShrink: 0 }}>
              <input type="checkbox" checked={!!S.privacyMode}
                onChange={e => setSetting("privacyMode", e.target.checked)}
                style={{ accentColor: S.accentGreen, cursor: "pointer", width: 14, height: 14 }} />
              <span style={{ color: S.privacyMode ? S.accentGreen : S.textDim, fontFamily: "'DM Mono',monospace", fontSize: 9 }}>
                {S.privacyMode ? "ON" : "OFF"}
              </span>
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            {fieldLabel("AUTH WALLET")}
            <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>
              Switch to a different wallet for signing in. Your data carries over automatically.
            </div>
            <MigrateWalletButton S={S} workerUrl={S.workerUrl} />
          </div>

          <div style={{ marginBottom: 12 }}>
            {fieldLabel("TIMEZONE — affects how days are grouped")}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="range" min="-12" max="14" step="0.5" value={S.tzOffset ?? 0}
                onChange={e => setSetting("tzOffset", +e.target.value)}
                style={{ flex: 1, accentColor: S.accentGreen }} />
              <span style={{ color: S.accentGreen, fontFamily: "'DM Mono',monospace", fontSize: 11, minWidth: 48, textAlign: "right" }}>
                {(S.tzOffset ?? 0) >= 0 ? "+" : ""}{S.tzOffset ?? 0}h
              </span>
            </div>
            <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginTop: 3 }}>
              Poland +1/+2 · Tbilisi +4 · UTC 0
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            {fieldLabel("TOKEN LINK — where tickers open on click")}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {TERMINALS.map(t => (
                <button key={t.id} onClick={() => setSetting("terminalId", t.id)}
                  style={{ background: "none", border: `1px solid ${S.terminalId === t.id ? S.accentGreen : S.borderColor}`,
                    color: S.terminalId === t.id ? S.accentGreen : S.textDim, cursor: "pointer",
                    padding: "4px 10px", ...mono, fontSize: 9, letterSpacing: ".06em" }}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            {fieldLabel("HISTOGRAM DECIMAL PLACES")}
            <input type="number" min="1" max="9" value={S.pnlHistoDecimals ?? 4}
              onChange={e => setSetting("pnlHistoDecimals", Math.max(1, Math.min(9, +e.target.value)))}
              style={{ width: "100%", background: S.bgCard, border: `1px solid ${S.borderColor}`,
                color: S.textMid, ...mono, fontSize: 11, padding: "6px 8px" }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={S.shareButtonRankColor ?? true}
              onChange={e => setSetting("shareButtonRankColor", e.target.checked)}
              style={{ accentColor: S.accentGreen }} />
            <span style={{ ...mono, fontSize: 10, color: S.textMid }}>Share button uses rank color</span>
          </label>
        </BorderCard>

        {/* Backup & reset */}
        <BorderCard S={S} style={{ padding: "18px 20px" }}>
          {sectionTitle("BACKUP & RESET")}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {sbtn("EXPORT SETTINGS", exportPreset, S.accentGreen)}
            {sbtn("IMPORT SETTINGS", importPreset, S.accentPurple)}
          </div>
          <div style={{ ...mono, fontSize: 8, color: S.textDim, letterSpacing: ".1em", marginBottom: 6 }}>
            WALLETS
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {sbtn("EXPORT WALLETS", exportWallets, S.accentGreen)}
            {sbtn("IMPORT WALLETS", importWallets, S.accentPurple)}
          </div>
          <div style={{ color: S.textDim, fontSize: 9, fontFamily: "'DM Mono',monospace", marginBottom: 12, lineHeight: 1.6 }}>
            Export your wallet list as JSON to transfer between devices or domains.
            Import adds wallets not already present — existing wallets are untouched.
          </div>
          <div style={{ paddingTop: 12, borderTop: `1px solid ${S.borderColor}`, display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={() => setS(DEFAULT_SETTINGS)}
              style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textMid, ...mono,
                fontSize: 10, padding: "8px 14px", cursor: "pointer", letterSpacing: ".08em", alignSelf: "flex-start", transition: "border-color .15s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = S.accentRed}
              onMouseLeave={e => e.currentTarget.style.borderColor = S.borderColor}>
              RESET TO DEFAULTS
            </button>
            <div style={{ borderTop: `1px solid ${S.borderColor}`, paddingTop: 12, marginTop: 4 }}>
              <div style={{ ...mono, fontSize: 9, color: S.textDim, marginBottom: 8, lineHeight: 1.6 }}>
                <span style={{ color: S.accentRed }}>DANGER ZONE</span>
                {" — "}Permanently deletes all your trades and wallet data from the server.
                Your local wallet list stays intact. Use this if you want a clean start or are leaving SOLTRACK.
              </div>
              <ResetMyDataButton S={S} workerUrl={S.workerUrl} appSecret={S.appSecret} />
            </div>
          </div>
        </BorderCard>
      </div>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [S, setS] = useState(() => {
    const saved = loadLS("soltrack_settings", {});
    const { pnlRanks: _dropped, ...rest } = saved; // never load ranks from localStorage
    // Migrate: if stored workerUrl is empty, use the hardcoded default
    if (!rest.workerUrl) rest.workerUrl = DEFAULT_WORKER_URL;
    return { ...DEFAULT_SETTINGS, ...rest };
  });

  // Client token — generated once, persisted in localStorage.
  // Ties this browser to its server data. Used to wipe data if needed.
  const clientToken = useMemo(() => {
    const existing = localStorage.getItem("soltrack_client_token");
    if (existing) return existing;
    const newToken = crypto.randomUUID();
    localStorage.setItem("soltrack_client_token", newToken);
    return newToken;
  }, []);
  const setSetting = useCallback((k, v) => setS((p) => {
    const next = { ...p, [k]: v };
    // Don't persist ranks to localStorage — they are server-authoritative
    const { pnlRanks: _dropped, ...toSave } = next;
    saveLS("soltrack_settings", toSave);
    return next;
  }), []);

  // Favicon: black square with accent-green inner square
  useEffect(() => {
    const size = 32;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    const green = S.accentGreen || "#00ff7b";
    const pad = 8;
    ctx.fillStyle = green;
    ctx.shadowColor = green;
    ctx.shadowBlur = 4;
    ctx.fillRect(pad, pad, size - pad * 2, size - pad * 2);
    const url = cv.toDataURL("image/png");
    let link = document.querySelector("link[rel~='icon']");
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = url;
  }, [S.accentGreen]);
  // Fetch SOL price + fiat rates on mount and whenever currency changes
  const [, forceRateRefresh] = useState(0);
  useEffect(() => {
    fetchRates().then(() => forceRateRefresh(n => n + 1));
    const id = setInterval(() => fetchRates().then(() => forceRateRefresh(n => n + 1)), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [S.currency]);

  // Fetch ranks from worker on load so all users see admin-configured card styles
  useEffect(() => {
    if (!S.workerUrl) return;
    const base = sanitizeWorkerUrl(S.workerUrl);
    fetch(`${base}/ranks`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.ranks?.length) return;
        // Restore -Infinity sentinel (stored as string "-Infinity" to survive JSON round-trip)
        const ranks = data.ranks.map(r => ({ ...r, min: r.min === "-Infinity" || r.min === null ? -Infinity : r.min }));
        setSetting("pnlRanks", ranks);
      })
      .catch(() => {}); // silently ignore if worker unreachable
  }, [S.workerUrl]);
  const [tab, setTab] = useState("dashboard");
  // Multi-wallet selection: Set of wallet IDs, or "combined" meaning all
  const [activeWallets, setActiveWallets] = useState(new Set(["combined"]));  const [tf, setTF] = useState("TODAY");
  const [customDay, setCustomDay] = useState(null); // "YYYY-MM-DD" or null
  const [showDayPicker, setShowDayPicker] = useState(false);
  // Shared graph zoom/pan — synced between PnlGraph and histogram
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan,  setGraphPan]  = useState(0);

  const toggleWallet = useCallback((id) => {
    setActiveWallets(prev => {
      const next = new Set(prev);
      if (id === "combined") {
        // combined = select all; if already all-combined, stay combined
        return new Set(["combined"]);
      }
      // Remove "combined" when picking individual wallets
      next.delete("combined");
      if (next.has(id)) {
        next.delete(id);
        // If nothing left, fall back to combined
        if (next.size === 0) return new Set(["combined"]);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const [newAddr, setNA] = useState("");
  const [newLabel, setNL] = useState("");
  const [showAdd, setSA] = useState(false);
  const [apiKeyInput, setAKI] = useState("");

  const { wallets, loading, errors, syncStates, syncing, addWallet, removeWallet, refreshWallet, syncHistory, updateWallet } = useWalletData(S, clientToken);
  const sessionExpired = Object.values(errors).some(e => e === "SESSION_EXPIRED");



  // Reclaimable rent — sum of empty token accounts across selected wallets
  const [reclaimable, setReclaimable] = useState(null); // { sol, accounts }
  useEffect(() => {
    if (!S.workerUrl || !wallets.length) return;
    let cancelled = false;
    const base = sanitizeWorkerUrl(S.workerUrl);
    const userToken = localStorage.getItem("soltrack_user_token") ?? ""; const headers = { ...(userToken ? { "Authorization": `Bearer ${userToken}` } : {}) };
    const isCombined = activeWallets.has("combined");
    const selected = isCombined
      ? wallets.filter(w => !(w.excludeAll ?? false))
      : wallets.filter(w => activeWallets.has(w.id));
    setReclaimable(null);
    Promise.allSettled(selected.map(w =>
      fetch(`${base}/open-accounts`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ address: w.address, heliusKey: S.heliusKey || undefined }) })
        .then(r => r.ok ? r.json() : null)
    )).then(results => {
      if (cancelled) return;
      let sol = 0, accounts = 0;
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        sol      += r.value.reclaimableSol  || 0;
        accounts += r.value.emptyAccounts   || 0;
      }
      setReclaimable({ sol: +sol.toFixed(6), accounts });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [S.workerUrl, wallets.length, activeWallets, S.heliusKey]);

  const pnlColor = (n) => n > 0 ? S.accentGreen : n < 0 ? S.accentRed : S.textMid;
  const getColor = (w) => S.walletColors[w.colorIdx % S.walletColors.length];

  const rawTrades = useMemo(() => {
    const isCombined = activeWallets.has("combined");
    let selected;
    if (isCombined) {
      // ALL: include all wallets except those explicitly excluded
      selected = wallets.filter(w => !(w.excludeAll ?? false));
    } else {
      // Manual selection: include exactly the selected wallets (archived ones can be manually picked)
      selected = wallets.filter(w => activeWallets.has(w.id));
    }
    const all = selected.flatMap(w => w.trades.map(t => t.wallet ? t : { ...t, wallet: w.address }));
    const sorted = [...all].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    return sorted;
  }, [activeWallets, wallets]);

  // Always build curve from FULL history — positions need complete buy/sell history to be accurate
  const fullCurve = useMemo(() => S.graphMergeTokens ? buildMergedCurve(rawTrades) : buildCurve(rawTrades), [rawTrades, S.graphMergeTokens]);

  // Filter curve points by their closeTs to get the selected time window
  const pnlCurve = useMemo(() => {
    if (tf === "ALL" && !customDay) return fullCurve;
    const nowUTC = Date.now();
    const nowLocal = nowUTC + (S.tzOffset ?? 0) * 3600000;
    const d = new Date(nowLocal);
    let windowStart, windowEnd;
    if (customDay) {
      const [cy, cm, cd] = customDay.split("-").map(Number);
      windowStart = Date.UTC(cy, cm - 1, cd) - (S.tzOffset ?? 0) * 3600000;
      windowEnd   = windowStart + 86400000;
    } else if (tf === "TODAY") {
      windowStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (S.tzOffset ?? 0) * 3600000;
      windowEnd = Infinity;
    } else if (tf === "YESTERDAY") {
      const todayMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (S.tzOffset ?? 0) * 3600000;
      windowStart = todayMidnight - 86400000;
      windowEnd   = todayMidnight;
    } else if (tf === "WEEK") {
      windowStart = nowUTC - 7 * 86400000;
      windowEnd = Infinity;
    } else if (tf === "MONTH") {
      windowStart = nowUTC - 30 * 86400000;
      windowEnd = Infinity;
    } else {
      return fullCurve;
    }
    // Keep only curve points (closed trades) that closed within the window
    const windowPoints = fullCurve.slice(1).filter(p => p.closeTs >= windowStart && p.closeTs < windowEnd);
    // Recalculate cumPnl from 0 for this window — stables don't advance cum
    let cum = 0;
    const result = [{ label: "START", idx: 0, cumPnl: 0, tradePnl: 0, fee: 0 }];
    for (const p of windowPoints) {
      const pStable = p.isStable ?? isStablecoin(p.mint, p.token);
      if (!pStable) cum = +(cum + p.tradePnl).toFixed(4);
      result.push({ ...p, cumPnl: cum, idx: result.length });
    }
    return result;
  }, [fullCurve, tf, S.tzOffset, customDay]);

  const filtered = useMemo(() => filterByTime(rawTrades, tf, S.tzOffset ?? 0, customDay), [rawTrades, tf, S.tzOffset, customDay]);

  const closed = pnlCurve.slice(1);
  const closedNonStable = closed.filter(p => !(p.isStable ?? isStablecoin(p.mint, p.token)));
  // Single source of truth: pnlCurve last cumPnl (stables don't advance it)
  const totalPnl = pnlCurve[pnlCurve.length - 1]?.cumPnl ?? 0;
  const wins = closedNonStable.filter((p) => p.tradePnl > 0).length;
  const winRate = closedNonStable.length ? ((wins / closedNonStable.length) * 100).toFixed(2) : "0.00";
  const buyCount  = filtered.filter(t => t.type === "buy").length;
  const sellCount = filtered.filter(t => t.type === "sell").length;

  // Reset graph zoom when the underlying data changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setGraphZoom(1); setGraphPan(0); }, [pnlCurve]);

  // Histogram slice: same window as graph zoom/pan
  const histoClosed = useMemo(() => {
    // Get window slice (zoom-synced with graph)
    let slice = closed;
    if (graphZoom > 1) {
      const n = pnlCurve.length;
      const visible = Math.max(2, Math.round(n / graphZoom));
      const maxPan = Math.max(0, n - visible);
      const clamped = Math.max(0, Math.min(graphPan, maxPan));
      const startIdx = Math.floor(clamped);
      const endIdx   = Math.min(n - 1, startIdx + visible - 1);
      slice = closed.slice(Math.max(0, startIdx - 1), endIdx);
    }
    // Apply same LOD decimation as PnlGraph
    const MAX_PTS = S.graphLodPoints ?? 300;
    if (slice.length <= MAX_PTS) return slice;
    const bucketSize = slice.length / MAX_PTS;
    const result = [slice[0]];
    for (let b = 0; b < MAX_PTS - 1; b++) {
      const lo = Math.floor(b * bucketSize);
      const hi = Math.floor((b + 1) * bucketSize);
      const bucket = slice.slice(lo, hi);
      if (!bucket.length) continue;
      let minPt = bucket[0], maxPt = bucket[0];
      for (const pt of bucket) {
        if (pt.tradePnl < minPt.tradePnl) minPt = pt;
        if (pt.tradePnl > maxPt.tradePnl) maxPt = pt;
      }
      if (minPt === maxPt) result.push(minPt);
      else result.push(minPt, maxPt);
    }
    result.push(slice[slice.length - 1]);
    return result.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  }, [closed, pnlCurve, graphZoom, graphPan, S.graphLodPoints]);

  const isCombined = activeWallets.has("combined");
  const singleWallet = !isCombined && activeWallets.size === 1
    ? wallets.find(w => activeWallets.has(w.id)) : null;
  const activeColor = isCombined || activeWallets.size > 1
    ? S.accentPurple
    : singleWallet ? getColor(singleWallet) : S.accentGreen;

  const isLoading = Object.keys(loading).length > 0;

  const [showShareModal, setShowShareModal] = useState(false);
  const [shareContext, setShareContext] = useState(null); // null = full, { date } = day/month filter
  const doShare = useCallback(() => { setShareContext(null); setShowShareModal(true); }, []);
  const doShareDay = useCallback((dateKey) => { setShareContext({ dateKey }); setShowShareModal(true); }, []);
  const [selectedToken, setSelectedToken] = useState(null); // { mint, token } or null

  const doAdd = () => {
    if (!newAddr.trim()) return;
    addWallet(newAddr.trim(), newLabel || `Wallet ${wallets.length + 1}`, wallets.length);
    setNA(""); setNL(""); setSA(false);
  };

  // ── ADMIN ROUTE ──────────────────────────────────────────────────────────────
  if (window.location.pathname === "/admin") {
    return <AdminPanel S={S} setSetting={setSetting} />;
  }

  // ── ONBOARDING GATE ──────────────────────────────────────────────────────────
  const userToken = useMemo(() => localStorage.getItem("soltrack_user_token") ?? "", []);
  if (!userToken) {
    const isRelogin = localStorage.getItem("soltrack_relogin") === "1";
    return <Onboarding S={S} workerUrl={S.workerUrl} relogin={isRelogin} onComplete={(token) => {
      localStorage.removeItem("soltrack_relogin");
      localStorage.setItem("soltrack_user_token", token);
      window.location.reload();
    }} />;
  }

  return (
    <div className="ts-ui" style={{ minHeight: "100vh", background: S.bgBase, zoom: S.uiZoom ?? 1 }}>
      {/* Text scale CSS — multiplies all readable text via calc() */}
      <style>{`
        :root { --ts: ${S.textScale ?? 1}; }

        /* Named size classes — exact proportional scaling */
        .ts-label  { font-size: calc(9px  * var(--ts)) !important; }
        .ts-value  { font-size: calc(19px * var(--ts)) !important; }
        .ts-head   { font-size: calc(11px * var(--ts)) !important; }
        .ts-mono   { font-size: calc(10px * var(--ts)) !important; }
        .ts-dim    { font-size: calc(9px  * var(--ts)) !important; }
        .ts-small  { font-size: calc(8px  * var(--ts)) !important; }

        /* Global element selectors */
        td, th             { font-size: calc(10px * var(--ts)) !important; }
        .sinp, .inp        { font-size: calc(11px * var(--ts)) !important; }
        .tab-btn           { font-size: calc(10px * var(--ts)) !important; }
        .tf-btn            { font-size: calc(9px  * var(--ts)) !important; }
        .sb                { font-size: calc(10px * var(--ts)) !important; }
        .lbtn              { font-size: calc(9px  * var(--ts)) !important; }
        .pill              { font-size: calc(9px  * var(--ts)) !important; }

        /* SVG text — only inside .ts-ui but NOT inside .no-ts-scale */
        .ts-ui svg:not(.no-ts-scale) text, .ts-ui svg:not(.no-ts-scale) tspan { font-size: calc(9px * var(--ts)) !important; }

        /* Tooltip portals — fixed positioned overlays */
        .sol-tooltip div, .sol-tooltip span { font-size: calc(10px * var(--ts)) !important; }
        .sol-tooltip .sol-tt-val            { font-size: calc(14px * var(--ts)) !important; }
        .sol-tooltip .sol-tt-head           { font-size: calc(9px  * var(--ts)) !important; }

        /* Broad coverage for unlabelled elements inside app content */
        /* These set approximate sizes — ts-* classes above take precedence */
        .ts-ui button:not([class*="ts-"])    { font-size: calc(9px  * var(--ts)) !important; }
        .ts-ui span:not([class*="ts-"])      { font-size: calc(10px * var(--ts)) !important; }
        .ts-ui a:not([class*="ts-"])         { font-size: calc(10px * var(--ts)) !important; }
        .ts-ui label:not([class*="ts-"])     { font-size: calc(10px * var(--ts)) !important; }
        .ts-ui select                        { font-size: calc(9px  * var(--ts)) !important; }
        .ts-ui input[type="number"]          { font-size: calc(10px * var(--ts)) !important; }
      `}</style>
      <GlobalSpotlight S={S} />

      {/* Share modal */}
      {showShareModal && (() => {
        // If a specific day/month was clicked, filter curve to that period
        let ctxCurve = pnlCurve, ctxClosed = closed, ctxTotalPnl = totalPnl, ctxWinRate = winRate, ctxTf = tf;
        // If a graph point was clicked, filter to that single token across active wallets
        if (shareContext?.tokenPoint) {
          const pt = shareContext.tokenPoint;
          const mint = pt.mint;
          const tokenTrades = rawTrades.filter(t => (t.mint ?? t.token) === mint);
          ctxCurve = buildCurve(tokenTrades);
          ctxClosed = ctxCurve.slice(1).filter(p => !(p.isStable ?? isStablecoin(p.mint, p.token)));
          ctxTotalPnl = ctxCurve[ctxCurve.length-1]?.cumPnl ?? 0;
          const ctxWins = ctxClosed.filter(p => p.tradePnl > 0).length;
          ctxWinRate = ctxClosed.length ? ((ctxWins / ctxClosed.length) * 100).toFixed(2) : "0.00";
          ctxTf = pt.label ?? pt.token ?? "TOKEN";
        }
        if (shareContext?.dateKey) {
          const dk = shareContext.dateKey;
          const isMonth = dk.length === 7; // YYYY-MM
          const tzOff = S.tzOffset ?? 0;
          const toLocalDay = (ts) => {
            const ms = new Date(ts).getTime() + tzOff * 3600000;
            const d = new Date(ms);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
          };
          let dayTrades;
          if (isMonth) {
            // Month: include all trades for positions that closed in this month
            const closedInMonth = new Set();
            const posMap = {};
            for (const t of [...rawTrades].sort((a,b) => new Date(a.ts)-new Date(b.ts))) {
              const k = (t.wallet ?? "") + ":" + (t.mint ?? t.token ?? "");
              if (!posMap[k]) posMap[k] = { trades: [], lastSellDay: null };
              posMap[k].trades.push(t);
              if (t.type === "sell") posMap[k].lastSellDay = toLocalDay(t.ts);
            }
            for (const [k, p] of Object.entries(posMap)) {
              const closeDay = p.lastSellDay ?? (p.trades.length ? toLocalDay(p.trades[p.trades.length-1].ts) : null);
              if (closeDay && closeDay.startsWith(dk)) closedInMonth.add(k);
            }
            dayTrades = rawTrades.filter(t => closedInMonth.has((t.wallet ?? "") + ":" + (t.mint ?? t.token ?? "")));
          } else {
            // Day: include all trades for positions whose last sell was on this day
            const closedOnDay = new Set();
            const posMap = {};
            for (const t of [...rawTrades].sort((a,b) => new Date(a.ts)-new Date(b.ts))) {
              const k = (t.wallet ?? "") + ":" + (t.mint ?? t.token ?? "");
              if (!posMap[k]) posMap[k] = { trades: [], lastSellDay: null };
              posMap[k].trades.push(t);
              if (t.type === "sell") posMap[k].lastSellDay = toLocalDay(t.ts);
            }
            for (const [k, p] of Object.entries(posMap)) {
              const closeDay = p.lastSellDay ?? (p.trades.length ? toLocalDay(p.trades[p.trades.length-1].ts) : null);
              if (closeDay === dk) closedOnDay.add(k);
            }
            dayTrades = rawTrades.filter(t => closedOnDay.has((t.wallet ?? "") + ":" + (t.mint ?? t.token ?? "")));
          }
          ctxCurve = buildCurve(dayTrades);
          ctxClosed = ctxCurve.slice(1).filter(p => !(p.isStable ?? isStablecoin(p.mint, p.token)));
          ctxTotalPnl = ctxCurve[ctxCurve.length-1]?.cumPnl ?? 0;
          const ctxWins = ctxClosed.filter(p => p.tradePnl > 0).length;
          ctxWinRate = ctxClosed.length ? ((ctxWins / ctxClosed.length) * 100).toFixed(2) : "0.00";
          ctxTf = isMonth ? dk.slice(0,7) : dk;
        }
        return (
          <ShareModal
            S={S} setSetting={setSetting} pnlCurve={ctxCurve} closed={ctxClosed}
            totalPnl={ctxTotalPnl} winRate={ctxWinRate} tf={ctxTf}
            walletLabel={isCombined ? `${wallets.length} WALLETS` : singleWallet?.label?.toUpperCase() ?? "WALLET"}
            onClose={() => { setShowShareModal(false); setShareContext(null); }}
          />
        );
      })()}

      {/* HEADER */}
      <div style={{
        borderBottom: `1px solid ${S.borderColor}`, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 28px", height: 52,
        position: "sticky", top: 0, background: `${S.bgBase}f2`, backdropFilter: "blur(10px)", zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 7, height: 7, background: S.accentGreen, boxShadow: `0 0 8px ${S.accentGreen},0 0 18px ${S.accentGreen}55` }} />
          <span style={{ fontFamily: "'Orbitron',monospace", fontWeight: 900, fontSize: 13, letterSpacing: ".2em", color: "#fff" }}>{S.appName}</span>
          {isLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: S.textMid, fontSize: 9 }}>
              <div className="spin-ring" style={{ borderColor: `${S.accentGreen} transparent transparent transparent` }} />
              FETCHING...
            </div>
          )}
        </div>
        <nav style={{ display: "flex" }}>
          {["dashboard", "trades", "calendar", "journal", "settings"].map((t) => (
            <button key={t} className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => { setTab(t); setSelectedToken(null); }}
              style={{ "--accent": S.accentGreen, "--dim": S.textDim, "--mid": S.textMid }}>
              {t}
            </button>
          ))}
        </nav>
        {!S.workerUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              className="inp" style={{ width: 280 }}
              placeholder="https://....workers.dev"
              value={apiKeyInput}
              onChange={(e) => setAKI(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setSetting("workerUrl", sanitizeWorkerUrl(e.target.value)); }}
            />
            <button className="lbtn" onClick={() => setSetting("workerUrl", sanitizeWorkerUrl(apiKeyInput))}
              style={{ "--accent": S.accentGreen }}>
              SAVE
            </button>
          </div>
        )}
        {S.workerUrl && (() => {
          const hasToken = !!localStorage.getItem("soltrack_user_token");
          return (
            <div style={{ fontSize: 9, letterSpacing: ".1em", fontFamily: "'Orbitron',monospace", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 5, height: 5, background: S.accentGreen, borderRadius: "50%" }} />
              <span style={{ color: S.accentGreen }}>{hasToken ? "SIGNED IN" : "CONNECTED"}</span>
              <button
                onClick={() => {
                  localStorage.removeItem("soltrack_user_token");
                  window.location.reload();
                }}
                style={{ background: "none", border: `1px solid ${S.borderColor}`, color: S.textDim,
                  cursor: "pointer", fontSize: 8, padding: "2px 7px", fontFamily: "'DM Mono',monospace",
                  letterSpacing: ".06em" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = S.accentRed}
                onMouseLeave={e => e.currentTarget.style.borderColor = S.borderColor}>
                SIGN OUT
              </button>
            </div>
          );
        })()}
      </div>

      {sessionExpired && (
        <div style={{ background: "#1a0000", borderBottom: "1px solid #ff003355", padding: "10px 24px",
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#ff6666", letterSpacing: ".08em" }}>
            ⚠ Your session has expired (24h limit). Sign out and sign back in to continue.
          </span>
          <button onClick={() => { localStorage.setItem("soltrack_relogin","1"); localStorage.removeItem("soltrack_user_token"); window.location.reload(); }}
            style={{ background: "#ff0033", border: "none", color: "#fff", fontFamily: "'DM Mono',monospace",
              fontSize: 9, padding: "5px 14px", cursor: "pointer", letterSpacing: ".1em", fontWeight: 700 }}>
            SIGN IN AGAIN
          </button>
        </div>
      )}
      <div style={{ display: "flex", maxWidth: 1400, margin: "0 auto", alignItems: "stretch" }}>

        {/* WALLET SIDEBAR */}
        <WalletSidebar
          wallets={wallets} activeWallets={activeWallets}
          setActiveWallets={setActiveWallets} toggleWallet={toggleWallet}
          syncStates={syncStates} syncing={syncing} loading={loading} errors={errors}
          refreshWallet={refreshWallet} syncHistory={syncHistory} removeWallet={removeWallet} updateWallet={updateWallet}
          showAdd={showAdd} setSA={setSA} newAddr={newAddr} setNA={setNA}
          newLabel={newLabel} setNL={setNL} doAdd={doAdd}
          S={S} getColor={getColor} setSetting={setSetting}
        />

        {/* MAIN CONTENT */}
        <div style={{ flex: 1, minWidth: 0, padding: "20px 24px 20px 16px" }}>

        {/* EMPTY STATE */}
        {wallets.length === 0 && tab !== "settings" && (
          <BorderCard S={S} style={{ padding: "48px 32px", textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, color: S.textMid, letterSpacing: ".12em", marginBottom: 12 }}>NO WALLETS ADDED</div>
            <div style={{ color: S.textDim, fontSize: 11, marginBottom: 20, lineHeight: 1.7 }}>
              {S.workerUrl
                ? "Add a Solana wallet address above to fetch real trade data."
                : "Enter your Worker URL in the top-right to load real data, or add a wallet for demo data."}
            </div>
            <button className="lbtn" onClick={() => setSA(true)} style={{ "--accent": S.accentGreen }}>+ ADD WALLET</button>
          </BorderCard>
        )}

        {/* TIME FILTER */}
        {tab !== "settings" && wallets.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
            {TIME_FILTERS.map((f) => (
              <button key={f} className={`tf-btn ${tf === f && !customDay ? "active" : ""}`}
                onClick={() => { setTF(f); setCustomDay(null); setShowDayPicker(false); }}
                style={{ "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen }}>{f}</button>
            ))}
            {/* Custom day picker button */}
            {customDay ? (
              <button className="tf-btn active"
                style={{ "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen,
                  display: "flex", alignItems: "center", gap: 5 }}>
                <span onClick={() => setShowDayPicker(p => !p)} style={{ cursor: "pointer" }}>{customDay}</span>
                <span onClick={() => { setCustomDay(null); setShowDayPicker(false); }}
                  style={{ cursor: "pointer", opacity: 0.6, fontSize: 12, lineHeight: 1 }}>×</span>
              </button>
            ) : (
              <button className={`tf-btn${showDayPicker ? " active" : ""}`}
                onClick={() => setShowDayPicker(p => !p)}
                style={{ "--border": S.borderColor, "--dim": S.textDim, "--mid": S.textMid, "--accent": S.accentGreen,
                  borderStyle: "dashed" }}>
                📅
              </button>
            )}
            {/* Day picker popover */}
            {showDayPicker && !customDay && (
              <div style={{ position: "relative" }}>
                <div style={{ position: "absolute", top: 4, left: 0, zIndex: 200,
                  background: S.bgCard, border: `1px solid ${S.borderColor}`, padding: 4,
                  boxShadow: "0 4px 20px rgba(0,0,0,0.6)" }}>
                  <input type="date"
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={e => { if (e.target.value) { setCustomDay(e.target.value); setShowDayPicker(false); } }}
                    style={{ background: S.bgCard, border: `1px solid ${S.borderColor}`,
                      color: S.textPrimary, fontFamily: "'DM Mono',monospace", fontSize: 11,
                      padding: "4px 8px", cursor: "pointer", colorScheme: "dark" }}
                    autoFocus
                    onBlur={e => { if (!e.currentTarget.value) setShowDayPicker(false); }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* DASHBOARD */}
        {tab === "dashboard" && wallets.length > 0 && (
          <div className="fade-up">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 10 }}>
              {[
                { label: "NET PnL",     val: fmtC(totalPnl, S),   color: pnlColor(totalPnl), sub: "closed positions" },
                { label: "WIN RATE",    val: `${winRate}%`,                             color: +winRate >= 60 ? S.accentGreen : S.accentRed },
                { label: "CLOSED POS",  val: closed.length, color: S.textPrimary,
                  buyC: buyCount, sellC: sellCount },
                { label: "RECLAIMABLE", val: reclaimable ? fmtC(reclaimable.sol, S, 4) : "—",
                  color: reclaimable?.sol > 0 ? S.accentGreen : S.textDim,
                  sub: reclaimable ? `${reclaimable.accounts} empty accounts` : "loading..." },
              ].map((s) => (
                <BorderCard key={s.label} S={S} style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="ts-label" style={{ color: S.textDim, fontSize: 9, letterSpacing: ".14em" }}>{s.label}</div>
                  <div className="ts-value" style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700,
                    fontSize: 19, color: s.color, textShadow: `0 0 14px ${s.color}44`, lineHeight: 1.1 }}>{s.val}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                    {s.buyC != null ? (
                      <div className="ts-dim" style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, letterSpacing: ".06em" }}>
                        <span style={{ color: S.accentGreen }}>{s.buyC}B</span>
                        <span style={{ color: S.textDim }}> · </span>
                        <span style={{ color: S.accentRed }}>{s.sellC}S</span>
                      </div>
                    ) : s.sub ? (
                      <div style={{ color: S.textDim, fontSize: 9, letterSpacing: ".06em" }}>{s.sub}</div>
                    ) : null}
                    {s.label === "RECLAIMABLE" && reclaimable?.sol > 0 && (
                      <a href="https://sol-incinerator.com/?ref=solexe" target="_blank" rel="noopener noreferrer"
                        style={{ marginLeft: "auto", color: S.accentGreen, fontSize: 10,
                          border: `1px solid ${S.accentGreen}44`, padding: "1px 5px",
                          textDecoration: "none" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = S.accentGreen}
                        onMouseLeave={e => e.currentTarget.style.borderColor = `${S.accentGreen}44`}>
                        ↗
                      </a>
                    )}
                  </div>
                </BorderCard>
              ))}
            </div>


            <BorderCard S={S} style={{ padding: "18px 18px 12px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div className="ts-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, color: "#fff", letterSpacing: ".1em", marginBottom: 2 }}>
                    PnL CURVE <span style={{ color: S.textDim, fontWeight: 400, fontSize: 9, marginLeft: 8 }}>PER CLOSED POSITION · NET OF ALL FEES · RENT EXCLUDED</span>
                  </div>
                  <div style={{ fontSize: 9, color: S.textDim, letterSpacing: ".1em" }}>
                    {isCombined ? `${wallets.length} WALLETS COMBINED` : activeWallets.size > 1 ? `${activeWallets.size} WALLETS` : singleWallet?.label?.toUpperCase() ?? ""} · {tf}
                  </div>
                </div>
                {(() => {
                  const rank = getPnlRank(totalPnl, S.pnlRanks);
                  const btnColor = (S.shareButtonRankColor ?? true) ? rank.color : S.textMid;
                  return closed.length > 0 ? (
                    <button onClick={doShare}
                      style={{
                        background: "none", border: `1px solid ${btnColor}55`,
                        color: btnColor, fontFamily: "'DM Mono',monospace",
                        fontSize: 9, letterSpacing: ".12em", padding: "5px 14px",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                        transition: "border-color .15s, box-shadow .15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = btnColor; e.currentTarget.style.boxShadow = `0 0 8px ${btnColor}44`; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = `${btnColor}55`; e.currentTarget.style.boxShadow = "none"; }}>
                      ↗ YOUR RANK: {rank.name} · SHARE
                    </button>
                  ) : null;
                })()}
              </div>
              <PnlGraph data={pnlCurve} color={activeColor} S={S} height={S.graphHeight ?? 315} wallets={wallets}
                zoom={graphZoom} panX={graphPan} onZoomChange={setGraphZoom} onPanChange={setGraphPan}
                onPointClick={(pt) => { setShareContext({ tokenPoint: pt }); setShowShareModal(true); }} />
            </BorderCard>
            <BorderCard S={S} style={{ padding: "16px 16px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                <div className="ts-head" style={{ fontFamily: "'Orbitron',monospace", fontSize: 10, color: "#fff", letterSpacing: ".1em" }}>PnL PER POSITION</div>
                {graphZoom > 1 && (
                  <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 8, color: S.textDim }}>
                    {histoClosed.length} of {closed.length} · synced to graph zoom
                  </span>
                )}
              </div>
              <div style={{ fontSize: 9, color: S.textDim, letterSpacing: ".1em", marginBottom: 12 }}>NET SOL GAIN / LOSS PER CLOSED POSITION</div>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={histoClosed} margin={{ top: 0, right: 0, left: 0, bottom: 4 }}>
                  <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: S.textDim, fontSize: 9, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} width={46} tickFormatter={v => v.toFixed(S.pnlHistoDecimals ?? 5)} />
                  <Tooltip content={<BarTip S={S} />} cursor={<GlowCursor fill={S.accentGreen} />} />
                  <Bar dataKey="tradePnl" radius={0} isAnimationActive={false}>
                    {histoClosed.map((p, i) => <Cell key={i} fill={p.tradePnl >= 0 ? S.accentGreen : S.accentRed} opacity={0.8} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </BorderCard>
          </div>
        )}

        {/* TRADES */}
        {tab === "trades" && wallets.length > 0 && !selectedToken && (
          <TradesTab filtered={filtered} wallets={wallets} S={S} getColor={getColor} tf={tf}
            onTokenClick={(tok) => setSelectedToken(tok)} />
        )}

        {/* TOKEN DETAIL */}
        {tab === "trades" && wallets.length > 0 && selectedToken && (
          <TokenDetail
            mint={selectedToken.mint} token={selectedToken.token}
            trades={rawTrades} wallets={wallets} S={S} getColor={getColor}
            onBack={() => setSelectedToken(null)}
          />
        )}

        {/* CALENDAR */}
        {tab === "calendar" && (
          <CalendarHeatmap trades={rawTrades} tf={tf} tzOffset={S.tzOffset ?? 0} S={S} onDayClick={doShareDay} />
        )}

        {/* JOURNAL */}
        {tab === "journal" && (
          <TradingJournal closed={closed} S={S} terminalId={S.terminalId ?? "padre"}
            mistakeTags={S.mistakeTags ?? DEFAULT_SETTINGS.mistakeTags}
            setMistakeTags={tags => setSetting("mistakeTags", tags)} />
        )}

        {/* SETTINGS */}
        {tab === "settings" && (
          <SettingsPanel S={S} setSetting={setSetting} setS={setS} />
        )}
        </div>{/* end main content */}
      </div>{/* end sidebar+content flex */}
    </div>
  );
}
