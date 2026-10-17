# The main prompt — "install it, here's the link"

This is the ONLY thing a user needs to paste into their AI agent. Everything
else (the detailed protocol) is fetched from your repo at run time, so fork
owners only change the URL slug and every improvement ships to all installs.

Paste the block below verbatim into the agent the user wants wired up:

---

Set up the "brain" memory server for this machine, as directed below. Begin
by fetching and reading the full setup protocol, then follow it stage by
stage:

https://raw.githubusercontent.com/taxin-404/brain/master/prompts/setup-local.md

Rules while you work: you are NOT deploying or modifying the server — only
this machine's local wiring (escrow file, MCP entries, skills, optional
capture client). Collect my worker URL and tokens by asking me when the
protocol says so. Never print a secret value — mask tokens as their first 4
characters plus "…". Run every verification the protocol lists and finish
with its evidence-suite report plus anything left for me to do by hand.

---

Fork maintainers: replace `taxin-404/brain` in the raw URL with your slug
(`https://raw.githubusercontent.com/<you>/<repo>/master/prompts/setup-local.md`).
If your default branch is not `master`, swap that too.

Why a fetched protocol instead of a pasted wall of text: the agent always
executes the *current* version, the paste stays short enough to think about,
and re-runs are safe — the protocol checks-if-done first at every stage.
Also worth linking the user to: `skills/brain-memory` teaches their agents
*when to use* the memory once it is wired; that installs one command and is
described in the protocol's Stage 4.
