// Mints a test Metaplex collection on devnet:
//   - one collection-parent NFT (is_collection=true)
//   - N member NFTs, each with collection={key: parent, verified: false}
//   - then verifyCollectionV1 for each member so metadata.collection.verified=true
//
// Why verified matters: claim_rev_share's on-chain Metaplex parser
// asserts collection.verified == true AND collection.key == config.nft_collection.
// Unverified members are indistinguishable from someone claiming a
// random collection, so the program rejects them.
//
// All NFTs are minted directly into the target owner's wallet (the
// Privy wallet you'll log in with on /claim). The script is fire-and-
// forget — addresses are random keypairs per run, so re-running mints
// a brand new collection.
//
// Usage:
//   node mint-test-collection.js <ownerPubkey> <count> <rpcUrl> <payerKeypairPath>
//
// Example (devnet):
//   node scripts/mint-test-collection.js \
//     <yourPrivyWallet> \
//     10 \
//     https://api.devnet.solana.com \
//     ~/.config/solana/id.json

const fs = require('fs');
const {
  createUmi,
} = require('@metaplex-foundation/umi-bundle-defaults');
const {
  keypairIdentity,
  generateSigner,
  publicKey,
  some,
  percentAmount,
} = require('@metaplex-foundation/umi');
const {
  mplTokenMetadata,
  createNft,
  verifyCollectionV1,
  findMetadataPda,
} = require('@metaplex-foundation/mpl-token-metadata');

// Tiny inline image so the NFTs render with *something* in wallets /
// explorers. URI is data: so the script doesn't need an upload step.
// Each token uses the same image; only the on-chain mint differs.
const METADATA_URI = 'data:application/json;base64,' + Buffer.from(JSON.stringify({
  name: 'ten little test',
  symbol: 'TLT',
  description: 'Devnet test NFT for the ten little rev-share claim flow.',
  image: 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="100%" height="100%" fill="#14110d"/>' +
    '<text x="50%" y="50%" font-family="monospace" font-size="22" fill="#ffd000" ' +
    'text-anchor="middle" dominant-baseline="middle">ten little</text>' +
    '</svg>',
  ).toString('base64'),
  attributes: [{ trait_type: 'cluster', value: 'devnet' }],
})).toString('base64');

async function main() {
  const [, , ownerStr, countStr, rpcUrl, keypairPath] = process.argv;
  if (!ownerStr || !countStr || !rpcUrl || !keypairPath) {
    console.error('usage: mint-test-collection.js <ownerPubkey> <count> <rpcUrl> <payerKeypairPath>');
    process.exit(1);
  }
  const count = parseInt(countStr, 10);
  if (!Number.isFinite(count) || count < 1) {
    console.error('count must be a positive integer');
    process.exit(1);
  }

  const owner = publicKey(ownerStr);
  const secret = JSON.parse(fs.readFileSync(keypairPath.replace(/^~/, process.env.HOME || ''), 'utf8'));
  const umi = createUmi(rpcUrl).use(mplTokenMetadata());
  const payer = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(secret));
  umi.use(keypairIdentity(payer));

  console.log('payer:     ', payer.publicKey);
  console.log('owner:     ', owner);
  console.log('rpc:       ', rpcUrl);
  console.log('count:     ', count);

  // --- 1. collection parent ---
  const collectionMint = generateSigner(umi);
  console.log('\nminting collection NFT…');
  const parentSig = await createNft(umi, {
    mint: collectionMint,
    name: 'ten little test collection',
    symbol: 'TLT',
    uri: METADATA_URI,
    sellerFeeBasisPoints: percentAmount(0),
    isCollection: true,
    tokenOwner: owner,
  }).sendAndConfirm(umi);
  console.log('  collection mint:', collectionMint.publicKey);
  console.log('  tx:             ', parentSig.signature ? Buffer.from(parentSig.signature).toString('hex') : '(confirmed)');

  // --- 2. member NFTs ---
  const members = [];
  for (let i = 0; i < count; i++) {
    const memberMint = generateSigner(umi);
    process.stdout.write(`  member ${i + 1}/${count} `);
    await createNft(umi, {
      mint: memberMint,
      name: `ten little #${i + 1}`,
      symbol: 'TLT',
      uri: METADATA_URI,
      sellerFeeBasisPoints: percentAmount(0),
      collection: some({ key: collectionMint.publicKey, verified: false }),
      tokenOwner: owner,
    }).sendAndConfirm(umi);
    process.stdout.write('minted, verifying… ');
    // verifyCollectionV1 flips collection.verified = true. Without it,
    // the on-chain claim_rev_share check rejects the NFT.
    await verifyCollectionV1(umi, {
      metadata: findMetadataPda(umi, { mint: memberMint.publicKey }),
      collectionMint: collectionMint.publicKey,
      authority: umi.identity, // payer == update authority by default
    }).sendAndConfirm(umi);
    console.log('verified  →', memberMint.publicKey);
    members.push(memberMint.publicKey);
  }

  console.log('\n===========================');
  console.log('TEST COLLECTION MINTED');
  console.log('collection mint:', collectionMint.publicKey);
  console.log('member count:   ', members.length);
  console.log('owner:          ', owner);
  console.log('===========================');
  console.log('\nnext step:');
  console.log('  node scripts/set-nft-collection.js \\');
  console.log('    <programId> \\');
  console.log('    ' + collectionMint.publicKey + ' \\');
  console.log('    ' + rpcUrl + ' \\');
  console.log('    ' + keypairPath);
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
