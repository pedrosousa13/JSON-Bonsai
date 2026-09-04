# AGENTS.md

## Agent skills

### Issue tracker

Issues live in the repo itself — GitHub issues on pedrosousa13/JSON-Bonsai, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label names, as repo labels on pedrosousa13/JSON-Bonsai — plus `in-progress` and `P0`–`P3`, labels that stand in for a missing field. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Formatting

This repo is hand-formatted. Prettier is deliberately not used, so there is no prettier dependency, no `.prettierrc` and no `format` script. `npx prettier --check .` fails on essentially every file — 67 at last count — even on a clean `main`; that is the expected state, not an oversight to fix, and adopting prettier was decided against in issue #86. The formatting standard is to match the surrounding file.
