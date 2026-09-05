// Ambient runtime declarations for srvx's own sources and tests only.
// The published types reference none of these (see `src/types/README.md`); they
// are kept so the adapter implementations are still checked against the real
// `Bun` / `Deno` / service worker globals.
/// <reference types="bun" />
/// <reference types="deno" />
/// <reference types="serviceworker" />
