import { setupNetwork } from "@msw/cloudflare";

// Shared MSW network for outbound-HTTP tests. Import in a test file and:
//   beforeAll(async () => { await network.enable(); });
//   afterEach(() => network.resetHandlers());
//   afterAll(async () => { await network.disable(); });
// then register the exact HTTP interactions the test expects with network.use().
// `onUnhandledFrame: "error"` makes any unmocked outbound request fail the test
// instead of touching the real network (free-tier rule: zero network in tests).
export const network = setupNetwork();
network.configure({ onUnhandledFrame: "error" });
