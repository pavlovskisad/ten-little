// Buffer polyfill — @solana/web3.js (and many other npm packages
// targeting Node) reference the Buffer global. Browsers don't have
// it. esbuild's `inject` option pulls this file in at the top of the
// bundle so the assignment runs before any imported code touches
// Buffer.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
