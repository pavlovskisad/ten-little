// Preact island for Privy login + wallet drawer.
//
// Stage 1: login + access token (already shipped).
// Stage 2 (this version): wallet drawer with full address + copy +
//   live SOL balance.
// Stage 3 (next): send SOL form.
//
// Bridge to the vanilla code: window.startQuickjoin(token) is defined
// in plate-shapes.html and triggers the existing netConnect /
// quickjoin flow with the Privy access token attached.

import { h, render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';
// Public mainnet RPC. Rate-limited; sufficient for read-only balance
// polling while a drawer is open. Phase B will swap in an authenticated
// endpoint for the heavier escrow traffic.
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1_000_000_000;

function shortAddr(addr) {
  if (!addr || addr.length < 9) return addr || '';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

// Privy returns { type:'wallet', chainType:'solana', address } in
// user.linkedAccounts for both embedded and externally connected
// Solana wallets.
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
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return (data.result?.value ?? 0) / LAMPORTS_PER_SOL;
  } catch (err) {
    console.warn('[wallet] balance fetch failed:', err.message);
    return null;
  }
}

function WalletDrawer({ address, onClose }) {
  const [balance, setBalance] = useState(null);
  const [copied, setCopied] = useState(false);

  // Poll balance every 10 s while the drawer is open. First fetch
  // runs immediately on mount.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const b = await fetchBalance(address);
      if (alive) setBalance(b);
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [address]);

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / private mode — show the address selected so
      // the user can long-press to copy themselves.
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
        h('div', { className: 'wd-balance' },
          balance == null ? '…' : balance.toFixed(4) + ' SOL'
        ),
      ]),
      h('div', { className: 'wd-row wd-actions' }, [
        h('button', {
          className: 'wd-send',
          disabled: true,
          title: 'coming next',
        }, 'send · soon'),
      ]),
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

  if (!privy.authenticated) {
    return h('button', {
      id: 'auth-login',
      onClick: () => privy.login(),
    }, 'log in to join');
  }

  const addr = pickSolanaAddress(privy.user);
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

  return h('div', { className: 'auth-loggedin' }, [
    h('button', {
      className: 'wallet-badge',
      title: addr || 'wallet',
      onClick: () => addr && setDrawerOpen(true),
    }, shortAddr(addr) || 'wallet…'),
    h('button', {
      id: 'auth-join',
      onClick: handleJoin,
      disabled: joining,
    }, joining ? 'joining…' : 'join'),
    h('button', {
      className: 'logout',
      onClick: () => privy.logout(),
      title: 'log out',
    }, 'log out'),
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
