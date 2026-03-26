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

## Anti-patterns
- Leaving ambiguous precedence between structural and surgical strategies
- Contradictory clauses in different sections
- Referencing non-existent skill files
