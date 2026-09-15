import type { MergedPullRequest } from "./types"
import type { ReleaseEvent, ReleaseFeed, ReleasePhase, ReleasePullRequest } from "./releases"

export type GitHubDeploymentStatus = {
  state: string
  createdAt: string
  updatedAt: string
  logUrl?: string | null
  environmentUrl?: string | null
}

export type GitHubDeployment = {
  id: string
  environment: string
  commitOid: string
  state: string
  createdAt: string
  updatedAt: string
  latestStatus?: GitHubDeploymentStatus | null
}

export type GitHubReleaseRepository = {
  nameWithOwner: string
  defaultBranch: string
  headSha: string
  history: string[]
  deployments: GitHubDeployment[]
}

const LIVE_PHASES = new Set<ReleasePhase>(["queued", "deploying"])
const TERMINAL_MS = 5 * 60_000
const RECENT_MS = 24 * 60 * 60_000

/** GitHub does not consistently set productionEnvironment, so names are the portable discovery signal. */
export function isProductionEnvironment(name: string, configuredPattern?: RegExp) {
  if (/\b(?:preview|staging|development|test)\b/i.test(name)) return false
  return (configuredPattern ?? /\bprod(?:uction)?\b/i).test(name)
}

export function releaseTargetLabel(repo: string, environment: string) {
  const withoutPrefix = environment.replace(/^\s*prod(?:uction)?\s*(?:[-–—:]\s*)?/i, "")
  const withoutSuffix = withoutPrefix.replace(/\s+(?:prod|production)\s*$/i, "")
  return withoutSuffix.trim() || repo.split("/").pop() || repo
}

function normalizedState(deployment: GitHubDeployment) {
  return (deployment.latestStatus?.state || deployment.state || "").toUpperCase()
}

function phaseFor(deployment: GitHubDeployment): ReleasePhase | undefined {
  switch (normalizedState(deployment)) {
    case "PENDING":
    case "QUEUED":
    case "WAITING":
      return "queued"
    case "IN_PROGRESS":
      return "deploying"
    case "SUCCESS":
    case "ACTIVE":
      return "succeeded"
    case "ERROR":
    case "FAILURE":
      return "failed"
    default:
      return undefined
  }
}

function wasSuccessful(deployment: GitHubDeployment) {
  const state = normalizedState(deployment)
  const lifecycle = deployment.state.toUpperCase()
  return state === "SUCCESS" || state === "ACTIVE" || lifecycle === "ACTIVE" || lifecycle === "INACTIVE"
}

function activityAt(deployment: GitHubDeployment) {
  return deployment.latestStatus?.updatedAt || deployment.latestStatus?.createdAt || deployment.updatedAt || deployment.createdAt
}

function successAt(deployment: GitHubDeployment) {
  return normalizedState(deployment) === "SUCCESS" ? activityAt(deployment) : deployment.createdAt
}

function prKey(pr: Pick<MergedPullRequest, "repo" | "number">) {
  return `${pr.repo}#${pr.number}`
}

type MutableReleasePr = { pr: MergedPullRequest; targets: Set<string>; releasedAt?: string }

function addPr(map: Map<string, MutableReleasePr>, pr: MergedPullRequest, target: string, releasedAt?: string) {
  const key = prKey(pr)
  const current = map.get(key) ?? { pr, targets: new Set<string>() }
  current.targets.add(target)
  if (releasedAt && (!current.releasedAt || Date.parse(releasedAt) > Date.parse(current.releasedAt))) current.releasedAt = releasedAt
  map.set(key, current)
}

function finishPr(entry: MutableReleasePr): ReleasePullRequest {
  return {
    ...entry.pr,
    targets: [...entry.targets].sort(),
    ...(entry.releasedAt ? { releasedAt: entry.releasedAt } : {}),
  }
}

function groupedDeployments(repo: GitHubReleaseRepository) {
  const groups = new Map<string, GitHubDeployment[]>()
  for (const deployment of repo.deployments) {
    const group = groups.get(deployment.environment) ?? []
    group.push(deployment)
    groups.set(deployment.environment, group)
  }
  for (const group of groups.values()) group.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return groups
}

function uniqueSuccesses(deployments: GitHubDeployment[]) {
  const seen = new Set<string>()
  return deployments.filter((deployment) => {
    if (!wasSuccessful(deployment) || seen.has(deployment.commitOid)) return false
    seen.add(deployment.commitOid)
    return true
  })
}

/** Turn GitHub's environment/deployment history into the same provider-neutral scene contract as an HTTP adapter. */
export function buildGitHubReleaseFeed(repositories: GitHubReleaseRepository[], pullRequests: MergedPullRequest[], now = Date.now()): ReleaseFeed {
  const waiting = new Map<string, MutableReleasePr>()
  const recent = new Map<string, MutableReleasePr>()
  const events: ReleaseEvent[] = []
  const prsByRepoCommit = new Map<string, Map<string, MergedPullRequest[]>>()

  for (const pr of pullRequests) {
    if (!pr.mergeCommit) continue
    const byCommit = prsByRepoCommit.get(pr.repo) ?? new Map<string, MergedPullRequest[]>()
    byCommit.set(pr.mergeCommit, [...(byCommit.get(pr.mergeCommit) ?? []), pr])
    prsByRepoCommit.set(pr.repo, byCommit)
  }

  for (const repo of repositories) {
    const historyIndex = new Map(repo.history.map((sha, index) => [sha, index]))
    const prsByCommit = prsByRepoCommit.get(repo.nameWithOwner) ?? new Map<string, MergedPullRequest[]>()
    const prsInRange = (from: number, to: number) =>
      repo.history.slice(Math.max(0, from), Math.max(from, to)).flatMap((sha) => prsByCommit.get(sha) ?? [])

    for (const [environment, deployments] of groupedDeployments(repo)) {
      const target = releaseTargetLabel(repo.nameWithOwner, environment)
      const successes = uniqueSuccesses(deployments)
      const baseline = successes[0]
      if (baseline) {
        const baselineIndex = historyIndex.get(baseline.commitOid)
        const end = baselineIndex === undefined ? repo.history.length : baselineIndex
        for (const pr of prsInRange(0, end)) addPr(waiting, pr, target)
      }

      for (let index = 0; index < successes.length; index++) {
        const deployed = successes[index]
        const releasedAt = successAt(deployed)
        if (now - Date.parse(releasedAt) >= RECENT_MS) continue
        const deployedIndex = historyIndex.get(deployed.commitOid)
        if (deployedIndex === undefined) continue
        const previousIndex = successes.slice(index + 1).map((item) => historyIndex.get(item.commitOid)).find((item) => item !== undefined)
        const end = previousIndex !== undefined && previousIndex > deployedIndex ? previousIndex : deployedIndex + 1
        for (const pr of prsInRange(deployedIndex, end)) addPr(recent, pr, target, releasedAt)
      }

      const newest = deployments[0]
      if (!newest) continue
      const phase = phaseFor(newest)
      const updatedAt = activityAt(newest)
      if (!phase || (!LIVE_PHASES.has(phase) && now - Date.parse(updatedAt) >= TERMINAL_MS)) continue
      const candidateIndex = historyIndex.get(newest.commitOid)
      const baselineIndex = baseline ? historyIndex.get(baseline.commitOid) : undefined
      const involved = candidateIndex === undefined ? [] : prsInRange(candidateIndex, baselineIndex !== undefined && baselineIndex > candidateIndex ? baselineIndex : candidateIndex + 1)
      events.push({
        id: newest.id,
        label: target,
        environment: "production",
        phase,
        startedAt: newest.createdAt,
        updatedAt,
        url: newest.latestStatus?.logUrl || newest.latestStatus?.environmentUrl || undefined,
        summary: repo.nameWithOwner,
        pullRequests: involved.map(prKey),
      })
    }
  }

  for (const key of waiting.keys()) recent.delete(key)
  events.sort((a, b) => Date.parse(b.updatedAt ?? b.startedAt ?? "") - Date.parse(a.updatedAt ?? a.startedAt ?? ""))
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    waiting: [...waiting.values()].map(finishPr).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, 300),
    recent: [...recent.values()].map(finishPr).sort((a, b) => Date.parse(b.releasedAt ?? "") - Date.parse(a.releasedAt ?? "")).slice(0, 300),
    events: events.slice(0, 30),
  }
}
