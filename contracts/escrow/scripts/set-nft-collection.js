// One-shot admin: flip ProgramConfig.nft_collection to a specific
// collection mint. Required before the first claim_rev_share call —
// without it, every claim fails the Metaplex collection check
// against Pubkey::default() == 111…11.
//
// Usage:
//   node set-nft-collection.js <programId> <collectionMint> <rpcUrl> <adminKeypairPath>
//
// Example (devnet):
//   node scripts/set-nft-collection.js \
//     DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z \
//     <mint_from_mint-test-collection.js> \
//     https://api.devnet.solana.com \
//     ~/.config/solana/id.json
//
// The admin keypair is whoever signed init_config (the deploy keypair
// in the default deploy-devnet.sh flow). On-chain validation in
// AdminUpdate enforces admin==config.admin, so this errors with
// "ConstraintHasOne" if you sign with the wrong key.

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');

async function main() {
  const [, , programIdStr, collectionStr, rpcUrl, keypairPath] = process.argv;
  if (!programIdStr || !collectionStr || !rpcUrl || !keypairPath) {
    console.error('usage: set-nft-collection.js <programId> <collectionMint> <rpcUrl> <keypairPath>');
    process.exit(1);
  }
  const programId = new PublicKey(programIdStr);
  const collection = new PublicKey(collectionStr);
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

  console.log('config:    ', configPda.toBase58());
  console.log('collection:', collection.toBase58());
  console.log('admin:     ', wallet.publicKey.toBase58());

  const tx = await program.methods
    .setNftCollection(collection)
    .accounts({
      config: configPda,
      admin: wallet.publicKey,
    })
    .rpc();
  console.log('set_nft_collection tx:', tx);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
