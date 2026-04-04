# Security Best Practices Report

## Executive Summary

The opencode-extension-stack implements several positive security patterns (timing-safe token comparison, atomic file writes, array-arg subprocess spawning, no eval/Function usage) but has medium-priority gaps in DoS protection, request validation, path traversal mitigation, and server hardening. No critical remote-code execution vectors were identified.

---

## Findings

### SEC-001: No Request Body Size Limits on Bridge HTTP Server

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:912-921` — `readJsonRequestBody()`  
**Evidence**:
```javascript
async function readJsonRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  // ...
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```
This function is used at lines 647 and 699 to parse incoming request bodies. There is no size limit on the accumulated chunks.

**Impact**: An unauthenticated or authenticated attacker could send an arbitrarily large request body to exhaust server memory (DoS). The function is called from route handlers including the Telegram webhook and remote action handlers.

**Fix**: Add a size cap before accumulating:
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
**Evidence**:
```javascript
const server = http.createServer((request, response) => {
  handleBridgeHttpRequest(repoRoot, request, response).catch((error) => {
```
The server has no rate limiting middleware. All endpoints including `/v1/remote/action/...` (approve/revoke) and `/v1/telegram/webhook` lack rate controls.

**Impact**: An attacker with network access could flood any endpoint. The Telegram webhook endpoint is particularly exposed since it is designed to receive unsolicited callbacks.

**Fix**: Add a simple in-memory rate limiter or use the `express-rate-limit` pattern adapted for the raw HTTP server. Alternatively, configure rate limiting at the reverse proxy layer.

**Mitigation**: Deploy behind a WAF or reverse proxy with rate limiting configured.

---

### SEC-003: SSE Endpoint Has No Connection Limits or Timeouts

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:929-979` — `streamRemoteEvents()`  
**Evidence**:
```javascript
async function streamRemoteEvents(repoRoot, request, response, context) {
  // ...
  const heartbeat = setInterval(() => {
    response.write(': keepalive\n\n');
  }, 15000);
  // SSE loop runs indefinitely; no max connection count
  // no timeout on the request
```
**Impact**: A malicious client could open many SSE connections and hold them open indefinitely, exhausting server file descriptors and memory. Long-running SSE connections also consume CPU for keepalive heartbeats.

**Fix**: Track active SSE connections and enforce a maximum:
```javascript
const MAX_SSE_CONNECTIONS = 50;
let activeSseConnections = 0;

async function streamRemoteEvents(repoRoot, request, response, context) {
  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    response.writeHead(503);
    response.end('Too many connections');
    return;
  }
  activeSseConnections++;
  request.on('close', () => activeSseConnections--);

  // Add request timeout
  request.setTimeout(60000, () => {
    response.end();
  });
  // ...
}
```

---

### SEC-004: Path Traversal Risk in Memory Evidence Resolution

**Severity**: Medium  
**Location**: `packages/opencode-memory/src/index.js:1437-1439` — `fromRepoRelative()`
**Evidence**:
```javascript
function fromRepoRelative(repoRoot, relativePath) {
  return path.resolve(repoRoot, relativePath);
}
```
This is called at lines 843, 866, and 889 with `evidence.resultPath`, `evidence.statePath`, and `evidence.teamPath` respectively. These paths are stored inside topic JSON files created from memory evidence data.

**Impact**: If an attacker can inject or modify evidence paths stored in a memory entry (via a crafted `/memory add` with a manipulated `--run` or `--worker` reference whose result file contains malicious paths), they could cause `fromRepoRelative` to resolve to files outside the repo (e.g., `../../../etc/passwd`).

However, evidence paths are currently written only by the system itself when jobs/workers complete — not directly by users. The risk is moderate and depends on the integrity of the `.opencode/runs/` and `.opencode/workers/` directories.

**Fix**: Validate resolved paths stay within repoRoot:
```javascript
function fromRepoRelative(repoRoot, relativePath) {
  const resolved = path.resolve(repoRoot, relativePath);
  if (!resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`Path traversal attempt: ${relativePath}`);
  }
  return resolved;
}
```

---

### SEC-005: No Security Headers on Bridge HTTP Server

**Severity**: Medium  
**Location**: `packages/opencode-bridge/src/index.js:397-436`  
**Evidence**: The HTTP server uses `http.createServer()` directly without adding any security headers.

**Impact**: Without `X-Content-Type-Options: nosniff`, browsers may MIME-sniff responses and execute content types that shouldn't be executed. Without CSP, XSS risks are higher. The server exposes `X-Powered-By` implicitly.

**Fix**: Add security headers to all responses:
```javascript
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const server = http.createServer((request, response) => {
  // Set security headers on all responses
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  // ...
});
```

Note: The server does not use Express, so `helmet` cannot be used directly without refactoring to Express.

---

### SEC-006: No Request Timeouts on Bridge HTTP Server

**Severity**: Low  
**Location**: `packages/opencode-bridge/src/index.js:397-436`  
**Evidence**: The raw HTTP server has no `server.timeout` configured and no per-request timeouts.

**Impact**: Slow-client attacks (Slowloris) can hold connections open indefinitely, exhausting the connection pool.

**Fix**:
```javascript
const server = http.createServer((request, response) => {
  request.setTimeout(30000); // 30s per request
  // ...
});
server.timeout = 30000;
server.headersTimeout = 35000; // slightly longer than timeout
```

---

### SEC-007: Telegram Webhook Endpoint Accepts Any POST Without Own Rate Limit

**Severity**: Low-Medium  
**Location**: `packages/opencode-bridge/src/index.js:700-745` — Telegram webhook handler  
**Evidence**: The Telegram webhook handler (`POST /v1/telegram/webhook`) validates the secret token correctly using `isTelegramWebhookAuthorized()` but has no rate limit per IP or per chat.

**Impact**: If the secret is compromised or brute-forced, an attacker could flood the system with fake Telegram updates.

**Fix**: Add IP-based rate limiting for the webhook endpoint. Consider tracking Telegram chat IDs and enforcing per-user limits.

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

| ID | Severity | Category | Location |
|---|---|---|---|
| SEC-001 | Medium | DoS / Input Validation | `bridge/src/index.js:912` |
| SEC-002 | Medium | DoS / Rate Limiting | `bridge/src/index.js:403` |
| SEC-003 | Medium | DoS / Resource Limits | `bridge/src/index.js:929` |
| SEC-004 | Medium | Path Traversal | `memory/src/index.js:1437` |
| SEC-005 | Medium | Security Headers | `bridge/src/index.js:403` |
| SEC-006 | Low | DoS / Timeouts | `bridge/src/index.js:403` |
| SEC-007 | Low-Medium | Rate Limiting | `bridge/src/index.js:700` |
| SEC-008 | Positive | Subprocess Safety | `orchestrator/src/index.js:1660` |
| SEC-009 | Positive | Subprocess Safety | `kairos/src/index.js:905` |
| SEC-010 | Positive | Crypto | `bridge/src/index.js:903` |
| SEC-011 | Positive | Data Integrity | Throughout |
| SEC-012 | Positive | Code Execution | Throughout |

## Recommended Priority Order

1. **SEC-001** — Add request body size limits (quick fix, high impact)
2. **SEC-004** — Add path traversal guard on `fromRepoRelative` (quick fix, high impact)
3. **SEC-005** — Add security headers (quick fix, medium impact)
4. **SEC-002** — Add rate limiting (medium effort, high impact)
5. **SEC-003** — Add SSE connection limits and timeouts (medium effort, medium impact)
6. **SEC-006** — Add server timeouts (quick fix, low impact)
7. **SEC-007** — Add Telegram webhook rate limiting (low effort, low-medium impact)

## Verification

Run `npm audit` in each package directory to check for vulnerable dependencies. The bridge server's raw `http.createServer()` usage means it cannot leverage Express middleware (helmet, express-rate-limit) without refactoring to Express.
