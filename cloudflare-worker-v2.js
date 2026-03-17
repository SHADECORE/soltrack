// ── SOLTRACK CLOUDFLARE WORKER v2 ─────────────────────────────────────────────
//
// SETUP (one-time, ~5 minutes):
//   1. Run supabase-schema.sql in your Supabase SQL Editor
//   2. In your Supabase project: Settings → API
//      - Copy "Project URL"  → SUPABASE_URL below
//      - Copy "service_role" secret → SUPABASE_SERVICE_KEY below
//   3. Replace HELIUS_API_KEY as before
//   4. Redeploy this worker
//
// ENDPOINTS:
//   GET  /wallet?address=ADDR         — load cached trades + trigger delta sync
//   GET  /leaderboard                 — live leaderboard from DB
//   GET  /health                      — status check
//   POST /whitelist                   — add a wallet to the whitelist (admin only)

// ── CONFIGURE THESE ───────────────────────────────────────────────────────────
const HELIUS_API_KEY      = "YOUR_HELIUS_KEY_HERE";
const SUPABASE_URL        = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_SERVICE_KEY = "YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE";
// ─────────────────────────────────────────────────────────────────────────────

const HELIUS_BASE = "https://api.helius.xyz/v0";
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// How far back to fetch on first sync (days)
const INITIAL_HISTORY_DAYS = 90;
// Max pages per sync call (keeps response time reasonable)
const MAX_PAGES_PER_SYNC = 30;

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      // ── GET /wallet?address=ADDR ───────────────────────────────────────────
      // 1. Load cached trades from Supabase (instant)
      // 2. Delta-sync new txs from Helius (only what's new since last sync)
      // 3. Return all trades to client
      if (path === "/wallet" && request.method === "GET") {
        const address = url.searchParams.get("address");
        if (!address) return json({ error: "missing address" }, 400);

        // Check wallet is whitelisted
        const wallet = await sbGet(`/rest/v1/wallets?address=eq.${address}&select=address,label`);
        if (!wallet?.length) return json({ error: "wallet not whitelisted" }, 403);

        // Load cached trades
        const cached = await sbGet(
          `/rest/v1/trades?wallet=eq.${address}&select=*&order=ts.asc&limit=5000`
        );

        // Get sync state
        const syncRows = await sbGet(`/rest/v1/sync_state?wallet=eq.${address}&select=*`);
        const syncState = syncRows?.[0] ?? null;

        // Delta sync: fetch only txs newer than last_signature
        const newTrades = await syncWallet(address, syncState);

        // Merge cached + new, deduplicate by id
        const allById = {};
        for (const t of (cached ?? [])) allById[t.id] = dbRowToTrade(t);
        for (const t of newTrades)       allById[t.id] = t;
        const allTrades = Object.values(allById).sort((a, b) => new Date(a.ts) - new Date(b.ts));

        // Load token symbols from cache
        const mints = [...new Set(allTrades.map(t => t.mint).filter(Boolean))];
        const symbols = await loadSymbols(mints);

        // Apply symbols
        const namedTrades = allTrades.map(t =>
          symbols[t.mint] ? { ...t, token: symbols[t.mint] } : t
        );

        return json({ trades: namedTrades, wallet: wallet[0] });
      }

      // ── GET /leaderboard ──────────────────────────────────────────────────
      if (path === "/leaderboard" && request.method === "GET") {
        const rows = await sbGet(`/rest/v1/leaderboard?select=*`);
        return json(rows ?? []);
      }

      // ── POST /whitelist ───────────────────────────────────────────────────
      // Body: { address, label, owner, adminKey }
      // Protect with a simple admin key check
      if (path === "/whitelist" && request.method === "POST") {
        const body = await request.json();
        if (body.adminKey !== HELIUS_API_KEY) return json({ error: "unauthorized" }, 401);
        await sbPost("/rest/v1/wallets", {
          address: body.address,
          label:   body.label ?? "",
          owner:   body.owner ?? null,
          whitelisted: true,
        });
        return json({ ok: true });
      }

      // ── Health ────────────────────────────────────────────────────────────
      if (path === "/" || path === "/health") {
        return json({ status: "ok", service: "soltrack-v2", supabase: !!SUPABASE_URL });
      }

      // ── Legacy /transactions (keep for backwards compat) ──────────────────
      if (path === "/transactions" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const before = url.searchParams.get("before");
        const limit  = url.searchParams.get("limit") ?? "100";
        if (!wallet) return json({ error: "missing wallet" }, 400);
        const params = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit });
        if (before) params.set("before", before);
        const upstream = await fetch(`${HELIUS_BASE}/addresses/${wallet}/transactions?${params}`);
        const data = await upstream.json();
        return json(data, upstream.status);
      }

      return json({ error: "not found" }, 404);

    } catch (e) {
      console.error("Worker error:", e);
      return json({ error: e.message }, 500);
    }
  },
};

// ── SYNC ──────────────────────────────────────────────────────────────────────
async function syncWallet(address, syncState) {
  const cutoff = Date.now() - INITIAL_HISTORY_DAYS * 86400_000;
  const newTrades = [];
  let before = undefined;
  let page = 0;
  let isFirstPage = true;
  let newestSig = null;

  while (page < MAX_PAGES_PER_SYNC) {
    const params = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: "100" });
    if (before) params.set("before", before);

    const res = await fetch(`${HELIUS_BASE}/addresses/${address}/transactions?${params}`);
    if (!res.ok) break;
    const txs = await res.json();
    if (!txs?.length) break;

    // Track newest sig from first page for cursor update
    if (isFirstPage) {
      newestSig = txs[0]?.signature ?? null;
      isFirstPage = false;
    }

    for (const tx of txs) {
      // If we've reached a tx we've already stored, stop
      if (syncState?.last_signature && tx.signature === syncState.last_signature) {
        page = MAX_PAGES_PER_SYNC; // break outer loop
        break;
      }
      const parsed = parseTx(tx, address);
      newTrades.push(...parsed);
    }

    const oldestTs = txs[txs.length - 1]?.timestamp * 1000;
    if (txs.length < 100) break;
    if (oldestTs && oldestTs < cutoff) break;

    before = txs[txs.length - 1].signature;
    page++;
  }

  if (!newTrades.length) return [];

  // Run detectCloses on the full trade set to set closesAll correctly
  // We need context of existing trades for accuracy
  const detected = detectCloses(newTrades.sort((a, b) => new Date(a.ts) - new Date(b.ts)));

  // Persist new trades to Supabase (upsert, ignore conflicts)
  if (detected.length) {
    const rows = detected.map(t => tradeToDbRow(t, address));
    // Batch upsert in chunks of 500
    for (let i = 0; i < rows.length; i += 500) {
      await sbUpsert("/rest/v1/trades", rows.slice(i, i + 500));
    }
  }

  // Update sync cursor to newest signature seen
  if (newestSig) {
    await sbUpsert("/rest/v1/sync_state", [{
      wallet:          address,
      last_signature:  newestSig,
      last_synced_at:  new Date().toISOString(),
      total_fetched:   (syncState?.total_fetched ?? 0) + detected.length,
    }]);
  }

  return detected;
}

// ── TOKEN SYMBOLS ─────────────────────────────────────────────────────────────
async function loadSymbols(mints) {
  if (!mints.length) return {};
  const symbols = {};

  // Load from Supabase cache first
  const cached = await sbGet(
    `/rest/v1/token_symbols?mint=in.(${mints.map(m => `"${m}"`).join(",")})&select=mint,symbol`
  );
  for (const row of (cached ?? [])) symbols[row.mint] = row.symbol;

  // Resolve unknown mints via DexScreener
  const unknown = mints.filter(m => !symbols[m]);
  if (unknown.length) {
    const chunks = [];
    for (let i = 0; i < unknown.length; i += 30) chunks.push(unknown.slice(i, i + 30));
    for (const chunk of chunks) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!res.ok) continue;
        const pairs = await res.json();
        const toInsert = [];
        for (const pair of pairs) {
          const mint = pair?.baseToken?.address;
          const sym  = pair?.baseToken?.symbol;
          const name = pair?.baseToken?.name;
          if (mint && sym && !symbols[mint]) {
            symbols[mint] = sym;
            toInsert.push({ mint, symbol: sym, name: name ?? sym });
          }
        }
        if (toInsert.length) await sbUpsert("/rest/v1/token_symbols", toInsert);
      } catch (e) { /* skip */ }
    }
  }

  return symbols;
}

// ── TRADE PARSING (mirrored from frontend) ────────────────────────────────────
const SOL_MINT = "So11111111111111111111111111111111111111112";

function parseTx(tx, wallet) {
  try {
    const ts     = new Date(tx.timestamp * 1000).toISOString();
    const sig    = tx.signature;
    const txFee  = (tx.fee ?? 5000) / 1e9;
    const nativeIn  = (tx.nativeTransfers ?? []).filter(t => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
    const nativeOut = (tx.nativeTransfers ?? []).filter(t => t.fromUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
    const tokenIn   = (tx.tokenTransfers ?? []).filter(t => t.toUserAccount === wallet && t.mint !== SOL_MINT);
    const tokenOut  = (tx.tokenTransfers ?? []).filter(t => t.fromUserAccount === wallet && t.mint !== SOL_MINT);
    const results = [];
    if (tokenIn.length > 0 && nativeOut > 0) {
      for (const tin of tokenIn) {
        results.push({
          id: sig + "_buy_" + tin.mint.slice(0, 8),
          token: tin.symbol || tin.mint.slice(0, 6) + "…",
          mint: tin.mint, type: "buy", ts,
          sol:    +Math.max(0, nativeOut - txFee).toFixed(6),
          amount: tin.tokenAmount ?? 0,
          fee:    0,
          txFee:  +txFee.toFixed(6), sig,
        });
      }
    }
    if (tokenOut.length > 0 && nativeIn > 0) {
      for (const tout of tokenOut) {
        results.push({
          id: sig + "_sell_" + tout.mint.slice(0, 8),
          token: tout.symbol || tout.mint.slice(0, 6) + "…",
          mint: tout.mint, type: "sell", ts,
          sol:    +Math.max(0, nativeIn - txFee).toFixed(6),
          amount: tout.tokenAmount ?? 0,
          fee:    0,
          txFee:  +txFee.toFixed(6), sig,
        });
      }
    }
    return results;
  } catch (e) { return []; }
}

function detectCloses(trades) {
  const bal = {};
  return trades.map(t => {
    const m = t.mint ?? t.token;
    if (!bal[m]) bal[m] = 0;
    if (t.type === "buy")  { bal[m] += t.amount ?? 1; return { ...t, closesAll: false }; }
    if (t.type === "sell") { bal[m] = Math.max(0, (bal[m] ?? 0) - (t.amount ?? 1)); return { ...t, closesAll: bal[m] < 0.001 }; }
    return t;
  });
}

// ── DB HELPERS ────────────────────────────────────────────────────────────────
function tradeToDbRow(t, wallet) {
  return {
    id: t.id, wallet, signature: t.sig ?? t.id.split("_")[0],
    type: t.type, token: t.token, mint: t.mint,
    ts: t.ts, sol: t.sol, amount: t.amount,
    fee: t.fee, tx_fee: t.txFee, closes_all: t.closesAll ?? false,
  };
}

function dbRowToTrade(row) {
  return {
    id: row.id, type: row.type, token: row.token, mint: row.mint,
    ts: row.ts, sol: +row.sol, amount: +row.amount,
    fee: +row.fee, txFee: +row.tx_fee, closesAll: row.closes_all,
    sig: row.signature,
  };
}

// ── SUPABASE REST CLIENT ──────────────────────────────────────────────────────
function sbHeaders() {
  return {
    "apikey":        SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal",
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: sbHeaders() });
  if (!res.ok) { console.error("sbGet failed", path, await res.text()); return null; }
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST", headers: sbHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) console.error("sbPost failed", path, await res.text());
  return res;
}

async function sbUpsert(path, rows) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) console.error("sbUpsert failed", path, await res.text());
  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
