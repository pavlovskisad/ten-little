// Preact island for Privy login + wallet UI.
//
// This file is the only React-API code in the project. Everything else
// (game loop, three.js scene, network reconcile) stays vanilla. We use
// Preact instead of React for the ~3 KB footprint and a drop-in compat
// shim so @privy-io/react-auth runs unmodified on top.
//
// Bridge to the vanilla code: window.startQuickjoin(token) is defined
// in plate-shapes.html and triggers the existing netConnect /
// quickjoin flow with the Privy access token attached. The Preact
// island just calls it once the user is logged in.

import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useSolanaWallets } from '@privy-io/react-auth/solana';

const PRIVY_APP_ID = 'cmp5itgpu000j0dk4zp6r05rs';

function shortAddr(addr) {
  if (!addr || addr.length < 9) return addr || '';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function AuthIsland() {
  const privy = usePrivy();
  const { wallets } = useSolanaWallets();
  const [joining, setJoining] = useState(false);

  // SDK isn't ready yet — Privy fetches its iframe + config on mount.
  if (!privy.ready) {
    return h('div', { className: 'auth-loading' }, '…');
  }

  if (!privy.authenticated) {
    return h('button', {
      id: 'auth-login',
      onClick: () => privy.login(),
    }, 'log in to join');
  }

  const addr = wallets[0]?.address || '';
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
      disabled: joining || !addr,
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
