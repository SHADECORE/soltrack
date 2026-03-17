-- ── SOLTRACK MIGRATION: whitelist → blacklist ────────────────────────────────
-- Run in Supabase SQL Editor

-- Add banned column to wallets
alter table wallets add column if not exists banned boolean not null default false;

-- Update leaderboard view to exclude banned wallets and show all non-banned
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
where w.banned = false  -- exclude banned wallets
group by w.address, w.label, w.owner
order by total_pnl desc;
