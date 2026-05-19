# ten little — what it is, how it works

## The game

A short, frantic survival game played in a browser. Ten little figures spawn on a tilting plate. A hand reaches down to grab them, the plate's edge tips them off, and they bump into each other and lose hearts. Whoever's left standing wins. Rounds last about 60-90 seconds.

There are two ways to play: a free practice mode against bots (no login, no money), and **quickmatch** — a paid match where everyone puts in 0.01 SOL and the survivors split the pot. The whole system is built around making that paid match feel as smooth and fair as a free one.

## What a paid match feels like

You open the site, log in once (email or wallet — your choice), and click "join". The server pairs you with another human. Once a second player shows up, your wallet asks you to approve a 0.01 SOL payment. You sign, they sign, and the round starts after a 60-second countdown. You play. Somebody wins. The pot lands in the winner's wallet automatically — no claim button, no waiting. You see exactly how much you won (or lost) right on the end screen.

If you bail mid-match, your entry is forfeit — you knew that going in. If your wifi blinks and you come back within 10 minutes, you land right back in your figure, mid-game. If the other player never pays, you get your entry back automatically after about a minute and a half.

## Where the money goes

Out of every paid match, **5% is rake** — the house take. The other 95% goes to the winners (split between top 1, 2, or 3 depending on how many humans paid in).

The rake itself splits two ways:

- **80% to NFT holders.** Anyone holding one of the project's NFTs can come to the `/claim` page and pull their share of all the rake that's accumulated since their last claim. It just sits there earning until they bother to collect it.
- **20% to buyback.** This sits in a separate wallet. Periodically you (the operator) sweep it out, swap the SOL for the project's pump.fun token on Jupiter, and burn the tokens. That reduces total supply, which over time should reward token holders.

The point of this structure: every paid match creates value for both NFT holders (passively accruing claimable SOL) and token holders (reducing supply through burns).

## What's behind the scenes

There are three pieces holding this up:

**The browser.** Where you play. Just rendering pretty pictures and sending your joystick inputs to a server. No game logic lives here, so nobody can cheat by editing JavaScript.

**The server.** A small Node.js program running on Railway. It's the referee — it runs the actual game simulation, decides who got eliminated and in what order, and tells the on-chain program who won when the round ends. It's also what fills empty seats with bots and handles all the lobby plumbing.

**The on-chain program (Solana).** This is the trustless piece. It holds your entry SOL during matches and only releases it according to its own rules. The server can tell it "these are the winners, pay them this much" but the program checks its own math before doing anything. If the server tried to cheat, the program would refuse the transaction.

The way to think about it: **the server can run the game, but it can't steal the pot.** Only the program can move SOL out of the pot, and only along rules that are public and verifiable.

## Logins and wallets

You don't need to know what a wallet is to play. Privy handles that. When you sign in with email, Privy creates a Solana wallet for you behind the scenes, secured by your login. You can fund it like any wallet (someone sends you SOL), use it to pay match entries, and receive winnings — all without ever seeing a seed phrase. People who already have a wallet (Phantom, etc.) can also just connect that and use it directly.

The wallets we (the operator) care about are different:

- **Deploy wallet** — your personal admin key. Used once at launch to put the program on chain, and once in a while to update settings.
- **Oracle wallet** — lives on the server. Pays the tiny gas fees for finalize and drain transactions. Holds maybe a half SOL at any time.
- **Buyback wallet** — the address where the 20% rake share accumulates before you swap and burn. You hold the private key for this in your wallet app.

These three are independent of any player's wallet. Players never see them.

## Reconnecting after a bad connection

This was a real focus because mobile cell reception is unreliable and rage-inducing if losing wifi means losing 0.01 SOL.

When you complete payment, the server quietly hands your browser a session token, kept locally. If your tab closes or your connection drops, the server doesn't immediately give up on you — it keeps your spot in the game for up to 10 minutes. While you're gone, a bot drives your figure (it's not great at the game, but it doesn't just stand still and die either). When you come back and reload the page, the token in your browser tells the server "I'm the same player from match X" and you take control back, mid-fight.

If your figure happened to die during the disconnect, fair enough — you're a spectator. But if it's still alive, you can finish the match.

## What goes wrong, and what's automatic

The system handles a bunch of unhappy paths automatically so you don't have to wake up at 3am:

- Match never reaches enough humans → automatic refund after 90 seconds, players see a countdown.
- Player signs payment, opponent doesn't → automatic refund to the payer, room dissolves.
- Server has a transient network blip talking to Solana → retries with backoff, recovers silently.
- Player closes tab during round → bot takes their figure, they can reconnect.
- Round ends → winners paid, rake distributed, all in one server-side flow.

What's NOT automatic and needs you to do something occasionally:

- When the buyback wallet has enough accumulated SOL, you decide to sweep + swap + burn (manual for v1; could automate later).
- If the server crashes during a match (rare on Railway), you'd run a recovery script to refund any stranded pots.
- The oracle wallet needs a SOL top-up every few thousand matches (you'd notice via monitoring).

## What's not in v1

This launch is the smallest viable real-money version. Things deliberately deferred for later:

- **Tiered rooms.** Only 0.01 SOL matches exist initially. Later you'd add 0.1 / 0.5 / 1 SOL rooms.
- **Open-rooms lobby.** Players can't browse rooms; they just click "join" and get paired. Quickmatch only.
- **Spectator view.** If you die in second 10 of a 90-second round, you stare at the end screen until it's over. Could improve this to let dead players watch the rest.
- **Player skins.** Everyone looks the same. The plan is eventually you can play as your NFT, but not yet.
- **Tournaments / leaderboards / history.** No persistent player records. Every match is its own thing.
- **Automated buyback bot.** Manual swap-and-burn for v1; automated later once you've watched the cadence and know what timing makes sense.
- **Admin dashboard.** You watch Railway logs and Solana explorer manually. A unified dashboard would be nice; we'll build it once there's real data to look at.

## What this looks like as a business

Every paid match generates:

- A small win for active players (winners get most of the pot back)
- A small win for NFT holders (rev-share)
- A small win for token holders (buyback + burn)
- A very small win for you (the operator gets the rent SOL back when each pot closes, plus you control the buyback pace)

It's intentionally aligned: no single party wins at another's expense. The house edge is the 5%, and even that doesn't go to the house — it goes back into the holder communities. The "house" is everyone holding the token and the NFTs.

For the operator (you), the day-to-day is mostly watching that everything keeps running, occasionally executing a buyback, occasionally rotating a key or topping up the oracle. The game runs itself.
