import { Plugin, type StorageEntry } from "@opencode/plugin";
import { pickNew, toEvents, type SessionMessageLike } from "./capture";
import { diag, enableDiag } from "./diag";

diag("module_evaluated");

const INGEST_PREFIX = "ingest/";
const BATCH_SIZE = 500;
const RECONCILE_INTERVAL_MS = 30 * 60_000;
const RECONCILE_WINDOW_MS = 7 * 24 * 3600_000;

interface IngestState {
  lastStatus?: string;
  lastStatusAt?: number;
  lastSeenAt?: number;
  ids?: string[];
}

type StoredJson = StorageEntry["value"];

/**
 * brain-capture — pushes OpenCode session history into the brain Worker.
 *
 * Options: `{ endpoint, token }` where token is the MCP_PROPOSE credential.
 *
 * The plugin context exposes no session enumeration (ctx.session has no
 * `list`), so sessions are learned from the server event stream: any event
 * carrying a `sessionID` discovers a session, assistant step completions
 * (`session.step.ended`) and idle transitions trigger incremental ingest,
 * and a reconcile pass (on load and every 30 minutes) re-pushes every
 * recently seen session. Ingest is idempotent — the Worker dedupes by
 * event id — so overlapping triggers are free.
 */
const brainCapture = Plugin.define({
  id: "brain-capture",
  async setup(ctx) {
    if (typeof ctx.options?.diag === "string") enableDiag(ctx.options.diag);
    const diagEnabled = typeof ctx.options?.diag === "string";
    const endpoint =
      typeof ctx.options?.endpoint === "string" ? ctx.options.endpoint.replace(/\/+$/, "") : undefined;
    const token = typeof ctx.options?.token === "string" ? ctx.options.token : undefined;
    diag("setup_entered", {
      optionKeys: Object.keys(ctx.options ?? {}),
      hasEndpoint: endpoint !== undefined,
      hasToken: token !== undefined,
    });
    if (!endpoint || !token) {
      console.warn("[brain-capture] disabled: plugin options { endpoint, token } are required");
      diag("setup_disabled_missing_options");
      return;
    }
    console.log(`[brain-capture] loaded (endpoint=${endpoint})`);

    const postDiagEvent = async (kind: string, message: string): Promise<void> => {
      if (!diagEnabled) return;
      try {
        await fetch(`${endpoint}/v1/events/batch`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify([
            {
              id: `oc_diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              ts: Date.now(),
              source: "opencode",
              actor: "tool",
              kind: "tool_call",
              session_id: "brain-capture",
              payload: { diag: kind, message },
            },
          ]),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // best-effort
      }
    };

    const storageKey = (sessionID: string) => `${INGEST_PREFIX}${sessionID}`;
    const readState = async (sessionID: string): Promise<IngestState> =>
      ((await ctx.storage.get(storageKey(sessionID))) as IngestState | undefined) ?? {};
    const writeState = async (sessionID: string, patch: IngestState): Promise<void> => {
      const next = { ...(await readState(sessionID)), ...patch };
      await ctx.storage.set(storageKey(sessionID), next as unknown as StoredJson);
    };

    const ingestSession = async (sessionID: string): Promise<number> => {
      try {
        const state = await readState(sessionID);
        const messages = (await ctx.session.context({ sessionID })) as unknown as SessionMessageLike[];
        const fresh = pickNew(toEvents(sessionID, messages), new Set(state.ids ?? []));
        if (fresh.length === 0) return 0;
        diag("ingest_start", { sessionID, fresh: fresh.length });

        for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
          const chunk = fresh.slice(i, i + BATCH_SIZE);
          const response = await fetch(`${endpoint}/v1/events/batch`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(chunk),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) {
            // Mark nothing: a later trigger retries the whole payload (server dedupes by id).
            console.warn(`[brain-capture] batch rejected for ${sessionID}: HTTP ${response.status}`);
            diag("ingest_http_error", { sessionID, status: response.status, body: (await response.text()).slice(0, 500) });
            await postDiagEvent("ingest_http_error", `${sessionID}: HTTP ${response.status}`);
            return 0;
          }
        }

        const ingested = new Set(state.ids ?? []);
        for (const event of fresh) ingested.add(event.id);
        await writeState(sessionID, { ids: [...ingested] });
        diag("ingest_ok", { sessionID, fresh: fresh.length });
        return fresh.length;
      } catch (error) {
        console.warn(`[brain-capture] ingest failed for ${sessionID}:`, error);
        diag("ingest_error", { sessionID, message: String(error), stack: (error as Error)?.stack });
        await postDiagEvent("ingest_error", `${sessionID}: ${String(error)}`);
        return 0;
      }
    };

    /** Re-push every session whose state was touched within the window. */
    let onlineReported = false;
    const reconcile = async (): Promise<void> => {
      try {
        let after: string | undefined;
        let swept = 0;
        let ingested = 0;
        do {
          const scan = await ctx.storage.scan({ prefix: INGEST_PREFIX, after, limit: 100 });
          for (const entry of scan.entries) {
            const state = (entry.value ?? {}) as unknown as IngestState;
            const lastSeen = state.lastSeenAt ?? state.lastStatusAt ?? 0;
            if (lastSeen < Date.now() - RECONCILE_WINDOW_MS) continue;
            swept += 1;
            ingested += await ingestSession(entry.key.slice(INGEST_PREFIX.length));
          }
          after = scan.next;
        } while (after);
        diag("reconcile_done", { swept, ingested });
        if (ingested > 0) console.log(`[brain-capture] reconcile: ${ingested} new events from ${swept} recent sessions`);
        if (!onlineReported) {
          onlineReported = true;
          await postDiagEvent("capture_online", `swept=${swept} ingested=${ingested}`);
        }
      } catch (error) {
        console.warn("[brain-capture] reconcile failed:", error);
        diag("reconcile_error", { message: String(error), stack: (error as Error)?.stack });
        await postDiagEvent("reconcile_error", String(error));
      }
    };

    const seen = new Set<string>();
    const abort = new AbortController();
    diag("subscribing_events");
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = event.type as string;
          const data = (event.data ?? {}) as unknown as Record<string, unknown>;
          const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
          if (sessionID && !seen.has(sessionID)) {
            seen.add(sessionID);
            diag("session_discovered", { sessionID });
            void writeState(sessionID, { lastSeenAt: Date.now() });
          }
          if (type === "session.status") {
            const raw = data.status;
            const statusType =
              typeof raw === "string" ? raw : (raw as { type?: string } | undefined)?.type;
            if (sessionID && statusType) {
              diag("status_event", { sessionID, status: statusType });
              void writeState(sessionID, {
                lastStatus: statusType,
                lastStatusAt: Date.now(),
                lastSeenAt: Date.now(),
              });
              if (statusType === "idle") void ingestSession(sessionID);
            }
            continue;
          }
          if (type === "session.idle" && sessionID) {
            void ingestSession(sessionID);
            continue;
          }
          if (type === "session.step.ended" && sessionID) {
            void writeState(sessionID, { lastSeenAt: Date.now() });
            void ingestSession(sessionID);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          console.warn("[brain-capture] event stream ended:", error);
          diag("event_stream_error", { message: String(error) });
        }
      }
    })();

    const backstop = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    void reconcile();

    return async () => {
      clearInterval(backstop);
      abort.abort();
    };
  },
});

export default brainCapture;
