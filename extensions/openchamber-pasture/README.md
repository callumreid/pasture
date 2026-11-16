# Pasture for OpenChamber

See your GitHub pull requests as cows in the Pasture, in an OpenChamber panel. This is the CowCode 3D scene packaged as an extension; it does not require CowCode, the hosted Pasture app, or a background service.

## Install

You need OpenChamber **2.7.2 or newer** and your own GitHub personal access token. In OpenChamber:

1. Open **Settings → Extensions**. Paste this URL into the install field and install it:

   ```text
   https://github.com/callumreid/pasture/releases/download/openchamber-v1.0.0/pasture-openchamber.zip
   ```

   Allow the displayed GitHub network integration. This is a ZIP install, so OpenChamber copies the package to its server, even when the server is remote. If URL installation is blocked, download [the ZIP](https://github.com/callumreid/pasture/releases/download/openchamber-v1.0.0/pasture-openchamber.zip) and use the archive button in Extensions. ZIP installs do not update automatically; reinstall the new ZIP when an update is available.
2. In **Settings → Integrations → Pasture GitHub**, connect **your own** GitHub token. OpenChamber stores the token on its server and sends it to `api.github.com` through its integration proxy; the panel does not receive the token. Use a token with read access to the desired repositories' pull requests, reviews, checks, commit statuses and metadata. For a fine-grained token, start with repository permissions **Pull requests: read**, **Checks: read**, **Commit statuses: read**, and **Metadata: read**. GraphQL fields or organizational policy may require additional access. A fine-grained token is scoped to one resource owner and selected repositories; a classic token with `repo` can cover private repositories across owners but grants substantially broader access, including write access. Only grant what you trust. Organization approval, repository grants, or SSO authorization may be required. See [GitHub's token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
3. Open **Pasture** on the right rail. Expand it or open the full-page view for more room. Hover a cow for its PR; click to lift and inspect it, moo or open it; double-click to open it. Drag to orbit, scroll to zoom, and use Tour for the camera tour. Escape or Put it down releases a cow.

The extension uses GitHub.com, not GitHub Enterprise Server. It reads only PRs authored by the connected account; it is not the team-wide view of the standalone Pasture app. Repositories outside that token's access will not appear. Organization token restrictions or SSO can hide private repositories; an empty result does not prove the token sees every repository. Errors are shown in the panel.

## What it shows

While open, the panel refreshes every minute and searches the authenticated user's open PRs and PRs merged since the UTC date seven days ago. It reads up to 100 of each search and draws at most 150 cows, with open PRs first. A notice appears when these bounds omit results. Failed or incomplete responses retain the last successful herd with an error notice; switching or disconnecting accounts clears it.

Drafts, changes requested, awaiting review, ready and merged map to pens. Ready is conservative: GitHub must report approved and `CLEAN`, all returned review threads must be resolved and complete, and any reported checks must have succeeded. It is an approximation, not a merge authorization. Merge-queue cows, re-requested reviews and closed-without-merge burns are not identified. Transitions are observed only while the panel is open.

The San Francisco sun, resident characters and tour use the shared scene. Live weather, Datadog wolves, calendar parties, release integration, team/organization selection, and the standalone app's merge-history controls are not connected. No prompts are sent.

## Develop and package

From this folder, run `npm ci`, `npm run build`, `npm run typecheck`, and `npm test` (the tests use Bun). Run `python3 package.py` after building to regenerate the install ZIP. OpenChamber does not build extensions on install, so commit both the browser bundle and ZIP. The ZIP contains only the manifest, panel assets, and licenses; it contains no credentials or `node_modules`. `test/preview.html` is a synthetic host with example PRs and does not contact GitHub.

The vendored scene and moo sound came from [CowCode](https://github.com/callumreid/cow_code) commit `aaab0cf65a85d0547798f107c50c81ba9237dc11`; `vendor/pasture/pens.ts` replaces a type-only application import with the same local type. The bundle includes Three.js and the OpenChamber SDK. Their MIT license notices and CowCode's MIT notice are included in `licenses/` and the ZIP.
