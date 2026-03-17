-- ── SOLTRACK MIGRATION: fix leaderboard PnL double-fee subtraction ───────────
-- Run in Supabase SQL Editor

-- sol column already contains net wallet delta (all fees baked in)
-- so PnL = sum of sell sols - sum of buy sols, no fee subtraction needed
create or replace view leaderboard as
select
  w.address,
  w.label,
  w.owner,
  count(distinct case when t.closes_all then t.id end)                           as closed_positions,
  coalesce(sum(case when t.type = 'sell' then t.sol else -t.sol end), 0)         as total_pnl,
  count(distinct case when t.type = 'sell' and t.closes_all then t.id end)      as total_trades,
  round(
    100.0 * count(distinct case when t.type='sell' and t.closes_all
                                 and t.sol > 0 then t.id end)
          / nullif(count(distinct case when t.type='sell' and t.closes_all then t.id end), 0)
  , 1)                                                                           as win_rate
from wallets w
left join trades t on t.wallet = w.address
where w.banned = false
group by w.address, w.label, w.owner
order by total_pnl desc;
