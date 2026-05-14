// Build script for auth.bundle.js. Runs at deploy time on Railway
// (npm run build, auto-detected after npm install) and reproduces
// locally with the same command.
//
// What it does: takes auth.js (Preact + Privy island source) and
// bundles it together with preact + @privy-io/react-auth +
// @solana/web3.js into a single ESM file. React imports get aliased
// to preact/compat at bundle time, so the Privy SDK runs unmodified
// on top of Preact.
//
// Output: ./auth.bundle.js — served by the unified static handler
// the same as any other static asset. Self-contained, no runtime
// CDN, no import map, ~300-500 KB minified.

const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./auth.js'],
  bundle: true,
  format: 'esm',
  outfile: './auth.bundle.js',
  minify: true,
  // React-libs introspect this to enable prod paths (drop dev warnings).
  define: { 'process.env.NODE_ENV': '"production"' },
  // Rewrite every react/react-dom import in the dep tree to
  // preact/compat — preact ships a React-compatible API surface that
  // is a drop-in for what Privy expects.
  alias: {
    'react': 'preact/compat',
    'react-dom': 'preact/compat',
    'react/jsx-runtime': 'preact/jsx-runtime',
  },
  logLevel: 'info',
}).then(() => console.log('[build] auth.bundle.js written'))
  .catch(err => { console.error(err); process.exit(1); });
