---
name: performance-audit
description: "Structured performance audit covering Core Web Vitals, bundle size, memory profiling, and runtime efficiency."
---
# Performance Audit Skill

## Purpose
Provide a structured performance audit procedure for web applications, covering load performance, runtime efficiency, and resource usage.

## Use when
- Before launching or releasing a feature
- When performance regression is suspected
- When Core Web Vitals scores drop
- During optimization sprints
- After adding significant new dependencies

## Audit Layers

### 1. Core Web Vitals (Lighthouse)

Run Lighthouse in both mobile and desktop modes:

```
chrome-devtools → lighthouse_audit (device: "mobile", mode: "navigation")
chrome-devtools → lighthouse_audit (device: "desktop", mode: "navigation")
```

| Metric | Target | Tools |
|--------|--------|-------|
| **LCP** (Largest Contentful Paint) | < 2.5s | Lighthouse, Performance trace |
| **INP** (Interaction to Next Paint) | < 200ms | Performance trace |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Lighthouse, Performance trace |
| **FCP** (First Contentful Paint) | < 1.8s | Lighthouse |
| **TTFB** (Time to First Byte) | < 800ms | Network panel |

### 2. Bundle Analysis

| Check | Target | How |
|-------|--------|-----|
| Total JS bundle (gzipped) | < 200 KB (initial load) | `npm run build` + analyzer |
| Largest dependency | Flag > 50 KB gzipped | Bundle analyzer |
| Tree-shaking | No unused exports in bundle | Build output analysis |
| Code splitting | Route-level chunks, not monolith | Build output analysis |
| Duplicate dependencies | Zero duplicates | `npm ls --all` or analyzer |

### 3. Runtime Performance

Use Chrome DevTools Performance trace:

```
chrome-devtools → performance_start_trace (reload: true, autoStop: true)
```

| Check | Target |
|-------|--------|
| Long tasks (> 50ms) | Identify and split or defer |
| Layout thrashing | No forced synchronous layouts |
| Memory leaks | Heap snapshot comparison (before/after interaction cycle) |
| Animation jank | 60fps for all animations |
| Event listener count | No unbounded growth |

### 4. Network Efficiency

```
chrome-devtools → list_network_requests
```

| Check | Target |
|-------|--------|
| Total requests on load | < 50 |
| Uncompressed assets | All text assets gzipped/brotli |
| Missing cache headers | Static assets have Cache-Control |
| Render-blocking resources | Minimize or defer |
| Image optimization | WebP/AVIF, responsive `srcset`, lazy loading |

### 5. Memory Profiling

```
chrome-devtools → take_memory_snapshot (filePath: "baseline.heapsnapshot")
# Perform user interaction cycle
chrome-devtools → take_memory_snapshot (filePath: "after-interaction.heapsnapshot")
```

Compare snapshots for:
- Objects that should have been garbage collected
- Detached DOM nodes
- Growing arrays/maps that are never cleaned

## Procedure

1. **Baseline**: run full audit on current main/production build
2. **Identify**: flag all metrics that miss targets
3. **Prioritize**: fix by user impact (LCP > INP > CLS > bundle > memory)
4. **Fix**: one optimization at a time, measure after each
5. **Verify**: re-run audit to confirm improvement and no regressions
6. **Document**: record before/after metrics in session log

## Related Skills
- **`systematic-debugging`** — for diagnosing specific performance issues
- **`testing-policy`** — include performance benchmarks in CI
- **`completion-gate`** — performance regressions block the gate

## Done Criteria
- All Core Web Vitals meet targets (or documented exceptions with justification)
- No performance regressions vs baseline
- Before/after metrics documented

## Anti-patterns
- Optimizing before measuring
- Micro-optimizing code while ignoring bundle size and network
- Relying only on Lighthouse score without understanding individual metrics
- Measuring only on fast hardware/network (test on throttled conditions)
