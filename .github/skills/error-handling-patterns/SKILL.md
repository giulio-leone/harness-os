---
name: error-handling-patterns
description: "Standard patterns for error handling, retry logic, circuit breakers, and graceful degradation."
---
# Error Handling Patterns Skill

## Purpose
Provide reusable error handling patterns to make applications resilient and debuggable.

## Use when
- Implementing external service calls (APIs, databases, third-party services)
- Building user-facing error feedback
- Designing fault-tolerant systems
- Adding retry logic to flaky operations

## Pattern 1 — Structured Error Types

Define error types by category, not by source:

```typescript
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,       // machine-readable: "AUTH_EXPIRED"
    public readonly statusCode: number, // HTTP-compatible: 401
    public readonly isOperational: boolean = true  // true = expected, false = bug
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Usage
throw new AppError("Token expired", "AUTH_EXPIRED", 401, true);
```

**Rule**: operational errors are handled; non-operational errors crash and alert.

## Pattern 2 — Retry with Exponential Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 200, maxDelayMs = 5000 } = options;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      if (error instanceof AppError && !error.isOperational) throw error; // don't retry bugs
      
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, jitter));
    }
  }
  throw new Error("Unreachable");
}
```

**Rules**:
- Retry only on transient errors (network timeout, 503, rate limit)
- Never retry on 4xx client errors (except 429)
- Always add jitter to prevent thundering herd

## Pattern 3 — Circuit Breaker

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private threshold: number = 5,
    private resetTimeoutMs: number = 30000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new AppError("Service unavailable (circuit open)", "CIRCUIT_OPEN", 503);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() { this.failures = 0; this.state = "closed"; }
  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) this.state = "open";
  }
}
```

**Use when**: calling external services that may be down for extended periods.

## Pattern 4 — Graceful Degradation

When a non-critical feature fails, degrade instead of crashing:

| Failure | Degradation |
|---------|-------------|
| Recommendation engine down | Show popular items instead |
| Analytics service unreachable | Queue events for later, continue serving |
| CDN image unavailable | Show placeholder image |
| Cache miss | Fall through to database (slower but functional) |

**Rule**: only non-critical features degrade; critical paths must fail explicitly.

## HarnessOS Integration Pattern

When a failure affects canonical queue state, do not hide it behind a friendly fallback. Instead:

1. keep SQLite as the source of truth
2. checkpoint the failure explicitly
3. mark the task `blocked` or `needs_recovery` when the lifecycle truly cannot continue
4. preserve the next action needed for recovery

Example:

```json
{
  "action": "checkpoint",
  "sessionToken": "ST-...",
  "input": {
    "title": "Dependency API unavailable",
    "summary": "Customer-safe response drafted, but the upstream API stayed unavailable after bounded retries.",
    "taskStatus": "blocked",
    "nextStep": "Retry after platform approval or switch to the documented manual fallback.",
    "persistToMem0": false
  }
}
```

This keeps the failure visible to `next_action`, audit/export surfaces, and later recovery work instead of pretending the task succeeded.

## Pattern 5 — Error Boundaries (Frontend)

- Wrap independent UI sections in error boundaries
- Show contextual error messages, not generic "Something went wrong"
- Log the error with enough context to reproduce (component tree, props, user action)
- Provide recovery action (retry button, navigate home)

## Related Skills
- **`systematic-debugging`** — when errors need root-cause investigation
- **`testing-policy`** — test error paths, not just happy paths
- **`session-lifecycle`** — checkpoint or close blocked/recovery states explicitly

## Done Criteria
- External calls use retry or circuit breaker as appropriate
- Errors are typed and categorized (operational vs non-operational)
- Non-critical failures degrade instead of crashing
- Error messages are user-friendly (no stack traces in UI)

## Anti-patterns
- **Swallowing errors**: `catch (e) { /* ignore */ }`
- **Retrying indefinitely** without backoff or limit
- **Generic messages**: "An error occurred" without actionable guidance
- **Logging without context**: `console.error(e)` without state/input data
- **Treating all errors equally**: 404 and 500 should not trigger the same response
- **Success-shaped fallbacks** that hide a blocked HarnessOS task instead of checkpointing it
