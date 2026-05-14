// Calls init_config on a freshly deployed escrow program. Idempotent —
// if the ProgramConfig PDA is already initialized, this errors out and
// the wrapper script swallows the failure.
//
// Usage: node init-config.js <programId> <oraclePubkey> <rpcUrl> <deployKeypairPath>

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

async function main() {
  const [, , programIdStr, oracleStr, rpcUrl, keypairPath] = process.argv;
  if (!programIdStr || !oracleStr || !rpcUrl || !keypairPath) {
    console.error('usage: init-config.js <programId> <oracle> <rpcUrl> <keypairPath>');
    process.exit(1);
  }

  const programId = new PublicKey(programIdStr);
  const oracle = new PublicKey(oracleStr);
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
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
  const [rakeVaultPda] = PublicKey.findProgramAddressSync([Buffer.from('rake_vault')], programId);

  console.log('config PDA:    ', configPda.toBase58());
  console.log('rake_vault PDA:', rakeVaultPda.toBase58());

  const tx = await program.methods
    .initConfig(oracle)
    .accounts({
      config: configPda,
      rakeVault: rakeVaultPda,
      admin: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('init_config tx:', tx);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
