<!--
 Copyright (c) 2026 borkdominik and others.
 This program and the accompanying materials are made available under the
 terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 SPDX-License-Identifier: MIT
-->

# Automatic Test Data Generation

Generate `InstanceSpecification`s (objects) with classifier-consistent slot values and
`InstanceLink`s for a class diagram — in **one atomic, undoable step**. This is Feature 4 of the
object-diagram topic, built on top of the Model Instance Explorer (Feature 3).

Open it from the **Instances** panel → **Generate Test Data**.

---

## How to use

1. **Classifiers** — tick the classes / data types to instantiate. Inherited properties are included.
2. **Instances per classifier** — how many objects per selected classifier.
3. **Strategy** — how slot values are produced (see below).
4. **Association depth** — whether/how far to create links and pull in related classifiers (see below).
5. **Link only within this batch** (optional) — connect the generated instances to each other instead
   of to pre-existing ones (great for a self-contained example graph).
6. **Seed** (optional) — same seed + same config ⇒ identical output (reproducible).
7. **Preview** — a dry-run sample (counts + first instances + diagnostics); nothing is applied.
8. **Generate** — applies everything as a single model change (**one Undo reverts the whole batch**).

---

## Value strategies

One strategy is used for the whole generation; it applies to every generated classifier.

| Strategy | What it does |
|---|---|
| **Realistic (Faker)** | Values inferred from the **field name** (`fullName`→name, `email`→email, `city`, `salary`, `birthYear`…) with a type fallback. Seeded ⇒ reproducible. Default. |
| **Random** | Type-correct dummy values: `String` / `Integer` / `Boolean` / `Real` / `Enumeration` (picks a literal) / untyped→string. |
| **Pattern** | Per-property templates: `{n}` = instance index (per classifier), `{pick:a,b,c}` = seeded random choice, literal text otherwise. Unmapped properties fall back to **random**. Editable per selected classifier, prefilled with smart defaults. |

> **Pattern + association depth:** classifiers pulled in automatically by depth ≥ 2 are *not* selected
> in the dialog, so in Pattern mode they fall back to **random**. To pattern a related classifier,
> select it explicitly.

---

## Association depth (transitive)

| Depth | Behaviour |
|---|---|
| `0` | No links — just instances with slot values. |
| `1` | Generate only the selected classifiers and link them directly. |
| `N ≥ 2` | Also **generate the related classifiers** reachable within `N − 1` association hops, then link the whole graph. |

Example: generating **Company** at **depth 3** also generates the `Employee`s that work for it (1 hop)
and their `Address`es / `Project`s (2 hops), all connected. Reachability follows associations in both
directions (a target reaches its sources), so generating a target-only class still pulls in its sources.

---

## Link generation rules

- **Direction:** links are created source → target, per the diagram's `Association` elements (the
  generator never invents associations — they must be modeled). Inherited associations apply to
  concrete subtypes (e.g. `Person.hasAddress` ⇒ Employee/Customer/Manager).
- **Target multiplicity** (`[one]`, `[*]`, `2..5`) — bounds the number of links **per source**.
- **Source multiplicity** — bounds how many sources may link a **single target**. A `1:1` association
  therefore never shares a target (surplus sources get a best-effort warning if targets run out).
- **Balanced distribution** — targets are chosen least-used-first, so links spread evenly (no
  clustering, no stale targets while capacity remains). E.g. 6 employees over 3 companies ⇒ 2-2-2.
- **Specific target** — per association you may pin one existing instance as the target for all sources.
- **Link within this batch** — restricts targets to the just-generated instances.

---

## Constraints honoured (topic 4e)

- `isReadOnly` properties are skipped (no slot).
- `isUnique` values are de-duplicated best-effort (warning if it can't be satisfied).
- `isOrdered` / multi-valued (`upper > 1`) properties get several ordered slot values.
- Required (`lower ≥ 1`) properties that can't be filled produce a warning.
- Multiplicity is respected on both association ends (see above).

---

## Notes & current limitations

- **Numbers/booleans** are stored grammar-safe with a leading `_` (`_85`, `_true`) because the
  metamodel stores slot values as identifier tokens; the underlying value is recoverable by stripping
  `_`. Clean bare numbers need an escaped-value grammar terminal (tracked as Feature 2 work).
- **Whitespace** in values is replaced with `_` (`Alice Smith` → `Alice_Smith`) for the same reason.
- Generated nodes are laid out in a simple grid below the existing diagram; links are created but not
  auto-arranged into a hierarchy.
- The **LLM** strategy from the reference paper is designed (provider-agnostic) but not yet built.

---

## Architecture

A **pure functional core** (unit-tested) + a thin **GLSP handler** (imperative shell):

| File | Role |
|---|---|
| `src/env/common/generate.action.ts` | Operation + preview action + `GenerationConfig` contract |
| `src/env/glsp-server/generate.handler.ts` | Resolves AST → views, one `ModelPatchCommand` (atomic), preview, classifier listing |
| `src/env/glsp-server/generate.core.ts` | `buildGeneration` — instances + slots + diagnostics; `sanitizeSlotValue` |
| `src/env/glsp-server/links.core.ts` | `planLinks` — multiplicity-aware (both ends), balanced, within-batch |
| `src/env/glsp-server/expand.core.ts` | `expandClassifierSelection` — transitive association-depth expansion |
| `src/env/glsp-server/resolve.ts` | multiplicity + type-kind resolution |
| `src/env/glsp-server/strategies/*` | `random` / `pattern` / `realistic` value strategies + seeded RNG |
| `src/env/browser/generate-dialog.component.tsx` | the configuration dialog |

Every model mutation goes through one `ModelPatchCommand` (RFC-6902 JSON patch) so a single undo
reverts the whole generation.

## Tests

```bash
npm test            # unit tests (pure core) + a committed end-to-end test through the model server
```

Tests live in `test/` (Node's built-in runner via `tsx`). `test/generate.e2e.test.ts` drives the real
model-server patch pipeline against a self-contained typed fixture (`test/fixtures/library-domain.uml`).
