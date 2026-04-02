---
name: policy-coherence-audit
description: "Detect and remove contradictions across agent policies before execution."
---
# Policy Coherence Audit Skill

## Purpose
Detect and remove contradictions across agent policies before execution.

## Use when
- Updating `AGENTS.MD`
- Merging new workflow rules
- Noticing behavioral ambiguity during execution

## Checklist
- Language coherence: English-only wording.
- Interaction coherence: one question + 5-option model is consistently respected.
- Gate coherence: completion gates apply to both Non-Breaking and Breaking paths.
- Scope coherence: avoid wording that causes uncontrolled scope creep.
- Reference coherence: every mentioned skill path exists.
- Harness coherence: Canonical SSOT (SQLite) is never bypassed by manual tool/DB mutation.
- Memory coherence: mem0 writes must carry the 5 mandatory canonical scopes (workspace, project, campaign, task, run).
- Session coherence: `harness_session(action: "begin")` is the ONLY way to start/reconcile a task.

## Short examples
- Fix mixed language term: "TASSATIVO" -> "MANDATORY".
- Fix model mismatch: "propose one option" -> explicit 5-option decision set.

## Resolution Order

When two policies conflict, resolve them in this order:

1. safety and public-boundary validation
2. canonical HarnessOS lifecycle rules
3. explicit user choice for the current task
4. repo-local conventions and quality gates
5. stylistic or wording preferences

If two rules still conflict after this ordering, rewrite the policy so only one source of truth remains.

## Typical Contradictions To Fix

| Conflict | Fix |
| --- | --- |
| “Be autonomous” vs “ask after every completion” | make the ask happen at issue boundaries only, not mid-issue |
| “Keep versioning simple” vs “bump every internal contract major” | separate package version from schema/contract versions and document both |
| “Use HarnessOS only” vs ad-hoc SQLite/file mutation | route all canonical task state through the official Harness tools |
| “Use one question with five options” vs freeform open-ended prompts | keep option 4 as `Freeform` and move nuance into the option descriptions |

## Anti-patterns
- Leaving ambiguous precedence between structural and surgical strategies
- Contradictory clauses in different sections
- Referencing non-existent skill files
- Encoding public package version, schema version, and contract version as if they were the same thing
