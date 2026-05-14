// Preact island for Privy login.
//
// Stage 1 (this file): minimum surface — login + access token only.
// We deliberately avoid importing @privy-io/react-auth/solana here so
// the bundle stays small (~500 KB instead of ~4 MB; web3.js +
// spl-token only get pulled in by the Solana subpath). The wallet
// address shows up in usePrivy().user.linkedAccounts already without
// the heavier hooks.
//
// Bridge to the vanilla code: window.startQuickjoin(token) is defined
// in plate-shapes.html and triggers the existing netConnect /
// quickjoin flow with the Privy access token attached.

import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';

function shortAddr(addr) {
  if (!addr || addr.length < 9) return addr || '';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

// Pull the user's Solana wallet address out of the linkedAccounts list.
// Privy returns objects of shape { type: 'wallet', chainType: 'solana',
// address: '...' } for both embedded and externally connected wallets.
function pickSolanaAddress(user) {
  if (!user || !Array.isArray(user.linkedAccounts)) return '';
  const acct = user.linkedAccounts.find(
    a => a.type === 'wallet' && a.chainType === 'solana'
  );
  return acct?.address || '';
}

function AuthIsland() {
  const privy = usePrivy();
  const [joining, setJoining] = useState(false);

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
    h('div', { className: 'wallet-badge', title: addr }, shortAddr(addr) || 'wallet…'),
    h('button', {
      id: 'auth-join',
      onClick: handleJoin,
      disabled: joining,
    }, joining ? 'joining…' : 'join'),
    h('button', {
      className: 'logout',
      onClick: () => privy.logout(),
      title: 'log out',
    }, '×'),
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
