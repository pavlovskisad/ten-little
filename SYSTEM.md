# ten little — system overview

## What it is

Browser-based elimination game with real-money matches on Solana. 10 figures spawn on a tilting plate, hands descend to grab them, edges drop them, contact damages them. Last one standing (or top 1-3 of the human field) wins the pot.

Two modes: **quickmatch** (paid, 0.01 SOL entry, Privy auth required) and **practice** (free, vs bots, no auth).

## Architecture (three layers)

**Client** — `index.html` runs vanilla JS + three.js for rendering. Preact island (`auth.js`) handles Privy login + wallet drawer. Claim page (`claim.js`) is a separate Preact app. The browser is pure render + input forwarding; no game logic.

**Server** — Node.js on Railway, single process. Hand-rolled `ws` + `http`, serves static client and runs authoritative sim at 30Hz. Each match = one `GameRoom` instance in memory. Bot AI fills empty slots. Escrow calls go through `server/src/escrow.js` (Anchor client wrapper).

**On-chain** — Anchor program at `GMoWDCAkdoxkULH4R5u22biz1FBvZwSUtY6RKKBhaz1M`. Holds pot SOL, validates oracle-signed payouts, splits rake into rev-share (80%) and buyback (20%) accumulators.

## Money flow

```
player wallets ──0.01 SOL each──> Pot PDA ──finalize_pot─┬─> winners (92% of pot, tier-split)
                                                          └─> rake_vault (8%)
                                                              │
                                                  ──drain_rake_vault──
                                                  │                  │
                                                  ▼                  ▼
                                             rev_share PDA      buyback_vault PDA
                                             (80% of rake)      (20% of rake)
                                                  │                  │
                                                  ▼                  ▼
                                          NFT holders        execute_buyback →
                                          claim via            receiver wallet →
                                          /claim page          (off-chain: Jupiter
                                                                swap → SPL burn)
```

Per-match math at 2 humans × 0.01 SOL: pot = 0.02 SOL, winner gets 0.0184, rake = 0.0016 (0.00128 to rev-share, 0.00032 to buyback).

## Quickmatch player flow

1. Open `*.up.railway.app` → Privy login (email or external wallet)
2. Click "join" → server matchmakes into a `lobby` room
3. 2nd human lands → server calls `init_pot` → both players prompted to pay
4. Both sign `join_pot` (0.01 SOL each into Pot PDA)
5. 60s countdown → server calls `start_pot` → round begins
6. Sim runs (player input → server tick → snapshot broadcast → client renders)
7. End condition (≤1 humans alive) → server computes winners, calls `finalize_pot`
8. Winners' wallets receive SOL on chain automatically (no claim step needed)
9. Server calls `drain_rake_vault` (cascades 80/20 split)
10. Client shows placement overlay + per-wallet payout amounts
11. "again" auto-replays same mode

## Reconnect flow

- After `paid` confirms server-side, server issues a 10-min session token
- Client stores in `localStorage` keyed `tlSession`
- On WS drop, server keeps slot (`disconnect()`); figure flips to bot AI via `playerIntent` checking `p.disconnected`
- On page reload, client sees token in localStorage → sends `reconnect` message → server rebinds WS, returns figureId
- If the figure died during disconnect, it stays dead (player becomes spectator)

## Pre-pay failure paths

- **One player exits Privy modal:** countdown expires, server's start-gate detects unpaid, `matchCancelled` broadcast, paid player refunded via `refund_pot`, room dissolves
- **2nd joiner disconnects before paying:** removed as unpaid, room goes "stale" (1 paid, no opponent), 90s grace, refund fires if no one new joins, orange countdown notice in lobby
- **Both unpaid + countdown expires:** room dissolves silently (no SOL to refund)
- **Server crash:** orphaned Pot PDAs sit on chain. Admin runs `recover-pots.js` to inventory + refund Waiting pots. Playing pots need manual `finalize_pot` with even-split.

## On-chain accounts

| Account | Seeds | Holds | Lifetime |
|---|---|---|---|
| ProgramConfig | `[b"config"]` | admin, oracle, rake_bps, buyback_mint, nft_collection | Singleton, permanent |
| RakeVault | `[b"rake_vault"]` | Rake lamports between drains | Singleton |
| RevShareState | `[b"rev_share"]` | total_accrued_per_unit (u128), nft_supply | Singleton |
| BuybackVault | `[b"buyback_vault"]` | Receiver pubkey + 20% rake share | Singleton |
| Pot | `[b"pot", room_id]` | players[], entry_fee, state | Per-room, closes on finalize/refund |
| ClaimState | `[b"claim", nft_mint]` | last_claimed_per_unit cursor | Per-NFT, created on first claim |

## Key instructions

- **Player-signed:** `join_pot`, `claim_rev_share`
- **Oracle-signed:** `init_pot`, `start_pot`, `finalize_pot`, `refund_pot`, `drain_rake_vault`
- **Admin-signed:** `init_config`, `set_oracle`, `set_rake_bps`, `set_buyback_token`, `set_nft_collection`, `init_rev_share`, `set_nft_supply`, `set_buyback_receiver`, `execute_buyback`

## Hosting / infra

| Layer | Service | Account |
|---|---|---|
| Source | GitHub `tenlil/tenlil` (private) | tenlil |
| Compute | Railway (auto-deploy from main) | tenlil |
| RPC | Helius mainnet (paid tier) | tenlil |
| Auth | Privy app `cmpappljb019s0cjrqmfgp5wc` | tenlil |
| Chain | Solana mainnet-beta | n/a |

## Key addresses (mainnet)

```
Program ID:         GMoWDCAkdoxkULH4R5u22biz1FBvZwSUtY6RKKBhaz1M
Buyback SPL mint:   Bq37gVFJ2yaKuD8rvaQ7TGRakiyetgwJJqdjE9Xhpump
NFT collection:     CgPjrVhvoyp1DUSdgiR8PGC22s4jW2io5pbYxLjm7i1S
Deploy/admin:       G65tWYaSn5zs88DCM3qkbwP2P2FQHCNFMBe2A31qtS92
Oracle:             E1X8Yf8QZFbU4tyt8nzKRmDoCKzhEwtXFTTRYcQhMw57
Buyback receiver:   5zUwoqGznieSx1kbHyW3enZmvkU2nbpNts4bcqn16Cw4
```

## Operational responsibilities (post-launch)

- **Oracle wallet balance** — top up at <0.05 SOL (~0.5 SOL covers thousands of finalizes)
- **Buyback execution** — manual `execute-buyback.js` when vault has ~0.05+ SOL
- **Token swap + burn** — off-chain, manual, via Jupiter UI from the receiver wallet
- **Orphaned pot recovery** — `recover-pots.js` after any server restart
- **Helius quota monitoring** — paid tier should cover normal load; watch for 429s in logs
- **Privy session monitoring** — n/a, Privy handles infra

## Hard limits / known shapes

- 10 humans + bots max per room
- Single entry-fee tier (0.01 SOL) — tiered rooms deferred
- 90s grace before stale-lobby refund
- 60s lobby countdown
- 8% rake (configurable via `set_rake_bps`)
- 20/80 buyback/rev-share split (compile-time constant, not configurable)
- Session token TTL: 10 min
- NFT supply: 420 (configurable via `set_nft_supply`)
- Match end condition: ≤1 humans alive (or total field ≤3 for solo+bot rounds)

## What's deferred (not v1)

- Lobby browser (open-rooms list)
- Tiered entry fees (0.1 / 0.5 / 1 SOL rooms)
- Spectator mode for eliminated players
- Admin dashboard
- NFT skins (player figures use shared model)
- Autonomous buyback bot
- Hardware-wallet / multisig upgrade authority
- Asset CDN
- Game history / leaderboards / tournaments
