import { Plugin, type StorageEntry } from "@opencode/plugin";
import { pickNew, toEvents, type SessionMessageLike } from "./capture";

const INGEST_PREFIX = "ingest/";
const BATCH_SIZE = 500;
const BACKSTOP_INTERVAL_MS = 30 * 60_000;
const SCAN_PAGE_SIZE = 100;

interface IngestState {
  lastStatus?: string;
  lastStatusAt?: number;
  ids?: string[];
}

type StoredJson = StorageEntry["value"];

/**
 * brain-capture — pushes OpenCode session history into the brain Worker.
 *
 * Options: `{ endpoint, token }` where token is the MCP_PROPOSE credential.
 * Ingest fires when a session goes idle (detected via `session.status` events),
 * with a reconcile backstop that runs on plugin load and every 30 minutes.
 */
const brainCapture = Plugin.define({
  id: "brain-capture",
  async setup(ctx) {
    const endpoint =
      typeof ctx.options?.endpoint === "string" ? ctx.options.endpoint.replace(/\/+$/, "") : undefined;
    const token = typeof ctx.options?.token === "string" ? ctx.options.token : undefined;
    if (!endpoint || !token) {
      console.warn("[brain-capture] disabled: plugin options { endpoint, token } are required");
      return;
    }

    const storageKey = (sessionID: string) => `${INGEST_PREFIX}${sessionID}`;
    const readState = async (sessionID: string): Promise<IngestState> =>
      ((await ctx.storage.get(storageKey(sessionID))) as IngestState | undefined) ?? {};
    const writeState = async (sessionID: string, patch: IngestState): Promise<void> => {
      const next = { ...(await readState(sessionID)), ...patch };
      await ctx.storage.set(storageKey(sessionID), next as unknown as StoredJson);
    };

    const ingestSession = async (sessionID: string): Promise<void> => {
      try {
        const state = await readState(sessionID);
        const messages = (await ctx.session.context({ sessionID })) as unknown as SessionMessageLike[];
        const fresh = pickNew(toEvents(sessionID, messages), new Set(state.ids ?? []));
        if (fresh.length === 0) return;

        for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
          const chunk = fresh.slice(i, i + BATCH_SIZE);
          const response = await fetch(`${endpoint}/v1/events/batch`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(chunk),
          });
          if (!response.ok) {
            // Mark nothing: the reconcile backstop retries the whole payload later.
            console.warn(`[brain-capture] batch rejected for ${sessionID}: HTTP ${response.status}`);
            return;
          }
        }

        const ingested = new Set(state.ids ?? []);
        for (const event of fresh) ingested.add(event.id);
        await writeState(sessionID, { ids: [...ingested] });
      } catch (error) {
        console.warn(`[brain-capture] ingest failed for ${sessionID}:`, error);
      }
    };

    const reconcile = async (): Promise<void> => {
      try {
        let after: string | undefined;
        do {
          const scan = await ctx.storage.scan({ prefix: INGEST_PREFIX, after, limit: SCAN_PAGE_SIZE });
          for (const entry of scan.entries) {
            const state = entry.value as IngestState | undefined;
            const stale =
              typeof state?.lastStatusAt === "number" &&
              Date.now() - state.lastStatusAt >= BACKSTOP_INTERVAL_MS;
            if (state?.lastStatus === "idle" && stale) {
              await ingestSession(entry.key.slice(INGEST_PREFIX.length));
            }
          }
          after = scan.next;
        } while (after);
      } catch (error) {
        console.warn("[brain-capture] reconcile failed:", error);
      }
    };

    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type !== "session.status") continue;
          const { sessionID, status } = event.data;
          await writeState(sessionID, { lastStatus: status.type, lastStatusAt: Date.now() });
          if (status.type === "idle") void ingestSession(sessionID);
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("[brain-capture] event stream ended:", error);
      }
    })();

    const backstop = setInterval(() => void reconcile(), BACKSTOP_INTERVAL_MS);
    void reconcile();

    return async () => {
      clearInterval(backstop);
      abort.abort();
    };
  },
});

export default brainCapture;
