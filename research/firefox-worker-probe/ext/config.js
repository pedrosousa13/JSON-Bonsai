// Rewritten by run.mjs on every run so the background script knows which port
// the local probe server is listening on. The committed value is only a default.
globalThis.PROBE_CONFIG = { port: 8731 };
