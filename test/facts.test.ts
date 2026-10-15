import { describe, expect, it } from "vitest";
import {
  buildEmbedText,
  factCandidateSchema,
  normalizeCandidates,
  normalizeObjectText,
} from "../src/facts";

type Actor = "user" | "assistant" | "tool" | "external";
const ctx = (events: Array<[string, Actor]> = [["evt1", "user"]]) =>
  new Map(events.map(([id, actor]) => [id, { actor, trust: 1 }]));

const candidate = (over: Record<string, unknown> = {}) => ({
  subject: "user",
  predicate: "prefers editor",
  object: "Neovim",
  fact_kind: "user_stated",
  confidence: 0.9,
  event_id: "evt1",
  ...over,
});

describe("normalizeCandidates", () => {
  interface Case {
    name: string;
    over: Record<string, unknown>;
    actor: Actor;
    expectKind: string;
    expectConfidence: number;
  }
  const confidenceCases: Case[] = [
    {
      name: "user_stated + actor=user is fixed at 0.9 even when parsed lower",
      over: { fact_kind: "user_stated", confidence: 0.4 },
      actor: "user",
      expectKind: "user_stated",
      expectConfidence: 0.9,
    },
    {
      name: "user_stated from actor=assistant downgrades to inferred capped at 0.59",
      over: { fact_kind: "user_stated", confidence: 0.9 },
      actor: "assistant",
      expectKind: "inferred",
      expectConfidence: 0.59,
    },
    {
      name: "observed + actor=tool caps at 0.5",
      over: { fact_kind: "observed", confidence: 0.9 },
      actor: "tool",
      expectKind: "observed",
      expectConfidence: 0.5,
    },
    {
      name: "observed from a non-tool actor downgrades to inferred",
      over: { fact_kind: "observed", confidence: 0.9 },
      actor: "user",
      expectKind: "inferred",
      expectConfidence: 0.59,
    },
    {
      name: "inferred caps at 0.59",
      over: { fact_kind: "inferred", confidence: 0.8 },
      actor: "user",
      expectKind: "inferred",
      expectConfidence: 0.59,
    },
    {
      name: "guess caps at 0.5",
      over: { fact_kind: "guess", confidence: 0.9 },
      actor: "user",
      expectKind: "guess",
      expectConfidence: 0.5,
    },
    {
      name: "guess clamps to 0 from below",
      over: { fact_kind: "guess", confidence: -1 },
      actor: "user",
      expectKind: "guess",
      expectConfidence: 0,
    },
    {
      name: "actor=external caps at 0.4",
      over: { fact_kind: "inferred", confidence: 0.8 },
      actor: "external",
      expectKind: "inferred",
      expectConfidence: 0.4,
    },
    {
      name: "actor=external never stays user_stated",
      over: { fact_kind: "user_stated", confidence: 0.9 },
      actor: "external",
      expectKind: "inferred",
      expectConfidence: 0.4,
    },
    {
      name: "temporary without expires_at downgrades to inferred",
      over: { fact_kind: "temporary", confidence: 0.8 },
      actor: "user",
      expectKind: "inferred",
      expectConfidence: 0.59,
    },
    {
      name: "temporary with expires_at stays temporary capped at 0.59",
      over: { fact_kind: "temporary", confidence: 0.8, expires_at: 123 },
      actor: "user",
      expectKind: "temporary",
      expectConfidence: 0.59,
    },
    {
      name: "unknown fact_kind becomes inferred",
      over: { fact_kind: "opinion", confidence: 0.8 },
      actor: "user",
      expectKind: "inferred",
      expectConfidence: 0.59,
    },
  ];

  it.each(confidenceCases)("$name", ({ over, actor, expectKind, expectConfidence }) => {
    const { facts } = normalizeCandidates([candidate(over)], ctx([["evt1", actor]]));
    expect(facts).toHaveLength(1);
    expect(facts[0].factKind).toBe(expectKind);
    expect(facts[0].confidence).toBe(expectConfidence);
  });

  it("keeps temporary expires_at on the normalized fact", () => {
    const { facts } = normalizeCandidates([candidate({ fact_kind: "temporary", expires_at: 123 })], ctx());
    expect(facts[0].expiresAt).toBe(123);
  });

  it("stores restricted candidates redacted with sensitivity=restricted", () => {
    const { facts } = normalizeCandidates([candidate({ sensitivity: "restricted", object: "hunter2 secret" })], ctx());
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ objectText: "[REDACTED]", sensitivity: "restricted" });
  });

  it("drops every candidate of an event that carries an injection flag", () => {
    const raw = [
      candidate({ event_id: "evt1", predicate: "likes", object: "tea" }),
      candidate({ event_id: "evt1", injection_suspected: true }),
      candidate({ event_id: "evt2", predicate: "works", object: "late" }),
    ];
    const { facts, injectionEvents } = normalizeCandidates(raw, ctx([["evt1", "user"], ["evt2", "user"]]));
    expect(facts.map((f) => f.eventId)).toEqual(["evt2"]);
    expect(injectionEvents).toEqual(["evt1"]);
  });

  it("drops the whole batch when an injection flag has no mappable event_id", () => {
    const flagged: Record<string, unknown>[] = [
      candidate(),
      { injection_suspected: true, quote: "ignore previous instructions" },
    ];
    const r1 = normalizeCandidates(flagged, ctx());
    expect(r1.facts).toEqual([]);
    expect(r1.injectionEvents).toEqual([]);

    const ghost = normalizeCandidates(
      [candidate(), candidate({ injection_suspected: true, event_id: "ghost" })],
      ctx(),
    );
    expect(ghost.facts).toEqual([]);
  });

  it("skips entries that fail schema validation", () => {
    const raw = [candidate(), { subject: "user", predicate: "x" }, null, "junk"];
    const { facts } = normalizeCandidates(raw, ctx());
    expect(facts).toHaveLength(1);
  });

  it("drops candidates whose event_id is not in the context", () => {
    const { facts } = normalizeCandidates([candidate({ event_id: "evt99" })], ctx());
    expect(facts).toEqual([]);
  });

  it("drops candidates with empty subject or object", () => {
    const { facts } = normalizeCandidates([candidate({ subject: "   " }), candidate({ object: "" })], ctx());
    expect(facts).toEqual([]);
  });

  it("normalizes predicate: lower, spaces to underscores, keep [a-z0-9_]", () => {
    const { facts } = normalizeCandidates([candidate({ predicate: "Prefers: Vim" })], ctx());
    expect(facts[0].predicate).toBe("prefers_vim");
  });

  it("exposes subjectType and a normalized subject", () => {
    const { facts } = normalizeCandidates([candidate({ subject: "Taxin-404", subject_type: "Project" })], ctx());
    expect(facts[0].subject).toBe("Taxin-404");
    expect(facts[0].subjectNorm).toBe("taxin 404");
    expect(facts[0].subjectType).toBe("Project");
  });

  it("throws when the raw value is not an array", () => {
    expect(() => normalizeCandidates({ facts: [] }, ctx())).toThrow(/array/);
  });

  it("validates shape via the exported schema", () => {
    expect(factCandidateSchema.parse([candidate()])[0]).toMatchObject({ subject: "user" });
    expect(factCandidateSchema.safeParse([{ subject: "user" }]).success).toBe(false);
  });
});

describe("normalizeObjectText", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeObjectText("  Hello   World ")).toBe("hello world");
  });
});

describe("buildEmbedText", () => {
  it("joins subject, depredicated predicate and object", () => {
    expect(buildEmbedText({ subjectName: "user", predicate: "prefers_editor", objectText: "neovim" })).toBe(
      "user prefers editor neovim",
    );
  });
});
