# AGENTS.md

## Agent skills

### Issue tracker

Issues live in the repo itself — GitHub issues on pedrosousa13/JSON-Bonsai, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label names, as repo labels on pedrosousa13/JSON-Bonsai — plus `in-progress` and `P0`–`P3`, labels that stand in for a missing field. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Formatting

This repo is hand-formatted: the standard is to match the surrounding file. Prettier is deliberately not used — no dependency, no `.prettierrc`, no `.prettierignore`, no `format` script — and adopting it was decided against in pedrosousa13/JSON-Bonsai#86.

So `npx prettier --check .` fails on most files even on a clean `main`. That is the expected state rather than an oversight to fix, and its output tells you nothing about your own branch: ignore it.
