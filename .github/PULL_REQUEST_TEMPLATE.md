<!-- Merging to master deploys the live worker (Workers Builds). -->

## What & why

<!-- One paragraph. Link the phase plan / issue / design section if there is one. -->

## Checklist

- [ ] Tests added or updated (or say why not)
- [ ] `npx vitest run` green — unpiped, exit code checked
- [ ] `npx tsc --noEmit` clean
- [ ] `cd plugin && npx vitest run` green (when `plugin/` changed)
- [ ] Docs updated where behavior or interfaces changed (design doc, plans, README map, ledger)
- [ ] No secrets, tokens, or captured personal data in the diff
- [ ] Behavior changes argue from `docs/design-v1.2.md` (or update it alongside)
