// Rotates the BuybackVault.receiver wallet — the address that the
// next execute_buyback transfer will sweep SOL into. Use to change
// the off-chain pipeline destination (e.g., moving from a hot
// wallet to a multisig, or rotating after a key compromise).
//
// Admin-signed (config.admin).
//
// Usage:
//   node set-buyback-receiver.js <programId> <newReceiverPubkey> <rpcUrl> <adminKeypairPath>
//
// Example:
//   node scripts/set-buyback-receiver.js \
//     DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z \
//     <multisig_pubkey> \
//     https://api.mainnet-beta.solana.com \
//     ~/.config/solana/id.json
//
// Doesn't move any SOL. Affects the destination of the NEXT
// execute_buyback only. SOL already in the receiver wallet stays
// where it is.

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');

async function main() {
  const [, , programIdStr, newReceiverStr, rpcUrl, keypairPath] = process.argv;
  if (!programIdStr || !newReceiverStr || !rpcUrl || !keypairPath) {
    console.error('usage: set-buyback-receiver.js <programId> <newReceiverPubkey> <rpcUrl> <keypairPath>');
    process.exit(1);
  }
  const programId = new PublicKey(programIdStr);
  const newReceiver = new PublicKey(newReceiverStr);
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

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [buybackVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('buyback_vault')], programId,
  );

  console.log('config:         ', configPda.toBase58());
  console.log('buyback_vault:  ', buybackVaultPda.toBase58());
  console.log('admin:          ', wallet.publicKey.toBase58());
  console.log('new receiver:   ', newReceiver.toBase58());

  const tx = await program.methods
    .setBuybackReceiver(newReceiver)
    .accounts({
      config: configPda,
      buybackVault: buybackVaultPda,
      admin: wallet.publicKey,
    })
    .rpc();
  console.log('set_buyback_receiver tx:', tx);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
