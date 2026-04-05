# Security Best Practices Report

## Executive Summary

All 12 security findings have been addressed. The codebase already implemented several positive security patterns (timing-safe token comparison, atomic file writes, array-arg subprocess spawning, no eval/Function usage). This review resulted in fixes for DoS protections, request validation, path traversal mitigation, and server hardening.

---

## Findings

### SEC-001: No Request Body Size Limits on Bridge HTTP Server

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:912-921` — `readJsonRequestBody()`  
**Status**: ✅ FIXED

Added `MAX_REQUEST_BODY_BYTES = 1024 * 1024` (1MB) constant and size check inside `readJsonRequestBody()`. If total bytes exceed the limit, the function throws an error before accumulating more data.
```javascript
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
async function readJsonRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  // ...
}
```

**Mitigation**: Deploy behind a reverse proxy (nginx) with `client_max_body_size` set.

---

### SEC-002: No Rate Limiting on Bridge HTTP Endpoints

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:397-436` — HTTP server creation  
**Status**: ✅ FIXED

Added `checkRateLimit()` function using an in-memory `Map` with per-key sliding window tracking. Rate limiting is enforced at the top of `handleBridgeHttpRequest()` keyed by `clientIp:method:pathname`, with `RATE_LIMIT_WINDOW_MS = 60000` and `RATE_LIMIT_MAX_REQUESTS = 100` per window.

---

### SEC-003: SSE Endpoint Has No Connection Limits or Timeouts

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:929-979` — `streamRemoteEvents()`  
**Status**: ✅ FIXED

Added `MAX_SSE_CONNECTIONS = 50` cap with `activeSseConnections` counter. Connections are rejected with 503 when the cap is reached. Added `SSE_HARD_TIMEOUT_MS = 60000` (1 minute) hard timeout per SSE session via `setTimeout`. Both counters are decremented in the `cleanup()` handler.

---

### SEC-004: Path Traversal Risk in Memory Evidence Resolution

**Severity**: Medium  
**Location**: `packages/opencode-memory/src/index.js:1437-1439` — `fromRepoRelative()`  
**Status**: ✅ FIXED

Added a boundary check after `path.resolve()` that verifies the resolved path starts with `repoRoot + path.sep`. If traversal is detected, the function throws an error instead of returning the resolved path.

---

### SEC-005: No Security Headers on Bridge HTTP Server

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:397-436`  
**Status**: ✅ FIXED

Added `SECURITY_RESPONSE_HEADERS` constant (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`) and apply them to every response at the top of the request handler.

---

### SEC-006: No Request Timeouts on Bridge HTTP Server

**Severity**: Low  
**Location**: `packages/opencode-bridge/src/index.js:397-436`  
**Status**: ✅ FIXED

Added `SERVER_TIMEOUT_MS = 30000` (30s) and `SERVER_HEADERS_TIMEOUT_MS = 35000` (35s). Per-request timeout is set via `request.setTimeout()` inside the handler, and server-wide limits are set on `server.timeout` and `server.headersTimeout` after `createServer()`.

---

### SEC-007: Telegram Webhook Endpoint Accepts Any POST Without Own Rate Limit

**Severity**: Low-Medium  
**Location**: `packages/opencode-bridge/src/index.js:700-745` — Telegram webhook handler  
**Status**: ✅ FIXED

Added `checkTelegramWebhookRateLimit()` function with separate limits (`TELEGRAM_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60000`, `TELEGRAM_WEBHOOK_RATE_LIMIT_MAX = 30`) tracked in `telegramWebhookRateLimitMap`. Enforced before processing Telegram webhook updates.

---

### SEC-008: Worker Spawning Uses `process.execPath` — Positive Pattern

**Severity**: Informational  
**Location**: `packages/opencode-orchestrator/src/index.js:1660-1673`  
**Evidence**:
```javascript
const child = spawn(process.execPath, [cliPath, '--repo-root', repoRoot, '--worker-id', workerId, '--worker-token', workerToken], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: process.env,
});
```
**Note**: This is a positive finding. Using `process.execPath` avoids shell interpretation risks. Arguments are passed as an array, not a shell string. The `opencode` command is resolved from PATH rather than hardcoded, but this is acceptable since `opencode` is the intended runtime.

---

### SEC-009: Prompt Passed to Subprocess — Correctly Implemented

**Severity**: Informational  
**Location**: `packages/opencode-kairos/src/index.js:744-756` and `packages/opencode-orchestrator/src/index.js:1612`  
**Evidence**:
```javascript
// Kairos cli.js:370
const child = spawn(process.execPath, [cliPath, '--', 'daemon', 'run', String(intervalMs), ...], {
  // ...
});

// kairos/index.js:905
const child = spawn(command, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
```
**Note**: Arguments are passed as arrays to `spawn()` (not through a shell string), which is the correct approach to avoid command injection. The `job.prompt` and `prompt` values are passed as individual array elements, not interpolated into a shell string.

---

### SEC-010: Timing-Safe Token Comparison Used Correctly

**Severity**: Informational (positive)  
**Location**: `packages/opencode-bridge/src/index.js:903-910`  
**Evidence**: The Telegram webhook secret and bearer token comparison use `timingSafeEqual()`.

---

### SEC-011: Atomic File Writes Throughout

**Severity**: Informational (positive)  
**Location**: Throughout codebase  
**Evidence**: Uses write-to-temp-then-rename pattern for all state files.

---

### SEC-012: No eval/Function Usage

**Severity**: Informational (positive)  
**Location**: Throughout codebase  
**Evidence**: Schema validation in packs uses a hand-written recursive validator without `eval()` or `new Function()`.

---

## Summary

| ID | Severity | Category | Location | Status |
|---|---|---|---|---|
| SEC-001 | Medium | DoS / Input Validation | `bridge/src/index.js` | ✅ FIXED |
| SEC-002 | Medium | DoS / Rate Limiting | `bridge/src/index.js` | ✅ FIXED |
| SEC-003 | Medium | DoS / Resource Limits | `bridge/src/index.js` | ✅ FIXED |
| SEC-004 | Medium | Path Traversal | `memory/src/index.js` | ✅ FIXED |
| SEC-005 | Medium | Security Headers | `bridge/src/index.js` | ✅ FIXED |
| SEC-006 | Low | DoS / Timeouts | `bridge/src/index.js` | ✅ FIXED |
| SEC-007 | Low-Medium | Rate Limiting | `bridge/src/index.js` | ✅ FIXED |
| SEC-008 | Positive | Subprocess Safety | `orchestrator/src/index.js` | ✅ VERIFIED |
| SEC-009 | Positive | Subprocess Safety | `kairos/src/index.js` | ✅ VERIFIED |
| SEC-010 | Positive | Crypto | `bridge/src/index.js` | ✅ VERIFIED |
| SEC-011 | Positive | Data Integrity | Throughout | ✅ VERIFIED |
| SEC-012 | Positive | Code Execution | Throughout | ✅ VERIFIED |

## Recommended Priority Order

All findings have been addressed. No outstanding items.

## Verification

All findings verified fixed. All 96 tests pass and all smoke tests pass.
