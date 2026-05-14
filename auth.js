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
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';
// Solana mainnet RPC. The official api.mainnet-beta.solana.com is
// 403-throttling free traffic now, so we default to Ankr's public
// endpoint (no API key, sufficient for getBalance + the occasional
// SystemProgram.transfer). Override per-load with ?rpc=<url> for
// devnet testing or a paid endpoint.
const SOLANA_RPC = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('rpc') || 'https://rpc.ankr.com/solana';
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

async function fetchBalance(address) {
  try {
    const res = await fetch(SOLANA_RPC, {
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
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { wallets } = useSolanaWallets();
  const wallet = wallets?.find(w => w.address === address) || wallets?.[0];

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const b = await fetchBalance(address);
      if (alive) setBalance(b);
    };
    tick();
    const id = setInterval(tick, 10000);
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
        h('div', { className: 'wd-label' }, 'balance'),
        h('div', {
          className: 'wd-balance' + (balance && balance.ok === false ? ' wd-balance-err' : ''),
        },
          balance == null ? '…'
            : balance.ok ? balance.sol.toFixed(4) + ' SOL'
            : 'rpc error: ' + (balance.error || 'unknown')
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
  const [joining, setJoining] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      }, shortAddr(addr) || 'wallet…'),
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
