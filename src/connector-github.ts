import type { Env } from "./env";
import { json } from "./http";
import { ingestEvents, type EventInput } from "./ingest";

/** GitHub connector (design §8 phase 6): pull recent commits for a set of
 *  public repos and land them as events through the normal ingest path.
 *  Conservative by construction: `actor=external` (trust 0.4) — GitHub is a
 *  third-party surface, so its text can never become `user_stated` material
 *  or reach blocks/procedures. Deterministic event ids make re-syncs
 *  idempotent. Admin-triggered only; no cron (API-budget discipline). */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LIMITS = { repos: 10, lookbackHours: 720, perRepo: 50 };

interface GithubCommit {
  sha: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
}

export interface GithubSyncRepoResult {
  repo: string;
  fetched?: number;
  stored?: number;
  duplicates?: number;
  error?: string;
}

const badRequest = (message: string) => ({ status: 400, body: { error: "bad_request", message } });

function mapCommit(repo: string, c: GithubCommit): EventInput {
  const slug = repo.replace(/[^A-Za-z0-9]+/g, "-");
  const id = `gh-${slug}-c-${c.sha.slice(0, 12)}`;
  const message = c.commit?.message ?? "";
  const firstLine = message.split("\n")[0] ?? "";
  const dateStr = c.commit?.author?.date;
  const dateMs = dateStr ? Date.parse(dateStr) : Number.NaN;
  return {
    id,
    ts: Number.isFinite(dateMs) ? dateMs : undefined,
    source: "github",
    actor: "external",
    kind: "note",
    session_id: `gh:${repo}`,
    excerpt: `${repo}: ${firstLine}`,
    payload: {
      repo,
      sha: c.sha,
      message,
      author: c.commit?.author?.name ?? null,
      url: c.html_url ?? null,
      committed_at: dateStr ?? null,
    },
  };
}

export async function syncGithub(
  env: Env,
  body: unknown,
  now = Date.now(),
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("body must be an object");
  const b = body as Record<string, unknown>;

  const repos = b.repos;
  if (
    !Array.isArray(repos) ||
    repos.length < 1 ||
    repos.length > LIMITS.repos ||
    repos.some((r) => typeof r !== "string" || !REPO_RE.test(r))
  ) {
    return badRequest(`repos must be 1-${LIMITS.repos} "owner/name" strings`);
  }
  const lookbackHours = b.lookback_hours === undefined ? 48 : b.lookback_hours;
  if (
    typeof lookbackHours !== "number" ||
    !Number.isFinite(lookbackHours) ||
    lookbackHours < 1 ||
    lookbackHours > LIMITS.lookbackHours
  ) {
    return badRequest(`lookback_hours must be 1-${LIMITS.lookbackHours}`);
  }
  const maxPerRepo = b.max_per_repo === undefined ? 30 : b.max_per_repo;
  if (typeof maxPerRepo !== "number" || !Number.isInteger(maxPerRepo) || maxPerRepo < 1 || maxPerRepo > LIMITS.perRepo) {
    return badRequest(`max_per_repo must be 1-${LIMITS.perRepo}`);
  }

  const since = new Date(now - lookbackHours * 3_600_000).toISOString();
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "brain-connector/1",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const results: GithubSyncRepoResult[] = [];
  for (const repo of repos as string[]) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=${maxPerRepo}`,
        { headers },
      );
      if (!res.ok) {
        results.push({ repo, error: `github ${res.status}` });
        continue;
      }
      const commits = (await res.json()) as GithubCommit[];
      const entries = commits.slice(0, maxPerRepo).map((c) => mapCommit(repo, c));
      const ingested = entries.length > 0 ? await ingestEvents(env, "ADMIN", entries) : { stored: 0 };
      results.push({ repo, fetched: entries.length, stored: ingested.stored, duplicates: entries.length - ingested.stored });
    } catch (err) {
      results.push({ repo, error: `fetch failed: ${String(err)}` });
    }
  }

  const anyOk = results.some((r) => r.error === undefined);
  return { status: anyOk ? 200 : 502, body: { results } };
}

export async function handleGithubSync(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request", message: "body must be JSON" }, 400);
  }
  const out = await syncGithub(env, body);
  return json(out.body, out.status);
}
