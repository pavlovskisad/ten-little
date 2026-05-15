// Preact island for Privy login + wallet drawer + send SOL.
//
// Layout:
//  - #auth-root inside the lobby panel: renders the main action
//    button ("log in to join" or "join").
//  - .auth-corner fixed top-right of the viewport: wallet badge +
//    "log out" button, shown only when authenticated. Travels with
//    the user across screens (title, lobby, game).
//  - WalletDrawer is a modal overlay anchored center; opens when the
//    user taps the wallet badge.
//
// Bridge to the vanilla code: window.startQuickjoin(token) is defined
// in plate-shapes.html and triggers the existing netConnect /
// quickjoin flow with the Privy access token attached.

import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
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
import { BorshCoder } from '@coral-xyz/anchor';
import escrowIdl from './contracts/escrow/target/idl/escrow.json';

// Program ID locked at devnet deploy. Server's address must match.
const ESCROW_PROGRAM_ID = new PublicKey('DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z');
// Separate RPC for escrow tx submission. SOLANA_RPC stays mainnet for
// the wallet drawer's balance display; ESCROW_RPC follows the program
// (devnet today; flip to mainnet when the program is redeployed there).
// Override via ?escrowRpc=… for testing.
const ESCROW_RPC = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('escrowRpc') || 'https://api.devnet.solana.com';
})();
const _escrowCoder = new BorshCoder(escrowIdl);

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';
// Solana mainnet RPC. Public endpoints (mainnet-beta.solana.com, ankr)
// are 403-throttling free traffic in 2026. Resolution order:
//   1. ?rpc=<url> query param (per-load override)
//   2. SOLANA_RPC env var, injected at build time by esbuild
//   3. Helius free-tier fallback (rotated by setting the env var)
// The Helius key in the fallback is rate-limited and may be rotated;
// for prod, set SOLANA_RPC on Railway and the env-var path wins.
const SOLANA_RPC = (() => {
  const params = new URLSearchParams(location.search);
  const urlOverride = params.get('rpc');
  if (urlOverride) return urlOverride;
  const envInjected = process.env.SOLANA_RPC;
  if (envInjected) return envInjected;
  return 'https://mainnet.helius-rpc.com/?api-key=f06fa0f0-ba74-43b6-afef-dfa9928341cc';
})();

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

async function fetchBalanceFrom(address, rpcUrl) {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address],
      }),
    });
    if (!res.ok) throw new Error('rpc ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { ok: true, sol: (data.result?.value ?? 0) / LAMPORTS_PER_SOL };
  } catch (err) {
    console.warn('[wallet] balance fetch failed:', err.message);
    return { ok: false, error: err.message };
  }
}
async function fetchBalance(address) {
  return fetchBalanceFrom(address, SOLANA_RPC);
}
async function fetchDevnetBalance(address) {
  return fetchBalanceFrom(address, ESCROW_RPC);
}

function validatePubkey(s) {
  try { new PublicKey(s); return true; } catch { return false; }
}

function SendForm({ fromAddress, wallet, onDone, onCancel }) {
  const [to, setTo] = useState('');
  const [amountSol, setAmountSol] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const submit = async () => {
    setError(''); setSuccess('');
    if (!validatePubkey(to)) { setError('invalid address'); return; }
    const amt = parseFloat(amountSol);
    if (!isFinite(amt) || amt <= 0) { setError('invalid amount'); return; }
    if (!wallet) { setError('wallet not ready'); return; }
    setBusy(true);
    try {
      const conn = new Connection(SOLANA_RPC, 'confirmed');
      const fromKey = new PublicKey(fromAddress);
      const toKey = new PublicKey(to);
      const lamports = Math.round(amt * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: toKey, lamports }),
      );
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromKey;
      // Privy's embedded Solana wallet exposes sendTransaction directly;
      // it signs with the user's embedded key and submits via the
      // provided Connection.
      const sig = await wallet.sendTransaction(tx, conn);
      setSuccess(typeof sig === 'string' ? sig : (sig?.signature || 'sent'));
      onDone && onDone();
    } catch (err) {
      console.warn('[send] failed:', err);
      setError(err.message || 'send failed');
    } finally {
      setBusy(false);
    }
  };

  return h('div', { className: 'wd-send-form' }, [
    h('div', { className: 'wd-row' }, [
      h('div', { className: 'wd-label' }, 'recipient'),
      h('input', {
        className: 'wd-input',
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
        placeholder: 'paste Solana address',
        value: to,
        onInput: e => setTo(e.target.value.trim()),
      }),
    ]),
    h('div', { className: 'wd-row' }, [
      h('div', { className: 'wd-label' }, 'amount (SOL)'),
      h('input', {
        className: 'wd-input',
        type: 'number',
        step: '0.001',
        min: '0',
        placeholder: '0.0',
        value: amountSol,
        onInput: e => setAmountSol(e.target.value),
      }),
    ]),
    error && h('div', { className: 'wd-error' }, error),
    success && h('div', { className: 'wd-success' }, 'sent · ' + shortAddr(success)),
    h('div', { className: 'wd-row wd-actions wd-actions-row' }, [
      h('button', {
        className: 'wd-cancel',
        onClick: onCancel,
        disabled: busy,
      }, 'cancel'),
      h('button', {
        className: 'wd-send',
        onClick: submit,
        disabled: busy || !to || !amountSol,
      }, busy ? 'sending…' : 'confirm'),
    ]),
  ]);
}

function WalletDrawer({ address, onClose }) {
  // balance: { ok: true, sol } | { ok: false, error } | null (still loading)
  const [balance, setBalance] = useState(null);
  const [devBalance, setDevBalance] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { wallets } = useSolanaWallets();
  const wallet = wallets?.find(w => w.address === address) || wallets?.[0];

  // Auto-refresh both balances (mainnet + devnet) every 5 s while
  // the drawer is open. Devnet line stays in the UI as long as the
  // escrow program is on devnet — when we promote to mainnet, the
  // ESCROW_RPC default flips and this line just mirrors the main
  // balance (or we hide it; up to taste).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setRefreshing(true);
      const [b, d] = await Promise.all([
        fetchBalance(address),
        fetchDevnetBalance(address),
      ]);
      if (alive) {
        setBalance(b);
        setDevBalance(d);
        setRefreshing(false);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [address, refreshKey]);

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.warn('[wallet] clipboard write failed');
    }
  };

  return h('div', { className: 'wallet-drawer-backdrop', onClick: onClose },
    h('div', { className: 'wallet-drawer', onClick: e => e.stopPropagation() }, [
      h('div', { className: 'wd-header' }, [
        h('div', { className: 'wd-title' }, 'wallet'),
        h('button', { className: 'wd-close', onClick: onClose, title: 'close' }, '×'),
      ]),
      h('div', { className: 'wd-row' }, [
        h('div', { className: 'wd-label' }, 'address'),
        h('div', { className: 'wd-addr', onClick: copyAddr }, [
          h('span', { className: 'wd-addr-text' }, shortAddr(address)),
          h('span', { className: 'wd-copy-hint' }, copied ? 'copied' : 'tap to copy'),
        ]),
      ]),
      h('div', { className: 'wd-row' }, [
        h('div', { className: 'wd-row-head' }, [
          h('div', { className: 'wd-label' }, 'balance'),
          h('button', {
            className: 'wd-refresh',
            onClick: () => setRefreshKey(k => k + 1),
            disabled: refreshing,
            title: 'refresh balance',
          }, refreshing ? '…' : '↻'),
        ]),
        h('div', {
          className: 'wd-balance'
            + (balance && balance.ok === false ? ' wd-balance-err' : '')
            + (refreshing ? ' wd-balance-fetching' : ''),
        },
          balance == null ? '…'
            : balance.ok ? balance.sol.toFixed(4) + ' SOL'
            : 'rpc error: ' + (balance.error || 'unknown')
        ),
        // Devnet sub-line — same wallet, just on devnet. Useful for
        // verifying entry-fee payments + payouts during testing.
        // Hides itself once devnet balance reads zero and we promote
        // the program to mainnet (ESCROW_RPC default flips).
        h('div', { className: 'wd-balance-sub' },
          devBalance == null ? 'devnet · …'
            : devBalance.ok ? `devnet · ${devBalance.sol.toFixed(4)} SOL`
            : `devnet · rpc error`
        ),
      ]),
      !sending && h('div', { className: 'wd-row wd-actions' }, [
        h('button', {
          className: 'wd-send',
          onClick: () => setSending(true),
          disabled: !wallet,
          title: wallet ? 'send SOL to any address' : 'wallet not ready',
        }, 'send'),
      ]),
      sending && h(SendForm, {
        fromAddress: address,
        wallet,
        onDone: () => { setSending(false); setRefreshKey(k => k + 1); },
        onCancel: () => setSending(false),
      }),
    ]),
  );
}

function AuthIsland() {
  const privy = usePrivy();
  const { wallets } = useSolanaWallets();
  const [joining, setJoining] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Publish a payEntryFee bridge for the vanilla netConnect handler.
  // Called by plate-shapes.html when the server sends a 'joined'
  // message with an escrow payload. Returns the tx signature on
  // success so the vanilla side can forward it to the server in a
  // 'paid' message.
  useEffect(() => {
    if (!privy.authenticated) return;
    const wallet = wallets?.find(w => w.address === pickSolanaAddress(privy.user))
      || wallets?.[0];
    window.payEntryFee = async (escrow) => {
      if (!wallet) throw new Error('wallet not ready');
      // Escrow program lives on the same cluster as ESCROW_RPC.
      // Don't reuse the mainnet SOLANA_RPC here.
      const conn = new Connection(ESCROW_RPC, 'confirmed');
      const playerPk = new PublicKey(wallet.address);
      const potPk = new PublicKey(escrow.pot);
      const data = _escrowCoder.instruction.encode('join_pot', {});
      const ix = new TransactionInstruction({
        programId: ESCROW_PROGRAM_ID,
        keys: [
          { pubkey: potPk, isSigner: false, isWritable: true },
          { pubkey: playerPk, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction().add(ix);
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = playerPk;
      const sig = await wallet.sendTransaction(tx, conn);
      return {
        signature: typeof sig === 'string' ? sig : (sig?.signature || 'sent'),
        wallet: wallet.address,
      };
    };
    return () => { delete window.payEntryFee; };
  }, [privy.authenticated, wallets, privy.user]);

  if (!privy.ready) {
    return h('div', { className: 'auth-loading' }, '…');
  }

  const addr = privy.authenticated ? pickSolanaAddress(privy.user) : '';

  const handleJoin = async () => {
    setJoining(true);
    try {
      const token = await privy.getAccessToken();
      if (!token) throw new Error('no access token');
      window.startQuickjoin(token);
    } catch (err) {
      console.warn('[auth] join failed:', err);
      setJoining(false);
    }
  };

  // Single rendered element; the corner widget uses position:fixed so
  // it lives top-right of the viewport regardless of its DOM ancestry.
  return h('div', null, [
    // Main action button — sits inside the lobby panel.
    !privy.authenticated
      ? h('button', {
          id: 'auth-login',
          onClick: () => privy.login(),
        }, 'log in to join')
      : h('button', {
          id: 'auth-join',
          onClick: handleJoin,
          disabled: joining,
        }, joining ? 'joining…' : 'join'),
    // Wallet + logout pinned top-right when authenticated. Travels
    // across title / lobby / game screens.
    privy.authenticated && h('div', { className: 'auth-corner' }, [
      h('button', {
        className: 'wallet-badge',
        title: addr || 'wallet',
        onClick: () => addr && setDrawerOpen(true),
      }, 'wallet'),
      h('button', {
        className: 'logout',
        onClick: () => privy.logout(),
        title: 'log out',
      }, 'log out'),
    ]),
    drawerOpen && h(WalletDrawer, {
      address: addr,
      onClose: () => setDrawerOpen(false),
    }),
  ]);
}

function App() {
  return h(PrivyProvider, {
    appId: PRIVY_APP_ID,
    config: {
      loginMethods: ['email', 'wallet'],
      embeddedWallets: {
        solana: { createOnLogin: 'users-without-wallets' },
      },
      appearance: {
        theme: 'dark',
        accentColor: '#ff1a1a',
      },
    },
  }, h(AuthIsland));
}

render(h(App), document.getElementById('auth-root'));
