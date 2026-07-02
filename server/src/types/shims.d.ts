// Ambient module shims for optional/native runtime deps that are NOT installed
// in the Vercel build to keep the serverless bundle free of native binaries.

// pdf-to-img pulls in node-canvas (native cairo/pango). PDFService only reaches
// for it via a graceful `await import('pdf-to-img')` inside a try/catch, as a
// scanned-PDF vision-OCR fallback. We leave it uninstalled: the dynamic import
// throws, the catch logs, and text-PDF parsing proceeds normally. This shim
// keeps `tsc` happy without the package present.
declare module 'pdf-to-img';
