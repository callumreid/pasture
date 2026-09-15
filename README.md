# 🐄 Pasture

**Every pull request on your team is a cow.**

<div align="center">

<img src="docs/media/hand-of-god.gif" alt="the hand of god lifts a cow out of the awaiting-review pen and carries it to ready to merge" width="840" />

▶️ [Watch it with sound](https://cdn.jsdelivr.net/gh/callumreid/pasture@main/docs/media/hand-of-god.mp4) · 🌾 [**pasture-six.vercel.app**](https://pasture-six.vercel.app) · 🐄 [**cow code**](https://github.com/callumreid/cow_code) for the full bovine agent experience

</div>

A green field with five fenced pens: **drafts**, **awaiting review**, **changes requested** and
**ready to merge** across the front, and the **merged** herd out back by the pond. Every pull
request anyone on your team touched in the last 24 hours is a cow in the pen for its stage. When a
PR moves on, the hand of god comes down, picks the cow up and carries it to its new pen. A brand-new
PR is lowered in from the sky. A closed one is taken away. One time in ten a flying saucer turns up
instead and does the job with a tractor beam.

Everyone on the team wears a different coloured cowbell collar, and the who's who menu says which
colour is whose. Hover a cow for its PR. Click it to lift it up, legs dangling, and read what is
holding it up. Double-click to open the PR on GitHub. It moos. The bell in the header makes every
cow moo as the hand of god picks it up (off by default; `?moo=1` in the URL turns it on for a TV).

Kobi the farmer walks the fences with a pitchfork, Moon and Bean at his heels. Click him and he
tells you to get back to work. The rest of the office pets run laps around the pens having a nice
time: Waffles, and the two black cats, Felix and Haru. Hover any of them for an introduction.

The sky over the field is San Francisco's. The sun sits where it really is (the light and the
shadows follow it), the colours run night to golden hour to day, stars and a moon come out, clouds
thicken with the cloud cover, and it rains on the field when it rains in the city. `?sky=off`
freezes a nice afternoon for screenshots.

Leave it on a TV with the **Tour** button on (or `?tour=1`) and the camera drifts around the farm
on its own: a slow push in on each pen, a low pass along the fences, a look at the barn, back out
wide. Touch it and it holds still for a minute. Off past the barn is the bay, the city, and the
Golden Gate Bridge; this is a farm, after all, so they are a long way off.

A cow in the merge queue hovers and turns slowly until its turn comes. John Pork lives in the
barn loft and shows his face at the window now and again.

An optional [release integration](docs/release-integrations.md) can replace the merged-history
herd with what is actually waiting to be released. The large back pasture divides evenly into
**waiting for release** and **recently released**, and an active release changes the weather while
a service-labelled mothership gathers over the field. Pasture can observe GitHub Deployments with
the same credential it already uses for pull requests, or consume a small provider-neutral JSON
feed for other release systems. With no release source configured, the original
merged-within-the-timeframe field is unchanged.

When a Datadog monitor goes into alert, a wolf comes out of the trees and prowls the fence line
until it clears. One wolf per firing alert (up to eight); hover one for the monitor's name, click
it to open the monitor. When an alert clears, Moon or Bean chases the wolf off. Wolves only show on the home organization's field, to its members.

<img src="docs/media/pasture.jpg" alt="the field: 125 merged cows out back, 55 open ones in the front pens" width="840" />

## Use it

Go to **[pasture-six.vercel.app](https://pasture-six.vercel.app)** and sign in with GitHub. Pick
your organization at the top left (or "just my PRs"), pick a window (24 hours by default), and
leave it open. The field re-reads GitHub every minute, so cows change pens as your PRs advance.

Two things to know:

- It asks GitHub for `repo` and `read:org`. That is what it takes to read private pull requests;
  the token lives in an encrypted cookie and is only ever used to ask GitHub about pull requests.
- If your organization restricts third-party OAuth apps, the field will look nearly empty (public
  repos only). Open your [connection settings](https://github.com/settings/connections/applications/Ov23li0q96SkgMyfEkKi)
  and click **Grant** next to the organization, or ask an owner to approve it once. The Grant
  button on GitHub's authorize screen does not always stick; the one on the connection page does.

## Put it on a TV

`scripts/mini/install.sh` turns any Mac into an always-on display: a launchd agent runs the server
on `127.0.0.1:3517` using the `gh` CLI's login (no sign-in, never logs out), and a second agent
keeps a kiosk Chrome window on the field.

```bash
git clone https://github.com/callumreid/pasture.git && cd pasture
gh auth login                               # once, if gh is not signed in
PASTURE_DEFAULT_ORG=your-org PASTURE_AWAKE=1 scripts/mini/install.sh
```

Then Control Center → Screen Mirroring → your TV, or an HDMI cable. `PASTURE_AWAKE=1` keeps a
laptop from sleeping while it feeds the TV. `scripts/mini/pasture-tv off` hides the kiosk window
and `on` brings it back; re-run the installer after a `git pull` to rebuild and restart. Add
`PASTURE_RELEASE_GITHUB=1` to the installer command to enable the optional release pasture using
the same `gh` login.

## Run your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcallumreid%2Fpasture&env=AUTH_GITHUB_ID,AUTH_GITHUB_SECRET,AUTH_SECRET,PASTURE_DEFAULT_ORG&envDescription=A%20GitHub%20OAuth%20app%27s%20client%20id%20and%20secret%2C%20a%20random%20session%20secret%2C%20and%20the%20organization%20the%20field%20opens%20on&project-name=pasture&repository-name=pasture)

1. Create a GitHub **OAuth App** (Settings → Developer settings → OAuth Apps → New). Homepage URL
   is your deployment; the callback URL is `https://<your-host>/api/auth/callback/github`. Leave
   "Expire user access tokens" **off**: the app has no refresh flow and an expiring token would log
   a TV out every eight hours.
2. Set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, a long random `AUTH_SECRET`, and
   `PASTURE_DEFAULT_ORG` (people who are not in that organization start on their own instead).
3. Deploy. Locally: `cp .env.example .env.local`, fill it in, `npm install`, `npm run dev`.

Wolves need Datadog: `DD_API_KEY`, `DD_APP_KEY` (an application key with `monitors_read`) and
`DD_SITE`. `DD_MONITOR_QUERY` narrows which monitors count (default `status:alert`). Leave them
unset and there are no wolves.

For release weather and release paddocks, set `PASTURE_RELEASE_GITHUB=1`. Pasture then discovers
production-like GitHub environments and polls their deployment ledger with the same GitHub token;
`PASTURE_RELEASE_GITHUB_REPOS` can narrow a large organization. An HTTP feed remains available for
systems whose release truth is not visible in GitHub. See
[release integrations](docs/release-integrations.md) for both options.

Without sign-in: set `GITHUB_TOKEN` and everyone who can reach the page sees that token's view of
the default organization, so put something in front of it. `PASTURE_GH_CLI=1` asks the `gh` CLI
for a token at request time instead (what the TV installer and local development use).

## How a cow picks its pen

One stage per PR, the most actionable problem first: draft → in the merge queue → changes
requested (or re-review requested, if the author pushed since) → checks failing → unresolved
comments → awaiting review → ready. Drafts, changes requested and ready get their own pens;
everything else waits in "awaiting review".

A pull request closed without merging is a cow that catches fire where it stands: it chars,
collapses into the grass and leaves a scorch mark that fades. A cow whose PR just vanished from the
open list waits in its pen for a few minutes so GitHub's merged search can catch up; that way a
merge reads as a move to the back pen, not a disappearance.
If a whole herd changes at once (you switched organizations or timeframes), the field just updates.
The hand is for moments, not migrations.

## Under the hood

Next.js on Vercel, Auth.js for the GitHub sign-in, GitHub's GraphQL search for the herd, three.js
for the field. Everything on the field is built from primitives and canvas textures; there are no
model files. A cow is seven meshes sharing one texture atlas per breed (thirty-two breeds, Nguni included, coats
painted on the fly, a PR is always the same cow), so a few hundred fit in a frame.

```bash
npm run dev         # local dev server
npm run typecheck   # tsc
npm test            # vitest: pens, members, breeds, collars, stage derivation
npm run build       # production build
npm run media       # re-record docs/media/hand-of-god.* from a running dev server
```

## 🐄 Want the whole cow?

This is one field out of [**cow code**](https://github.com/callumreid/cow_code), a full terminal
and desktop AI coding agent lovingly led out to pasture. Over there the Pasture is a panel beside
your sessions, the cows are your own PRs, and the same farm keeps them updated, fixes their review
comments and merges them when they are ready, with the Farmer's Office watching over the lot. This
repo is only the field, for a whole team, on a TV, with no agent required. For the full bovine agent
experience, go get the cow: <https://github.com/callumreid/cow_code>.
