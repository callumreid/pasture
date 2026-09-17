"use client"

import { useEffect, useState } from "react"
import type { PastureMember } from "@/lib/pasture/members"
import { openDetail } from "@/lib/pasture/members"
import { absolute, plural, relative, repoShort } from "./format"

type Stats = { additions: number; deletions: number; changedFiles: number }

/** A merged cow's diff is not in the herd (thousands of them would slow every read); ask for it when the cow is lifted. */
function useStats(member: PastureMember): Stats | undefined {
  const pr = member.pr
  const known = typeof pr.additions === "number" && typeof pr.deletions === "number" && typeof pr.changedFiles === "number" ? { additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles } : undefined
  const [fetched, setFetched] = useState<{ id: string; stats: Stats | undefined }>()
  useEffect(() => {
    if (known) return
    let cancelled = false
    const params = new URLSearchParams({ repo: pr.repo, number: String(pr.number) })
    fetch(`/api/pr?${params}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as Stats) : undefined))
      .then((stats) => {
        if (!cancelled) setFetched({ id: member.id, stats })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [member.id, pr.repo, pr.number, known])
  return known ?? (fetched?.id === member.id ? fetched.stats : undefined)
}

export function Inspector(props: {
  member: PastureMember
  collar: string | undefined
  avatar: string | null
  now: number
  scope: string
  mooing: boolean
  onMoo: () => void
  onClose: () => void
}) {
  const { member } = props
  const pr = member.pr
  const merged = member.kind === "merged" ? member.pr : undefined
  const release = member.kind === "merged" ? member.release : undefined
  const releasedAt = release === "recent" ? merged?.releasedAt : undefined
  const open = member.kind === "open" ? member.pr : undefined
  const stats = useStats(member)
  return (
    <section className="inspector" aria-label="Selected pull request">
      <div className="head" style={{ "--collar": props.collar ?? "#ccc" } as React.CSSProperties}>
        {props.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="avatar large" src={props.avatar} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="avatar large" />
        )}
        <div className="text">
          <span className="breed">
            {member.author} · {member.breed.name}
          </span>
          <a className="title" href={pr.url} target="_blank" rel="noopener noreferrer">
            {pr.title}
          </a>
          <span className="repo">
            {repoShort(pr.repo, props.scope)} #{pr.number}
            {merged ? ` → ${merged.base}` : open?.head ? ` · ${open.head} → ${open.base}` : ""}
          </span>
        </div>
        <button type="button" className="close" aria-label="Put the cow down" onClick={props.onClose}>
          ×
        </button>
      </div>

      {merged ? (
        <>
          <div className="stage">
            {release === "waiting" ? "Waiting for release" : release === "recent" ? `Released ${absolute(releasedAt ?? merged.mergedAt)}` : `Merged ${absolute(merged.mergedAt)}`}
          </div>
          <div className="row">
            {releasedAt ? <span>released {relative(releasedAt, props.now)} · </span> : null}
            <span>merged {relative(merged.mergedAt, props.now)}</span>
            {merged.mergedBy && merged.mergedBy !== merged.author ? <span>· merged by {merged.mergedBy}</span> : null}
            <span>· opened {absolute(merged.createdAt)}</span>
          </div>
        </>
      ) : null}
      {open ? (
        <>
          <div className="stage">{openDetail(open)}</div>
          <div className="row">
            <span>opened {absolute(open.createdAt)}</span>
            <span>· updated {relative(open.updatedAt, props.now)}</span>
            {open.reviewers.length ? <span>· waiting on {open.reviewers.join(", ")}</span> : null}
            {member.kind === "open" && member.held ? <span>· just left the open list, waiting to see it merge</span> : null}
          </div>
        </>
      ) : null}

      <div className="row">
        <span className="add">+{stats ? stats.additions : "…"}</span>
        <span className="del">−{stats ? stats.deletions : "…"}</span>
        <span>· {stats ? plural(stats.changedFiles, "file") : "files…"}</span>
        {pr.labels.map((label) => (
          <span key={label} className="tag">
            {label}
          </span>
        ))}
      </div>

      <div className="actions">
        <button type="button" className="btn primary" disabled={props.mooing} onClick={props.onMoo}>
          {props.mooing ? "Moooo…" : "Moo"}
        </button>
        <a className="btn" href={pr.url} target="_blank" rel="noopener noreferrer">
          Open PR ↗
        </a>
        <button type="button" className="btn quiet" onClick={props.onClose}>
          Put it down
        </button>
      </div>
    </section>
  )
}
