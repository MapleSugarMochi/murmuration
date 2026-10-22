# Deploying

Tandem ships as one Docker image (`deploy/Dockerfile`) that serves the API,
WebSockets and the web app, plus a Postgres database. These steps deploy it to
Fly.io; all commands run from the repository root in PowerShell.

## 1. Push to GitHub

```powershell
winget install --id GitHub.cli
gh auth login
gh repo create tandem --public --source . --remote origin --push
```

The first push starts CI: lint, typecheck, unit and convergence tests, Postgres
store tests, Playwright E2E, the Docker build and CodeQL.

## 2. Install flyctl and sign in

```powershell
iwr https://fly.io/install.ps1 -useb | iex
fly auth login
```

Fly needs a payment method on the account even for small apps.

## 3. Create the app (without deploying)

```powershell
fly launch --no-deploy --copy-config --config deploy/fly.toml --name tandem-<yourname> --region lhr
```

This writes your app name into `deploy/fly.toml`. Then set the allowed origin
there (`ALLOWED_ORIGINS = 'https://tandem-<yourname>.fly.dev'`).

## 4. Create the database and secrets

```powershell
fly postgres create --name tandem-<yourname>-db --region lhr --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach tandem-<yourname>-db --app tandem-<yourname>
fly secrets set --app tandem-<yourname> SESSION_SECRET=$(-join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) }))
```

`attach` sets `DATABASE_URL`. The server runs its migrations on start.

## 5. Deploy

```powershell
fly deploy --config deploy/fly.toml
fly open --app tandem-<yourname>
```

Check it: `/healthz` and `/readyz` should return `{"ok":true}`, and two
browser windows on one document link should see each other's cursors.

## Operating notes

- One machine on purpose (ADR 0004). A deploy restarts it: the server drains
  and snapshots every room on `SIGTERM`, and clients reconnect and resend.
- Metrics are on the private port 9091, which Fly scrapes; view them in the
  Fly dashboard's Grafana.
- `fly logs --app tandem-<yourname>` shows structured JSON logs.
- Rotate the session secret only with care: it invalidates resume tokens, so
  open tabs rejoin as new clients.
