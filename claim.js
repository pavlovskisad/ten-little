// Preact app for the claim page. Standalone from auth.js — different
// page, different mount. Imports the heavy stuff (Privy, web3.js,
// Anchor coder) so it can read on-chain state + sign claim_rev_share
// transactions.
//
// What it does:
//   1. Privy login (same app id as the game).
//   2. Fetch the user's NFTs from the configured collection via
//      Helius's getAssetsByOwner RPC method.
//   3. For each NFT, derive the ClaimState PDA and read it (if it
//      exists). Compute claimable amount = (rev_share.total_accrued
//      - claim_state.last_claimed) / PRECISION.
//   4. Per-NFT claim button: builds claim_rev_share instruction,
//      signs via Privy, submits.

import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useSolanaWallets } from '@privy-io/react-auth/solana';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { BorshCoder, BorshAccountsCoder } from '@coral-xyz/anchor';
import escrowIdl from './contracts/escrow/target/idl/escrow.json';

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';
const ESCROW_PROGRAM_ID = new PublicKey('DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z');
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const ESCROW_RPC = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('escrowRpc') || 'https://api.devnet.solana.com';
})();
// Helius RPC for getAssetsByOwner. Hardcoded devnet key during the
// devnet-testing window; flip to mainnet alongside the program promotion.
const HELIUS_RPC = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('helius') ||
    'https://devnet.helius-rpc.com/?api-key=f06fa0f0-ba74-43b6-afef-dfa9928341cc';
})();

const _coder = new BorshCoder(escrowIdl);
const _accountsCoder = new BorshAccountsCoder(escrowIdl);

function shortAddr(addr) {
  if (!addr || addr.length < 9) return addr || '';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function pickSolanaAddress(user) {
  if (!user || !Array.isArray(user.linkedAccounts)) return '';
  const acct = user.linkedAccounts.find(
    a => a.type === 'wallet' && a.chainType === 'solana'
  );
  return acct?.address || '';
}

function findPda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function configPda() { return findPda([Buffer.from('config')], ESCROW_PROGRAM_ID); }
function revSharePda() { return findPda([Buffer.from('rev_share')], ESCROW_PROGRAM_ID); }
function claimStatePda(nftMint) {
  return findPda([Buffer.from('claim'), new PublicKey(nftMint).toBytes()], ESCROW_PROGRAM_ID);
}
function metadataPda(nftMint) {
  return findPda([
    Buffer.from('metadata'),
    MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
    new PublicKey(nftMint).toBytes(),
  ], MPL_TOKEN_METADATA_PROGRAM_ID);
}
function associatedTokenAddress(owner, nftMint) {
  return findPda([
    new PublicKey(owner).toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(),
    new PublicKey(nftMint).toBuffer(),
  ], ASSOCIATED_TOKEN_PROGRAM_ID);
}

// Bigint-safe division for u128 accumulator values. PRECISION = 1e12.
const PRECISION = 1_000_000_000_000n;

async function fetchAccountRaw(pubkey, conn) {
  const info = await conn.getAccountInfo(new PublicKey(pubkey), 'confirmed');
  return info && info.data ? Buffer.from(info.data) : null;
}

async function fetchRevShareState(conn) {
  const data = await fetchAccountRaw(revSharePda(), conn);
  if (!data) return null;
  return _accountsCoder.decode('RevShareState', data);
}

async function fetchClaimState(nftMint, conn) {
  const data = await fetchAccountRaw(claimStatePda(nftMint), conn);
  if (!data) return null;
  return _accountsCoder.decode('ClaimState', data);
}

async function fetchConfig(conn) {
  const data = await fetchAccountRaw(configPda(), conn);
  if (!data) return null;
  return _accountsCoder.decode('ProgramConfig', data);
}

// Helius DAS getAssetsByOwner — returns the user's NFTs. We filter
// client-side to the configured collection.
async function fetchOwnedAssets(ownerAddress) {
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'claim', method: 'getAssetsByOwner',
      params: {
        ownerAddress,
        page: 1, limit: 1000,
        displayOptions: { showCollectionMetadata: false },
      },
    }),
  });
  if (!res.ok) throw new Error('helius rpc ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'helius error');
  return json.result?.items || [];
}

function nftBelongsToCollection(asset, collectionMint) {
  if (!asset.grouping || !Array.isArray(asset.grouping)) return false;
  return asset.grouping.some(
    g => g.group_key === 'collection' && g.group_value === collectionMint
  );
}

function ClaimRow({ asset, total, conn, wallet, configCollection, onClaimed }) {
  const [claimState, setClaimState] = useState(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');

  useEffect(() => {
    let alive = true;
    fetchClaimState(asset.id, conn).then(cs => { if (alive) setClaimState(cs); });
    return () => { alive = false; };
  }, [asset.id]);

  const lastClaimed = claimState ? BigInt(claimState.lastClaimedPerUnit.toString()) : 0n;
  const delta = total > lastClaimed ? total - lastClaimed : 0n;
  const lamports = Number(delta / PRECISION);
  const sol = lamports / LAMPORTS_PER_SOL;
  const hasClaim = lamports > 0;

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const nftMint = new PublicKey(asset.id);
      const claimerPk = new PublicKey(wallet.address);
      const data = _coder.instruction.encode('claim_rev_share', {});
      const keys = [
        { pubkey: configPda(), isSigner: false, isWritable: false },
        { pubkey: revSharePda(), isSigner: false, isWritable: true },
        { pubkey: nftMint, isSigner: false, isWritable: false },
        { pubkey: associatedTokenAddress(claimerPk, nftMint), isSigner: false, isWritable: false },
        { pubkey: metadataPda(nftMint), isSigner: false, isWritable: false },
        { pubkey: claimStatePda(nftMint), isSigner: false, isWritable: true },
        { pubkey: claimerPk, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const ix = new TransactionInstruction({ programId: ESCROW_PROGRAM_ID, keys, data });
      const tx = new Transaction().add(ix);
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = claimerPk;
      const sig = await wallet.sendTransaction(tx, conn);
      const sigStr = typeof sig === 'string' ? sig : (sig?.signature || 'sent');
      setSignature(sigStr);
      onClaimed && onClaimed();
      // Refresh local claim state so the row reflects the new cursor.
      const cs = await fetchClaimState(asset.id, conn);
      setClaimState(cs);
    } catch (err) {
      console.warn('[claim] failed:', err);
      setError((err.message || 'claim failed').slice(0, 120));
    } finally {
      setBusy(false);
    }
  };

  return h('div', { className: 'claim-row' }, [
    h('div', { className: 'claim-mint' }, shortAddr(asset.id)),
    h('div', { className: 'claim-amount' },
      claimState === undefined ? '…'
        : hasClaim ? `${sol.toFixed(6)} SOL`
        : 'nothing yet'
    ),
    h('button', {
      className: 'claim-btn',
      onClick: claim,
      disabled: busy || !hasClaim,
    }, busy ? 'claiming…' : 'claim'),
    error && h('div', { className: 'claim-error' }, error),
    signature && h('div', { className: 'claim-sig' }, 'sent · ' + shortAddr(signature)),
  ]);
}

function ClaimPage() {
  const privy = usePrivy();
  const { wallets } = useSolanaWallets();
  const wallet = wallets?.[0];
  const [assets, setAssets] = useState(null);
  const [revShare, setRevShare] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const conn = new Connection(ESCROW_RPC, 'confirmed');
  const owner = privy.user ? pickSolanaAddress(privy.user) : '';

  useEffect(() => {
    if (!privy.authenticated || !owner) return;
    let alive = true;
    (async () => {
      try {
        const [cfg, rs, items] = await Promise.all([
          fetchConfig(conn),
          fetchRevShareState(conn),
          fetchOwnedAssets(owner),
        ]);
        if (!alive) return;
        setConfig(cfg);
        setRevShare(rs);
        const collectionMint = cfg && cfg.nftCollection ? cfg.nftCollection.toBase58() : null;
        const filtered = collectionMint
          ? items.filter(a => nftBelongsToCollection(a, collectionMint))
          : [];
        setAssets(filtered);
      } catch (err) {
        if (alive) setError(err.message || 'failed to load');
      }
    })();
    return () => { alive = false; };
  }, [privy.authenticated, owner, refreshKey]);

  if (!privy.ready) {
    return h('div', { className: 'claim-loading' }, 'loading…');
  }
  if (!privy.authenticated) {
    return h('div', { className: 'claim-gate' }, [
      h('h1', null, 'rev-share claim'),
      h('p', null, 'log in with the wallet that holds your collection NFTs to view + claim accumulated SOL.'),
      h('button', { className: 'claim-cta', onClick: () => privy.login() }, 'log in'),
    ]);
  }

  const total = revShare ? BigInt(revShare.totalAccruedPerUnit.toString()) : 0n;
  const supply = revShare ? Number(revShare.nftSupply) : 0;
  const collectionMint = config && config.nftCollection ? config.nftCollection.toBase58() : null;
  const showNoConfig = !collectionMint || collectionMint === '11111111111111111111111111111111';

  return h('div', { className: 'claim-page' }, [
    h('div', { className: 'claim-top' }, [
      h('span', { className: 'claim-wallet' }, shortAddr(owner)),
      h('button', { className: 'claim-logout', onClick: () => privy.logout() }, 'log out'),
    ]),
    h('h1', null, 'rev-share claim'),
    h('div', { className: 'claim-pool' }, [
      h('div', { className: 'claim-stat' }, [
        h('span', { className: 'claim-stat-label' }, 'per-nft accrued'),
        h('span', { className: 'claim-stat-value' },
          revShare ? `${(Number(total / PRECISION) / LAMPORTS_PER_SOL).toFixed(6)} SOL` : '…'
        ),
      ]),
      h('div', { className: 'claim-stat' }, [
        h('span', { className: 'claim-stat-label' }, 'collection supply'),
        h('span', { className: 'claim-stat-value' }, supply || '…'),
      ]),
    ]),
    showNoConfig && h('div', { className: 'claim-warn' },
      'collection mint not configured on chain yet — admin runs set_nft_collection to enable claims.'
    ),
    error && h('div', { className: 'claim-error' }, error),
    assets === null && !error && h('div', { className: 'claim-loading' }, 'loading your nfts…'),
    assets !== null && assets.length === 0 && !showNoConfig && h('div', { className: 'claim-empty' },
      'you don\'t hold any nfts from the configured collection on this network.'
    ),
    assets !== null && assets.length > 0 && h('div', { className: 'claim-list' },
      assets.map(asset => h(ClaimRow, {
        key: asset.id,
        asset,
        total,
        conn,
        wallet,
        configCollection: collectionMint,
        onClaimed: () => setRefreshKey(k => k + 1),
      }))
    ),
  ]);
}

function App() {
  return h(PrivyProvider, {
    appId: PRIVY_APP_ID,
    config: {
      loginMethods: ['email', 'wallet'],
      embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
      appearance: { theme: 'dark', accentColor: '#ff1a1a' },
    },
  }, h(ClaimPage));
}

render(h(App), document.getElementById('claim-root'));
