#!/usr/bin/env bash
# Devnet deploy + bootstrap for the escrow program.
#
# Run this from the contracts/escrow/ directory on a machine that has
# anchor + solana CLI installed and outbound RPC to api.devnet.solana.com
# (sandboxed dev boxes block this; user's Mac works).
#
# What it does:
#   1. Confirms the local solana config is pointing at devnet.
#   2. Airdrops SOL to the deploy keypair if balance is low.
#   3. Builds the program (idempotent if already built).
#   4. Deploys to devnet (or upgrades if the program account already
#      exists at the locked program ID).
#   5. Calls init_config with the deploy keypair as both admin and
#      oracle by default — adjust ORACLE_PUBKEY below if the server's
#      keypair is separate.
#
# After this script succeeds, copy the program ID + the IDL into the
# server config and the client bundle.

set -euo pipefail

cd "$(dirname "$0")/.."   # contracts/escrow/

# ----- config -----
CLUSTER="${CLUSTER:-devnet}"
DEPLOY_KEYPAIR="${DEPLOY_KEYPAIR:-$HOME/.config/solana/id.json}"
# Default: same key as deploy. Set ORACLE_PUBKEY to the server's
# keypair pubkey to use a separate oracle.
ORACLE_PUBKEY="${ORACLE_PUBKEY:-$(solana-keygen pubkey "$DEPLOY_KEYPAIR")}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"

echo "[deploy] cluster=$CLUSTER"
echo "[deploy] keypair=$DEPLOY_KEYPAIR"
echo "[deploy] oracle=$ORACLE_PUBKEY"
echo "[deploy] rpc=$RPC_URL"

solana config set --url "$RPC_URL" --keypair "$DEPLOY_KEYPAIR" >/dev/null

# ----- airdrop if low -----
BALANCE_SOL=$(solana balance --output json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("value",0))' || echo 0)
if (( $(echo "$BALANCE_SOL < 5" | bc -l 2>/dev/null || echo 0) )); then
  echo "[deploy] balance=$BALANCE_SOL SOL — requesting airdrop"
  solana airdrop 5 || echo "[deploy] airdrop failed (devnet faucet rate-limit?). Top up via https://faucet.solana.com if needed."
fi
echo "[deploy] balance: $(solana balance)"

# ----- build -----
echo "[deploy] anchor build"
anchor build

PROGRAM_ID=$(solana address -k target/deploy/escrow-keypair.json)
echo "[deploy] program id: $PROGRAM_ID"

# ----- deploy / upgrade -----
echo "[deploy] anchor deploy --provider.cluster $CLUSTER"
anchor deploy --provider.cluster "$CLUSTER" --provider.wallet "$DEPLOY_KEYPAIR"

# ----- init_config (idempotent — fails benignly if already initialized) -----
echo "[deploy] init_config (oracle=$ORACLE_PUBKEY)"
node scripts/init-config.js "$PROGRAM_ID" "$ORACLE_PUBKEY" "$RPC_URL" "$DEPLOY_KEYPAIR" || \
  echo "[deploy] init_config skipped (already initialized?)"

echo
echo "==========================="
echo "DEPLOY COMPLETE"
echo "Program ID: $PROGRAM_ID"
echo "Oracle:     $ORACLE_PUBKEY"
echo "Cluster:    $CLUSTER"
echo "==========================="
echo
echo "Next: paste the program ID + commit target/idl/escrow.json so the"
echo "server / client can wire up to the on-chain program."
