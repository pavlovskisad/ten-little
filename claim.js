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

// Standard Solana RPC for getAccountInfo (config + rev-share + claim
// state PDAs). The public api.devnet.solana.com is rate-limited to
// the point of unusability during the test window, so we default to
// the same Helius endpoint that handles getAssetsByOwner — it also
// serves standard RPC methods.
const ESCROW_RPC = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('escrowRpc') ||
    'https://devnet.helius-rpc.com/?api-key=f06fa0f0-ba74-43b6-afef-dfa9928341cc';
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
  const [rawAssets, setRawAssets] = useState(null);
  const [revShare, setRevShare] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  // Temporary debug surfaces — visible in-page on mobile while
  // figuring out why fetches hang. Each entry: 'pending' | 'ok …' |
  // 'err …'. Remove once the load reliably works.
  const [dbg, setDbg] = useState({ config: 'pending', revShare: 'pending', assets: 'pending' });
  const setDbgKey = (key, value) => setDbg(prev => ({ ...prev, [key]: value }));

  const conn = new Connection(ESCROW_RPC, 'confirmed');
  const owner = privy.user ? pickSolanaAddress(privy.user) : '';

  useEffect(() => {
    if (!privy.authenticated || !owner) return;
    let alive = true;
    setDbg({ config: 'pending', revShare: 'pending', assets: 'pending' });
    // Each fetch runs independently so a hang in one doesn't block
    // the other two from rendering. Also lets the debug panel show
    // which one is the bottleneck.
    fetchConfig(conn).then(
      cfg => {
        if (!alive) return;
        setConfig(cfg);
        // Surface decoded keys + nft_collection value (both casings)
        // so a snake_case ↔ camelCase mismatch is visible.
        if (cfg) {
          const keys = Object.keys(cfg).join(',');
          const nc = (cfg.nftCollection || cfg.nft_collection);
          const ncStr = nc ? (nc.toBase58 ? nc.toBase58() : String(nc)) : 'undef';
          setDbgKey('config', 'ok keys=' + keys + ' nc=' + ncStr);
        } else {
          setDbgKey('config', 'ok (null)');
        }
      },
      err => { if (alive) setDbgKey('config', 'err ' + (err.message || err)); },
    );
    fetchRevShareState(conn).then(
      rs => { if (alive) { setRevShare(rs); setDbgKey('revShare', rs ? 'ok' : 'ok (null)'); } },
      err => { if (alive) setDbgKey('revShare', 'err ' + (err.message || err)); },
    );
    fetchOwnedAssets(owner).then(
      items => {
        if (!alive) return;
        setDbgKey('assets', 'ok ' + items.length + ' raw');
        // Filtering happens once both rawAssets and config have arrived,
        // handled in a separate effect below.
        setRawAssets(items);
      },
      err => { if (alive) { setDbgKey('assets', 'err ' + (err.message || err)); setError(err.message || 'failed to load'); } },
    );
    return () => { alive = false; };
  }, [privy.authenticated, owner, refreshKey]);

  // Filter raw assets to the configured collection once both config
  // and raw asset list are in.
  useEffect(() => {
    if (rawAssets === null || config === null) return;
    const nc = config.nftCollection || config.nft_collection;
    const collectionMint = nc ? nc.toBase58() : null;
    const filtered = collectionMint
      ? rawAssets.filter(a => nftBelongsToCollection(a, collectionMint))
      : [];
    setAssets(filtered);
  }, [rawAssets, config]);

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

  const totalRaw = revShare && (revShare.totalAccruedPerUnit || revShare.total_accrued_per_unit);
  const supplyRaw = revShare && (revShare.nftSupply || revShare.nft_supply);
  const total = totalRaw ? BigInt(totalRaw.toString()) : 0n;
  const supply = supplyRaw ? Number(supplyRaw) : 0;
  const ncField = config && (config.nftCollection || config.nft_collection);
  const collectionMint = ncField ? ncField.toBase58() : null;
  const showNoConfig = config !== null
    && (!collectionMint || collectionMint === '11111111111111111111111111111111');

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
    // Temporary debug panel — surfaces per-fetch status on mobile so
    // we can see which RPC call is stalling. Remove once stable.
    h('pre', {
      style: 'background:#1a1410;color:#ffd000;padding:8px;border:1px solid #ffd000;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:8px 0;',
    }, [
      'rpc: ' + ESCROW_RPC + '\n',
      'helius: ' + HELIUS_RPC + '\n',
      'owner: ' + owner + '\n',
      'config:    ' + dbg.config + '\n',
      'revShare:  ' + dbg.revShare + '\n',
      'assets:    ' + dbg.assets,
    ].join('')),
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
