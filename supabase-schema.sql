-- ── SOLTRACK SUPABASE SCHEMA ──────────────────────────────────────────────────
-- Run this entire file in the Supabase SQL Editor (supabase.com → project → SQL Editor)

-- ── WHITELISTED WALLETS ───────────────────────────────────────────────────────
-- Only wallets in this table can be tracked and appear on the leaderboard.
-- You manage this manually — add your own wallets here.
create table if not exists wallets (
  address     text primary key,
  label       text not null default '',
  owner       text,                        -- optional: who owns this wallet
  whitelisted boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── PARSED TRADES ────────────────────────────────────────────────────────────
-- One row per parsed trade (buy or sell). Signature + type is the unique key
-- since one tx can produce both a buy and a sell record.
create table if not exists trades (
  id          text primary key,            -- sig_buy_mintXXXXXX or sig_sell_mintXXXXXX
  wallet      text not null references wallets(address) on delete cascade,
  signature   text not null,
  type        text not null check (type in ('buy','sell')),
  token       text not null,
  mint        text not null,
  ts          timestamptz not null,
  sol         numeric not null default 0,
  amount      numeric not null default 0,
  fee         numeric not null default 0,
  tx_fee      numeric not null default 0,
  closes_all  boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists trades_wallet_ts on trades(wallet, ts desc);
create index if not exists trades_mint      on trades(mint);
create index if not exists trades_ts        on trades(ts desc);

-- ── SYNC STATE ───────────────────────────────────────────────────────────────
-- Tracks the newest signature we've fetched for each wallet.
-- Delta sync: on next refresh, only fetch txs AFTER this signature.
create table if not exists sync_state (
  wallet          text primary key references wallets(address) on delete cascade,
  last_signature  text,                    -- newest sig fetched (used as Helius cursor)
  last_synced_at  timestamptz,
  total_fetched   integer not null default 0
);

-- ── TOKEN SYMBOL CACHE ───────────────────────────────────────────────────────
-- Persists DexScreener symbol lookups so we don't re-fetch on every load.
create table if not exists token_symbols (
  mint      text primary key,
  symbol    text not null,
  name      text,
  updated_at timestamptz not null default now()
);

-- Seed with known tokens
insert into token_symbols (mint, symbol, name) values
  ('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK',   'Bonk'),
  ('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF',    'dogwifhat'),
  ('ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  'BOME',   'Book of Meme'),
  ('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', 'POPCAT', 'Popcat'),
  ('HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4', 'MYRO',   'Myro'),
  ('5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK31CR8Ada',  'PONKE',  'Ponke'),
  ('So11111111111111111111111111111111111111112',     'SOL',    'Solana')
on conflict (mint) do nothing;

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- All reads/writes go through the Cloudflare Worker using the service_role key.
-- The anon key has NO access. This means the browser never touches Supabase directly.
alter table wallets       enable row level security;
alter table trades        enable row level security;
alter table sync_state    enable row level security;
alter table token_symbols enable row level security;

-- Deny all access to anon/authenticated roles (worker uses service_role which bypasses RLS)
create policy "deny anon wallets"       on wallets       for all to anon using (false);
create policy "deny anon trades"        on trades        for all to anon using (false);
create policy "deny anon sync_state"    on sync_state    for all to anon using (false);
create policy "deny anon token_symbols" on token_symbols for all to anon using (false);

-- ── LEADERBOARD VIEW ─────────────────────────────────────────────────────────
-- Pre-aggregated leaderboard — worker queries this directly.
create or replace view leaderboard as
select
  w.address,
  w.label,
  w.owner,
  count(distinct case when t.closes_all then t.id end)                          as closed_positions,
  coalesce(sum(case when t.type = 'sell' then t.sol else -t.sol end)
         - sum(t.fee + t.tx_fee), 0)                                            as total_pnl,
  count(distinct case when t.type = 'sell' and t.closes_all then t.id end)     as total_trades,
  round(
    100.0 * count(distinct case when t.type='sell' and t.closes_all
                                 and t.sol > 0 then t.id end)
          / nullif(count(distinct case when t.type='sell' and t.closes_all then t.id end), 0)
  , 1)                                                                          as win_rate
from wallets w
left join trades t on t.wallet = w.address
where w.whitelisted = true
group by w.address, w.label, w.owner
order by total_pnl desc;
