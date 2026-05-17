// Sweeps the BuybackVault PDA's accumulated SOL into the configured
// receiver wallet. This is the on-chain half of the buyback-and-burn
// pipeline — the off-chain half (Jupiter swap + SPL burn) happens
// after this lands.
//
// Admin-signed (config.admin). Must be the same key that signed
// init_config.
//
// Usage:
//   node execute-buyback.js <programId> <rpcUrl> <adminKeypairPath>
//
// Example:
//   node scripts/execute-buyback.js \
//     DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z \
//     https://api.mainnet-beta.solana.com \
//     ~/.config/solana/id.json
//
// The instruction transfers (buyback_vault.lamports - rent-exempt)
// to buyback_vault.receiver. To change the receiver first, use
// set-buyback-receiver.js — that's a separate admin call.

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');

async function main() {
  const [, , programIdStr, rpcUrl, keypairPath] = process.argv;
  if (!programIdStr || !rpcUrl || !keypairPath) {
    console.error('usage: execute-buyback.js <programId> <rpcUrl> <keypairPath>');
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

  const [buybackVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('buyback_vault')], programId,
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')], programId,
  );

  // Read the configured receiver off-chain so we can pass it as a
  // remaining account. The on-chain instruction verifies it matches
  // buyback_vault.receiver, so any mismatch errors cleanly.
  const bvInfo = await connection.getAccountInfo(buybackVaultPda);
  if (!bvInfo) {
    console.error('buyback_vault PDA not initialized — run init-rev-share.js first');
    process.exit(1);
  }
  // Layout: 8 disc + 32 receiver + 1 bump
  const receiverPubkey = new PublicKey(bvInfo.data.slice(8, 40));

  const balanceLamports = bvInfo.lamports;
  const rentExempt = await connection.getMinimumBalanceForRentExemption(bvInfo.data.length);
  const drainable = balanceLamports - rentExempt;
  console.log('buyback_vault:  ', buybackVaultPda.toBase58());
  console.log('  balance:       ', (balanceLamports / 1e9).toFixed(6), 'SOL');
  console.log('  rent floor:    ', (rentExempt / 1e9).toFixed(6), 'SOL');
  console.log('  drainable:     ', (drainable / 1e9).toFixed(6), 'SOL');
  console.log('receiver:        ', receiverPubkey.toBase58());
  if (drainable <= 0) {
    console.log('nothing to drain — vault at or below rent floor');
    return;
  }

  const tx = await program.methods
    .executeBuyback()
    .accounts({
      config: configPda,
      buybackVault: buybackVaultPda,
      receiver: receiverPubkey,
      admin: wallet.publicKey,
    })
    .rpc();
  console.log('execute_buyback tx:', tx);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
