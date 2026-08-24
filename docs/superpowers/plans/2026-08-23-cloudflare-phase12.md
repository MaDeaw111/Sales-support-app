# WCAT Cloudflare Phase 1-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the existing WCAT frontend through Cloudflare Workers Static Assets and expose a minimal testable Worker API.

**Architecture:** Keep the current HTML application intact in `public/index.html`. Route `/api/*` through a small Worker in `src/index.js`; serve other requests through the `ASSETS` binding. Phase 1-2 deliberately leaves Apps Script auth/data migration for later.

**Tech Stack:** HTML/JavaScript, Cloudflare Workers, Wrangler, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-23-cloudflare-phase12-design.md`

## Global Constraints
- Preserve existing WCAT UI/business logic.
- No D1 migration in this phase.
- No authentication bypass.
- `GET /api/health` returns `status: "SUCCESS"`.
- `/api/gateway` returns HTTP 501 until backend action migration.

---

### Task 1: Worker routing contract

**Files:**
- Create: `test/worker.test.js`
- Create: `src/index.js`

**Interfaces:**
- Consumes: `Request`, Worker `env.ASSETS.fetch(request)`.
- Produces: default Worker export with `fetch(request, env)`.

- [ ] Write tests for `/api/health`, `/api/gateway`, and static asset fallback.
- [ ] Run `node --test test/worker.test.js` and verify failure because `src/index.js` does not exist.
- [ ] Implement minimal Worker routing.
- [ ] Run tests and verify all pass.

### Task 2: Cloudflare project scaffold and preserved frontend

**Files:**
- Create: `package.json`
- Create: `wrangler.jsonc`
- Create: `public/index.html` from uploaded `Index(1).html`
- Create: `README.md`

**Interfaces:**
- Consumes: Worker from Task 1 and current WCAT HTML.
- Produces: deployable Cloudflare Worker project.

- [ ] Copy the current HTML to `public/index.html` unchanged except for the Phase 1-2 backend adapter change in Task 3.
- [ ] Configure Wrangler with `main`, current `compatibility_date`, `assets.directory`, `assets.binding`, and `assets.run_worker_first` for `/api/*`.
- [ ] Add npm scripts for `test`, `dev`, and `deploy`.
- [ ] Document local run/deploy commands and Phase 1-2 limitations.
- [ ] Run `npm test` and verify all tests pass.

### Task 3: Prepare the frontend backend adapter

**Files:**
- Modify: `public/index.html` function `callBackend` near the end of the file.
- Create: `test/frontend-adapter.test.js`

**Interfaces:**
- Consumes: existing `callBackend(action, payload, onSuccess, onFailure)` call sites.
- Produces: same callback interface implemented via `fetch('/api/gateway')`.

- [ ] Write a source-level test asserting `callBackend` no longer calls `google.script.run.apiGateway` and does call `/api/gateway`.
- [ ] Run the test and verify it fails against the unmodified copied HTML.
- [ ] Replace only the `callBackend` implementation with fetch-based transport while preserving callback behavior and response format.
- [ ] Run all tests and verify they pass.
