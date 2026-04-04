# Remote Bridge And Telegram Setup

This stack supports two remote operating modes:

- authenticated HTTP clients using bearer tokens
- Telegram-driven enqueue and approval flows

## Basic HTTP Setup

1. Start the bridge locally:

```bash
pnpm run bridge -- /remote serve 8787
```

2. Inspect auth state:

```bash
pnpm run bridge -- /remote auth
```

3. Create an extra named token when needed:

```bash
pnpm run bridge -- /remote auth create ci-bot
pnpm run bridge -- /remote auth create mobile-session --session --expires-seconds 900
```

4. Revoke or rotate tokens:

```bash
pnpm run bridge -- /remote auth revoke <token-id>
pnpm run bridge -- /remote auth rotate-default
```

## Config Fields

Add bridge settings under `remote` in repo config.

```json
{
  "remote": {
    "approvalRequired": true,
    "maxStatusRequests": 20,
    "publicBaseUrl": "https://bridge.example.com",
    "approvalTokenTtlSeconds": 1800,
    "telegram": {
      "botToken": "<telegram-bot-token>",
      "allowedUserIds": ["123456789"],
      "apiBaseUrl": "https://api.telegram.org",
      "webhookSecret": "<shared-secret>"
    }
  }
}
```

## Telegram Polling Mode

Use polling when you do not want to expose a webhook endpoint.

```bash
pnpm run bridge -- telegram sync
pnpm run bridge -- telegram sync 20
```

## Telegram Webhook Mode

1. Set `remote.publicBaseUrl`
2. Set `remote.telegram.webhookSecret`
3. Start the bridge server
4. Point Telegram to:

```text
<publicBaseUrl>/v1/telegram/webhook
```

Inspect the expected webhook values with:

```bash
pnpm run bridge -- telegram webhook-info
```

## Common Remote Workflow

1. enqueue a request:

```bash
pnpm run bridge -- /remote enqueue "/review inspect current diff" --requested-by mobile
```

2. check status:

```bash
pnpm run bridge -- /remote status
pnpm run bridge -- /remote status <remote-id>
```

3. approve if required:

```bash
pnpm run bridge -- /remote approve <remote-id>
```

4. revoke if needed:

```bash
pnpm run bridge -- /remote revoke <remote-id>
```

## Notes

- review-style remote requests automatically generate remote review packets
- signed approval links are available when `publicBaseUrl` is configured
- SSE remote events are available from the bridge HTTP server for status streaming clients
