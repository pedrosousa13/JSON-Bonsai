// Helpers shared between unit test files. Not a test file itself — vitest only
// collects *.test.ts, so nothing here runs on its own.

// Node reports a floating promise nobody handled through `process`, not through
// jsdom's window — a rejection raised inside module code is created in the Node
// realm, so window.onunhandledrejection never sees it.
export function watchUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", handler);
  return { reasons, stop: () => process.off("unhandledRejection", handler) };
}
