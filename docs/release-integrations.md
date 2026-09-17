# Release integrations

Pasture can optionally show release state without depending on a particular CI/CD product. The
simplest source is GitHub's own deployment ledger; an HTTP JSON feed remains available when the
authoritative state only exists in another provider.

## GitHub Deployments — no adapter

```dotenv
PASTURE_RELEASE_GITHUB=1
# Optional: only observe these repositories instead of auto-discovering the organization.
# PASTURE_RELEASE_GITHUB_REPOS=acme/api,acme/web
# Optional: override the case-insensitive production environment expression.
# PASTURE_RELEASE_GITHUB_PRODUCTION_PATTERN=\bprod(?:uction)?\b
PASTURE_RELEASE_SCOPES=acme
```

This uses the same GitHub credential as the rest of Pasture: `GITHUB_TOKEN`, `PASTURE_GH_CLI=1`,
or the signed-in viewer's OAuth token. No deployment credential reaches the browser and no webhook,
push process, or separately hosted adapter is required. The Mac TV installer persists these
settings when they are supplied to `scripts/mini/install.sh`.

For each allowed organization, Pasture discovers the most recently pushed repositories with
GitHub environments whose names contain `prod` or `production`. Preview, staging, development,
and test environments are excluded. It then reads:

- default-branch commit history and merged pull requests;
- production deployment SHAs and their latest GitHub Deployment status;
- successive successful production deployments from the last 24 hours.

A pull request is `waiting` while its merge commit is newer than an observed successful production
SHA. In a monorepo with several production environments, it remains waiting until every observed
environment whose SHA is behind has caught up; the environment names become its `targets`.
Successive successful deployment SHAs determine the `recent` set. Pending and in-progress GitHub
deployments drive queued/deploying weather; success and failure produce the short terminal effect.

Discovery is intentionally bounded to 100 recently pushed organization repositories, 30 release
repositories, 50 environments per repository, 60 production deployments, the newest 100 commits,
and pull requests merged in the last 30 days. `PASTURE_RELEASE_GITHUB_REPOS` is recommended for a
large or noisy organization. GitHub state is observational: if a deployment can change without
updating GitHub Deployments, use the HTTP source below rather than treating this picture as
provider-authoritative.

When both sources are configured, the built-in GitHub source takes precedence.

## HTTP feed

A small adapter can instead translate whatever a release system knows into one JSON feed:

- `waiting`: pull requests merged into the release branch but not present in the production
  marker. For a branch-based pipeline this is commonly the `production...main` diff.
- `recent`: pull requests verified in production during a lookback chosen by the adapter (24
  hours is a useful default).
- `events`: scheduled or live release attempts. These drive the release status and the animated
  weather over the field.

Set the URL on the Pasture server:

```dotenv
PASTURE_RELEASE_FEED_URL=https://releases.example.com/pasture
PASTURE_RELEASE_FEED_TOKEN=a-server-only-bearer-token
PASTURE_RELEASE_SCOPES=acme
```

`PASTURE_RELEASE_SCOPES` is a comma-separated allowlist and defaults to
`PASTURE_DEFAULT_ORG`. Pasture only fetches and returns the feed while someone is looking at an
allowed organization's field and their GitHub identity belongs to that organization. The bearer
token stays on the server.

Pasture makes a `GET` request with `Accept: application/json`, the optional bearer token, and an
`X-Pasture-Scope` header containing the lower-case organization name. The response is schema
version 1:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-15T18:04:00Z",
  "window": {
    "active": true,
    "label": "Tuesday production hour",
    "startsAt": "2026-09-15T18:00:00Z",
    "endsAt": "2026-09-15T19:00:00Z"
  },
  "waiting": [
    {
      "repo": "acme/widgets",
      "number": 42,
      "title": "Make the widget shinier",
      "url": "https://github.com/acme/widgets/pull/42",
      "author": "octocat",
      "authorAvatar": "https://avatars.githubusercontent.com/u/583231",
      "mergedAt": "2026-09-15T17:21:00Z",
      "base": "main",
      "targets": ["web"]
    }
  ],
  "recent": [
    {
      "repo": "acme/api",
      "number": 91,
      "title": "Faster responses",
      "url": "https://github.com/acme/api/pull/91",
      "author": "mona",
      "mergedAt": "2026-09-15T12:10:00Z",
      "releasedAt": "2026-09-15T18:03:00Z",
      "targets": ["api"]
    }
  ],
  "events": [
    {
      "id": "release-2026-09-15-web",
      "label": "Web",
      "environment": "production",
      "phase": "verifying",
      "startedAt": "2026-09-15T18:01:00Z",
      "updatedAt": "2026-09-15T18:04:00Z",
      "url": "https://ci.example.com/runs/1234",
      "summary": "Health checks",
      "pullRequests": ["acme/widgets#42"]
    }
  ]
}
```

Only `repo`, `number`, `title`, `url`, `author`, and `mergedAt` are needed for a pull request.
Pasture accepts these event phases:

| Phase | Meaning in the field |
| --- | --- |
| `scheduled` | The release window is open; the sky begins to turn. |
| `queued` | A release attempt exists but has not started work. |
| `testing` | Release tests or pre-deploy checks are running. |
| `deploying` | Production is changing; the mothership and storm peak. |
| `verifying` | Production health is being checked. |
| `succeeded` | A short green clearing after success. |
| `failed` | A short red storm that links to the failed attempt. |

Live phases take priority when several services release at once. A terminal event remains visible
for five minutes when it has an `updatedAt`. The adapter should move a pull request from `waiting`
to `recent` only after the production environment is authoritative and verified; that feed change
is what makes the hand (or the occasional little UFO) carry its cow into the release paddock.
