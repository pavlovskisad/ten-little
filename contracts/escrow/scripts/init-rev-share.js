// One-time setup for Phase C rev-share. Run AFTER the program is
// upgraded (anchor deploy) and BEFORE the first quickmatch finalize
// after the upgrade. Creates the RevShareState + BuybackVault PDAs.
//
// Usage:
//   node init-rev-share.js <programId> <nftSupply> <buybackReceiver> <rpcUrl> <adminKeypairPath>
//
// Example (devnet):
//   node scripts/init-rev-share.js \
//     DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z \
//     10000 \
//     8nEqhqMuh8GBNFQYCq4cdLZ9yvLxE4FpK6E3R2o7HkDe \
//     https://api.devnet.solana.com \
//     ~/.config/solana/id.json
//
// The receiver wallet is whoever will eventually pull funds out of
// the buyback_vault via execute_buyback (swap-and-burn). Admin can
// rotate it later via set_buyback_receiver.

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

async function main() {
  const [, , programIdStr, supplyStr, receiverStr, rpcUrl, keypairPath] = process.argv;
  if (!programIdStr || !supplyStr || !receiverStr || !rpcUrl || !keypairPath) {
    console.error('usage: init-rev-share.js <programId> <nftSupply> <buybackReceiver> <rpcUrl> <keypairPath>');
    process.exit(1);
  }
  const programId = new PublicKey(programIdStr);
  const nftSupply = BigInt(supplyStr);
  if (nftSupply <= 0n) {
    console.error('nft supply must be positive');
    process.exit(1);
  }
  const buybackReceiver = new PublicKey(receiverStr);
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
  const [revSharePda] = PublicKey.findProgramAddressSync([Buffer.from('rev_share')], programId);
  const [buybackVaultPda] = PublicKey.findProgramAddressSync([Buffer.from('buyback_vault')], programId);

  console.log('config:        ', configPda.toBase58());
  console.log('rev_share:     ', revSharePda.toBase58());
  console.log('buyback_vault: ', buybackVaultPda.toBase58());
  console.log('nft supply:    ', supplyStr);
  console.log('receiver:      ', buybackReceiver.toBase58());

  const tx = await program.methods
    .initRevShare(new anchor.BN(supplyStr), buybackReceiver)
    .accounts({
      config: configPda,
      revShare: revSharePda,
      buybackVault: buybackVaultPda,
      admin: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('init_rev_share tx:', tx);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
