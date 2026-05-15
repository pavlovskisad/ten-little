// Anchor client wrapper for the escrow program. Server-side calls
// happen exclusively from this module so the rest of the game server
// doesn't need to know anything about Anchor or PDA derivation.
//
// Activation: the module is enabled when ORACLE_KEYPAIR_JSON is set
// in the environment (a JSON array of u8 secret-key bytes — the same
// format `solana-keygen` produces). Without it, isEnabled() returns
// false and every game flow falls back to the off-chain behavior the
// server already had.
//
// Three roles are exercised here:
//   - The oracle (this server) signs init_pot / start_pot / finalize_pot.
//   - Players sign join_pot from the browser (see auth.js / B2.6).
//   - The admin is offline (see scripts/init-config.js).

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

const PROGRAM_ID = new PublicKey('DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z');
const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';

// Repo path so we can pull the IDL without copying it into server/.
const IDL_PATH = path.resolve(
  __dirname, '..', '..', 'contracts', 'escrow', 'target', 'idl', 'escrow.json'
);

let _enabled = false;
let _program = null;
let _oracle = null;
let _connection = null;
let _idl = null;

function init() {
  const raw = process.env.ORACLE_KEYPAIR_JSON;
  if (!raw) {
    console.log('[escrow] disabled (set ORACLE_KEYPAIR_JSON to enable)');
    return;
  }
  try {
    const secret = JSON.parse(raw);
    _oracle = Keypair.fromSecretKey(Uint8Array.from(secret));
    _connection = new Connection(RPC_URL, 'confirmed');
    const wallet = new anchor.Wallet(_oracle);
    const provider = new anchor.AnchorProvider(_connection, wallet, {
      commitment: 'confirmed',
    });
    _idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    _program = new anchor.Program(_idl, provider);
    _enabled = true;
    console.log(
      '[escrow] enabled; oracle=' + _oracle.publicKey.toBase58() +
      '; rpc=' + RPC_URL +
      '; program=' + PROGRAM_ID.toBase58()
    );
  } catch (err) {
    console.warn('[escrow] init failed:', err.message);
    _enabled = false;
  }
}

function isEnabled() {
  return _enabled;
}

// Pot PDA from a u64 room id. The on-chain seed packs the room id as
// little-endian 8 bytes; same packing is used in the Rust program.
function potPda(roomIdBigInt) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roomIdBigInt));
  return PublicKey.findProgramAddressSync([Buffer.from('pot'), buf], PROGRAM_ID)[0];
}

function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
}

function rakeVaultPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('rake_vault')], PROGRAM_ID)[0];
}

// Oracle creates a pot for a fresh quickmatch room. Pays rent on the
// Pot PDA (~0.003 SOL); refunded on finalize via close=oracle.
async function initPot(roomIdBigInt, entryFeeLamports) {
  if (!_enabled) throw new Error('escrow disabled');
  const pot = potPda(roomIdBigInt);
  const sig = await _program.methods
    .initPot(new anchor.BN(roomIdBigInt), new anchor.BN(entryFeeLamports))
    .accounts({
      config: configPda(),
      pot,
      oracle: _oracle.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { signature: sig, pot: pot.toBase58() };
}

// Freezes joins. Called when the lobby countdown ends or skip-timer fires.
async function startPot(roomIdBigInt) {
  if (!_enabled) throw new Error('escrow disabled');
  const sig = await _program.methods
    .startPot(new anchor.BN(roomIdBigInt))
    .accounts({
      config: configPda(),
      pot: potPda(roomIdBigInt),
      oracle: _oracle.publicKey,
    })
    .rpc();
  return { signature: sig };
}

// Refunds every paid player and closes the pot. Only valid while
// pot.state == Waiting (i.e., round hasn't started yet). Used when
// a paid quickmatch lobby is cancelled before the round begins.
// The full pot.players list must be supplied as `players` so we
// can pass them as remaining_accounts.
async function refundPot(roomIdBigInt, players) {
  if (!_enabled) throw new Error('escrow disabled');
  const playerKeys = players.map(p => new PublicKey(p));
  const sig = await _program.methods
    .refundPot(new anchor.BN(roomIdBigInt))
    .accounts({
      config: configPda(),
      pot: potPda(roomIdBigInt),
      oracle: _oracle.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      playerKeys.map(pk => ({ pubkey: pk, isWritable: true, isSigner: false }))
    )
    .rpc();
  return { signature: sig };
}

// Pays each winner from the pot, sweeps rake into the vault, closes
// the pot account (rent refunds to oracle). Winners must be in the
// pot's player list; sum(amounts) + rake must equal total played.
async function finalizePot(roomIdBigInt, winners, amounts) {
  if (!_enabled) throw new Error('escrow disabled');
  const winnerKeys = winners.map(w => new PublicKey(w));
  const sig = await _program.methods
    .finalizePot(
      new anchor.BN(roomIdBigInt),
      winnerKeys,
      amounts.map(a => new anchor.BN(a)),
    )
    .accounts({
      config: configPda(),
      pot: potPda(roomIdBigInt),
      rakeVault: rakeVaultPda(),
      oracle: _oracle.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      winnerKeys.map(pk => ({ pubkey: pk, isWritable: true, isSigner: false }))
    )
    .rpc();
  return { signature: sig };
}

// Read pot state (players, state, entry_fee) without signing anything.
// Useful for the lobby pot-UI in Phase B3.
async function fetchPot(roomIdBigInt) {
  if (!_enabled) throw new Error('escrow disabled');
  const pot = potPda(roomIdBigInt);
  return _program.account.pot.fetch(pot);
}

module.exports = {
  init,
  isEnabled,
  initPot,
  startPot,
  refundPot,
  finalizePot,
  fetchPot,
  potPda,
  configPda,
  rakeVaultPda,
  PROGRAM_ID,
  RPC_URL,
};
