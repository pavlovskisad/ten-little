// Recovery script for orphaned pots. Use after a server crash or
// container restart left pots on chain that the off-chain server
// forgot about. Lists every Pot PDA with its state, age, and paid-
// player count. Optionally refunds Waiting pots.
//
// Signs with the ORACLE keypair (refund_pot enforces oracle signer
// via config.has_one). Use the same keypair that ORACLE_KEYPAIR_JSON
// points at on Railway — NOT your admin/deploy wallet at
// ~/.config/solana/id.json. If you only have ORACLE_KEYPAIR_JSON
// as a Railway env var, copy it locally to oracle.json first.
//
// Usage:
//   node recover-pots.js <programId> <rpcUrl> <oracleKeypairPath> [--auto-refund] [--min-age-min N]
//
// Without --auto-refund the script just prints the inventory and
// exits. With it, every Waiting pot older than --min-age-min
// minutes (default 10) gets refunded.
//
// Playing pots are NEVER auto-refunded (refund_pot rejects that
// state on chain). They're printed with a warning — admin must
// decide manually whether to call finalize_pot (even split across
// paid players, or whatever's right for the abandoned round) or
// just leave them stuck.
//
// Example:
//   node scripts/recover-pots.js \
//     DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z \
//     https://api.mainnet-beta.solana.com \
//     ./oracle.json \
//     --auto-refund

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

const STATE_LABELS = { 0: 'Waiting', 1: 'Playing', 2: 'Finalized' };

async function main() {
  const args = process.argv.slice(2);
  const programIdStr = args[0];
  const rpcUrl = args[1];
  const keypairPath = args[2];
  const autoRefund = args.includes('--auto-refund');
  const minAgeMin = (() => {
    const i = args.indexOf('--min-age-min');
    return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 10;
  })();
  if (!programIdStr || !rpcUrl || !keypairPath) {
    console.error('usage: recover-pots.js <programId> <rpcUrl> <keypairPath> [--auto-refund] [--min-age-min N]');
    process.exit(1);
  }

  const programId = new PublicKey(programIdStr);
  const secret = JSON.parse(fs.readFileSync(keypairPath.replace(/^~/, process.env.HOME || ''), 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'target', 'idl', 'escrow.json'), 'utf8'),
  );
  const program = new anchor.Program(idl, provider);

  console.log('rpc:        ', rpcUrl);
  console.log('admin:      ', wallet.publicKey.toBase58());
  console.log('mode:       ', autoRefund ? `auto-refund Waiting > ${minAgeMin}min` : 'inventory only');
  console.log('');

  const pots = await program.account.pot.all();
  if (pots.length === 0) {
    console.log('no pots on chain');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const buckets = { Waiting: [], Playing: [], Finalized: [] };
  for (const { publicKey, account } of pots) {
    const state = STATE_LABELS[account.state] || 'Unknown(' + account.state + ')';
    const ageSec = now - Number(account.createdAt || account.created_at || 0);
    const ageMin = Math.floor(ageSec / 60);
    const paidPlayers = (account.players || []).map(p => p.toBase58());
    buckets[state] = buckets[state] || [];
    buckets[state].push({
      pda: publicKey.toBase58(),
      roomId: account.roomId?.toString?.() || String(account.room_id || account.roomId),
      entryFee: account.entryFee?.toString?.() || String(account.entry_fee || account.entryFee),
      ageMin,
      paidPlayers,
    });
  }

  for (const state of ['Waiting', 'Playing', 'Finalized']) {
    const list = buckets[state] || [];
    if (list.length === 0) continue;
    console.log(`=== ${state} (${list.length}) ===`);
    for (const p of list) {
      console.log(`  pda=${p.pda} room=${p.roomId} fee=${(Number(p.entryFee) / 1e9).toFixed(4)}SOL age=${p.ageMin}min players=${p.paidPlayers.length}`);
    }
    console.log('');
  }

  if (buckets.Playing && buckets.Playing.length > 0) {
    console.log('!!! Playing pots cannot be refunded — they need manual finalize_pot.');
    console.log('    Inspect each, decide a winner / even-split, then call finalize_pot');
    console.log('    with the right winners + amounts. Cannot be done from this script.');
    console.log('');
  }

  if (!autoRefund) {
    console.log('inventory mode — re-run with --auto-refund to refund Waiting pots.');
    return;
  }

  const refundable = (buckets.Waiting || []).filter(
    p => p.ageMin >= minAgeMin && p.paidPlayers.length > 0,
  );
  if (refundable.length === 0) {
    console.log(`no Waiting pots older than ${minAgeMin}min with paid players — nothing to refund`);
    return;
  }
  console.log(`refunding ${refundable.length} Waiting pot(s)…`);
  for (const p of refundable) {
    try {
      const roomIdBigInt = BigInt(p.roomId);
      const playerKeys = p.paidPlayers.map(pk => new PublicKey(pk));
      const tx = await program.methods
        .refundPot(new anchor.BN(roomIdBigInt))
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0],
          pot: new PublicKey(p.pda),
          oracle: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          playerKeys.map(pk => ({ pubkey: pk, isWritable: true, isSigner: false })),
        )
        .rpc();
      console.log(`  refunded room=${p.roomId} sig=${tx}`);
    } catch (err) {
      console.warn(`  failed room=${p.roomId}: ${err.message || err}`);
    }
  }
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
