/**
 * Host network faults (Task 23.6, C21 triage). A request the browser could not even send, because the host's network stack
 * refused a socket (Windows WSAENOBUFS is Chrome's net::ERR_NO_BUFFER_SPACE), is an infrastructure fault: no product code or
 * policy ran. Seen on 2026-10-19 in the first production gate after a development suite: one framework chunk of the static
 * export failed so, the page never hydrated, and a 5 s expectation timed out. tests/browser/fixtures.ts names such a fault on
 * the failed test, and scripts/verify.mjs then discards the run and runs the browser step once more.
 */
export const HOST_FAULT = /net::ERR_(?:NO_BUFFER_SPACE|INSUFFICIENT_RESOURCES|ADDRESS_IN_USE)\b/;
/** The marker scripts/verify.mjs looks for in a failed test's errors. */
export const HOST_FAULT_MARKER = 'Infrastructure fault, not product evidence:';
export const isHostFault = (errorText: string | undefined | null) => HOST_FAULT.test(errorText ?? '');
