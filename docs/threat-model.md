# Threat model

## Assets

- Document contents (shapes, text, names).
- Share-link tokens, which are the only credential.
- Server availability for everyone sharing an instance.

## Trust boundaries

Browsers are untrusted. The server trusts only its own code, Postgres and its
environment (`SESSION_SECRET`, `DATABASE_URL`).

## Threats and mitigations

| Threat                                         | Mitigation                                                                                                                     | Where                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Guessing a document's link                     | 128-bit random tokens; only SHA-256 hashes stored; constant-time comparison                                                    | `auth.ts`                         |
| Token leaking via logs or `Referer`            | Tokens live in the URL fragment, never sent in HTTP requests; `Referrer-Policy: no-referrer`; request logging off              | `api.ts`, `app.ts`                |
| A leaked link                                  | Reset links (rotate both tokens); all open connections are closed                                                              | `POST /api/docs/:id/rotate-links` |
| Viewer editing the document                    | Role checked on the server for every batch; the UI hiding tools is cosmetic                                                    | `room-server.ts`                  |
| Hijacking another tab's client id on reconnect | Client ids are proven by an HMAC (`SESSION_SECRET`) bound to the document                                                      | `auth.ts`                         |
| Malformed or hostile ops corrupting state      | zod-validated envelope; every property validated (type, range, length); invalid batches rejected atomically; invariants fuzzed | `protocol`, `doc-model`           |
| Flooding: messages, ops, presence, connections | per-connection token buckets; per-IP connection and join limits; 256 KB message cap; document creation rate limit              | `ws.ts`, `app.ts`                 |
| Slow consumer exhausting memory                | Outbound buffer capped at 4 MB, then the socket is closed                                                                      | `ws.ts`                           |
| Huge documents                                 | 200,000 nodes per clipboard import; per-property size caps (20,000 points, 10,000 characters)                                  | `validate.ts`, `clipboard.ts`     |
| XSS via names or text                          | Text is drawn on canvas; names render as React text; no `dangerouslySetInnerHTML`; strict CSP (`script-src 'self'`, no eval)   | `app.ts`                          |
| Cross-site WebSocket hijacking                 | No cookies or ambient credentials; optional `ALLOWED_ORIGINS` allow-list                                                       | `ws.ts`                           |
| Clickjacking                                   | `frame-ancestors 'none'`                                                                                                       | `app.ts`                          |
| Vulnerable dependencies                        | Dependabot, `pnpm audit`, CodeQL in CI                                                                                         | `.github/`                        |

## Known gaps

- No accounts: anyone holding a link has its access until the links are reset.
- No per-document quota beyond rate limits; a determined editor can grow a
  document until the node and size caps.
- Rate limits are per process and in memory.
- `ALLOWED_ORIGINS` is empty by default; production should set it.
