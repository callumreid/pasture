import "server-only"
import { createHash } from "node:crypto"
import { fetchRecentMergedPullRequests, graphql } from "@/lib/github"
import { buildGitHubReleaseFeed, isProductionEnvironment, type GitHubDeployment, type GitHubReleaseRepository } from "@/lib/pasture/github-releases"
import type { ReleaseFeed } from "@/lib/pasture/releases"

const DISCOVERY_KEEP_MS = 10 * 60_000
const DEPLOYMENT_KEEP_MS = 25_000
const HISTORY_KEEP_MS = 60_000
const MAX_REPOSITORIES = 30

type DiscoveredRepository = { nameWithOwner: string; defaultBranch: string; environments: string[] }
type Cached<T> = { at: number; value: T }

const discoveryCache = new Map<string, Cached<DiscoveredRepository[]>>()
const deploymentCache = new Map<string, Cached<Map<string, GitHubDeployment[]>>>()
const historyCache = new Map<string, Cached<Map<string, { headSha: string; history: string[] }>>>()
const pullRequestCache = new Map<string, Cached<Awaited<ReturnType<typeof fetchRecentMergedPullRequests>>["items"]>>()
const inflight = new Map<string, Promise<unknown>>()

function enabled(value: string | undefined) {
  return /^(?:1|true|yes|on)$/i.test(value ?? "")
}

export function githubReleaseConfigured() {
  return enabled(process.env.PASTURE_RELEASE_GITHUB)
}

function tokenKey(token: string, scope: string) {
  const configuration = `${process.env.PASTURE_RELEASE_GITHUB_REPOS ?? ""}|${process.env.PASTURE_RELEASE_GITHUB_PRODUCTION_PATTERN ?? ""}`
  return `${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${scope}|${configuration}`
}

async function cached<T>(bucket: string, map: Map<string, Cached<T>>, key: string, keepMs: number, load: () => Promise<T>): Promise<T> {
  const hit = map.get(key)
  if (hit && Date.now() - hit.at < keepMs) return hit.value
  const inflightKey = `${bucket}|${key}`
  const running = inflight.get(inflightKey) as Promise<T> | undefined
  if (running) return running
  const promise = load()
    .then((value) => {
      map.set(key, { at: Date.now(), value })
      if (map.size > 100) map.delete(map.keys().next().value!)
      return value
    })
    .finally(() => inflight.delete(inflightKey))
  inflight.set(inflightKey, promise)
  return promise
}

function productionPattern() {
  const configured = process.env.PASTURE_RELEASE_GITHUB_PRODUCTION_PATTERN?.trim()
  if (!configured || configured.length > 200) return undefined
  try {
    return new RegExp(configured, "i")
  } catch {
    return undefined
  }
}

function repositoryAllowlist(scope: string) {
  const configured = process.env.PASTURE_RELEASE_GITHUB_REPOS
  if (!configured) return undefined
  return new Set(
    configured
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => (item.includes("/") ? item : `${scope}/${item}`)),
  )
}

const DISCOVERY_QUERY = `
query($scope: String!) {
  organization(login: $scope) {
    repositories(first: 100, orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        nameWithOwner isArchived
        defaultBranchRef { name }
        environments(first: 50) { nodes { name } }
      }
    }
  }
}`

type DiscoveryResponse = {
  organization?: {
    repositories: {
      nodes: {
        nameWithOwner: string
        isArchived: boolean
        defaultBranchRef?: { name: string } | null
        environments: { nodes: { name: string }[] }
      }[]
    }
  } | null
}

async function discoverRepositories(token: string, scope: string) {
  const data = await graphql<DiscoveryResponse>(token, DISCOVERY_QUERY, { scope })
  const allowed = repositoryAllowlist(scope)
  const pattern = productionPattern()
  return (data.organization?.repositories.nodes ?? [])
    .filter((repo) => !repo.isArchived && repo.defaultBranchRef && (!allowed || allowed.has(repo.nameWithOwner.toLowerCase())))
    .flatMap((repo) => {
      const environments = repo.environments.nodes.map((item) => item.name).filter((name) => isProductionEnvironment(name, pattern))
      return environments.length ? [{ nameWithOwner: repo.nameWithOwner, defaultBranch: repo.defaultBranchRef!.name, environments }] : []
    })
    .slice(0, MAX_REPOSITORIES)
}

function repositoryVariables(repositories: DiscoveredRepository[]) {
  const variables: Record<string, unknown> = {}
  for (const [index, repo] of repositories.entries()) {
    const [owner, name] = repo.nameWithOwner.split("/")
    variables[`owner${index}`] = owner
    variables[`name${index}`] = name
    variables[`environments${index}`] = repo.environments
  }
  return variables
}

type DeploymentResponse = Record<string, { deployments: { nodes: GitHubDeployment[] } } | null>

async function loadDeployments(token: string, repositories: DiscoveredRepository[]) {
  if (!repositories.length) return new Map<string, GitHubDeployment[]>()
  const declarations = repositories.flatMap((_, index) => [`$owner${index}: String!`, `$name${index}: String!`, `$environments${index}: [String!]!`]).join(", ")
  const selections = repositories
    .map(
      (_, index) => `repo${index}: repository(owner: $owner${index}, name: $name${index}) {
        deployments(first: 60, environments: $environments${index}, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { id environment commitOid state createdAt updatedAt latestStatus { state createdAt updatedAt logUrl environmentUrl } }
        }
      }`,
    )
    .join("\n")
  const data = await graphql<DeploymentResponse>(token, `query(${declarations}) { ${selections} }`, repositoryVariables(repositories))
  return new Map(repositories.map((repo, index) => [repo.nameWithOwner, data[`repo${index}`]?.deployments.nodes ?? []]))
}

type HistoryResponse = Record<
  string,
  { defaultBranchRef?: { target?: { oid: string; history?: { nodes: { oid: string }[] } } | null } | null } | null
>

async function loadHistories(token: string, repositories: DiscoveredRepository[]) {
  if (!repositories.length) return new Map<string, { headSha: string; history: string[] }>()
  const declarations = repositories.flatMap((_, index) => [`$owner${index}: String!`, `$name${index}: String!`]).join(", ")
  const selections = repositories
    .map(
      (_, index) => `repo${index}: repository(owner: $owner${index}, name: $name${index}) {
        defaultBranchRef { target { ... on Commit { oid history(first: 100) { nodes { oid } } } } }
      }`,
    )
    .join("\n")
  const allVariables = repositoryVariables(repositories)
  const variables = Object.fromEntries(Object.entries(allVariables).filter(([key]) => !key.startsWith("environments")))
  const data = await graphql<HistoryResponse>(token, `query(${declarations}) { ${selections} }`, variables)
  return new Map(
    repositories.flatMap((repo, index) => {
      const target = data[`repo${index}`]?.defaultBranchRef?.target
      return target?.oid ? [[repo.nameWithOwner, { headSha: target.oid, history: target.history?.nodes.map((item) => item.oid) ?? [target.oid] }]] : []
    }),
  )
}

/** Poll GitHub's own deployment ledger and refs with the same credential Pasture already uses for pull requests. */
export async function fetchGitHubReleaseFeed(token: string, scope: string, now = Date.now()): Promise<ReleaseFeed> {
  const key = tokenKey(token, scope)
  const repositories = await cached("discovery", discoveryCache, key, DISCOVERY_KEEP_MS, () => discoverRepositories(token, scope))
  if (!repositories.length) return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), waiting: [], recent: [], events: [] }
  const [deployments, histories, pullRequests] = await Promise.all([
    cached("deployments", deploymentCache, key, DEPLOYMENT_KEEP_MS, () => loadDeployments(token, repositories)),
    cached("history", historyCache, key, HISTORY_KEEP_MS, () => loadHistories(token, repositories)),
    cached("pull-requests", pullRequestCache, key, HISTORY_KEEP_MS, () =>
      fetchRecentMergedPullRequests(token, { kind: "org", login: scope }, 30, now).then((result) => result.items),
    ),
  ])
  const snapshots: GitHubReleaseRepository[] = repositories.flatMap((repo) => {
    const history = histories.get(repo.nameWithOwner)
    return history
      ? [{ nameWithOwner: repo.nameWithOwner, defaultBranch: repo.defaultBranch, headSha: history.headSha, history: history.history, deployments: deployments.get(repo.nameWithOwner) ?? [] }]
      : []
  })
  return buildGitHubReleaseFeed(snapshots, pullRequests, now)
}
