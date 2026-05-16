// Build script for the Preact bundles. Runs at deploy time on
// Railway (npm run build, auto-detected after npm install) and
// reproduces locally with the same command.
//
// What it does: takes the two Preact entry points (auth.js for the
// lobby login/wallet island, claim.js for the rev-share /claim
// page) and bundles each one together with preact + Privy + web3.js
// + Anchor coder into a single ESM file. React imports get aliased
// to preact/compat at bundle time, so the Privy SDK runs unmodified
// on top of Preact.
//
// Outputs:
//   ./auth.bundle.js   — used by plate-shapes.html
//   ./claim.bundle.js  — used by claim.html
// Both served by the unified static handler the same as any other
// static asset. Self-contained, no runtime CDN, no import map.

const esbuild = require('esbuild');

// Shared build options. Each entry point gets its own outfile but
// otherwise uses identical settings (same React→Preact alias, same
// Buffer polyfill, same env defines).
const sharedOptions = {
  bundle: true,
  format: 'esm',
  minify: true,
  // React-libs introspect this to enable prod paths (drop dev warnings).
  // SOLANA_RPC lets the deploy pipeline inject a real (Helius / QuickNode /
  // Triton) RPC URL — public endpoints are unusable in 2026.
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.SOLANA_RPC': JSON.stringify(process.env.SOLANA_RPC || ''),
    // @solana/web3.js and friends reference `global`. Browsers have
    // `globalThis`; alias it so those refs resolve.
    'global': 'globalThis',
  },
  // Inject the Buffer polyfill at the top of the bundle so any later
  // code that touches the Buffer global (Solana, spl-token, Privy's
  // serialization layer) finds it on globalThis. Without this the
  // browser throws "Can't find variable: Buffer" the first time a
  // transaction is built.
  inject: ['./build-polyfills.js'],
  // Rewrite every react/react-dom import in the dep tree to
  // preact/compat — preact ships a React-compatible API surface that
  // is a drop-in for what Privy expects.
  alias: {
    'react': 'preact/compat',
    'react-dom': 'preact/compat',
    'react/jsx-runtime': 'preact/jsx-runtime',
  },
  // The claim bundle imports the escrow IDL JSON directly — esbuild
  // handles .json natively, no loader needed, but spell out the loader
  // anyway so future contributors don't second-guess it.
  loader: { '.json': 'json' },
  logLevel: 'info',
};

const targets = [
  { entryPoints: ['./auth.js'],  outfile: './auth.bundle.js'  },
  { entryPoints: ['./claim.js'], outfile: './claim.bundle.js' },
];

Promise.all(targets.map(t => esbuild.build({ ...sharedOptions, ...t })))
  .then(() => {
    for (const t of targets) console.log('[build]', t.outfile, 'written');
  })
  .catch(err => { console.error(err); process.exit(1); });
