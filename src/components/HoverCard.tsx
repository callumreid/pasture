"use client"

import type { PastureMember } from "@/lib/pasture/members"
import { openDetail } from "@/lib/pasture/members"
import { relative, repoShort } from "./format"

export function HoverCard(props: { member: PastureMember; collar: string | undefined; avatar: string | null; x: number; y: number; now: number; scope: string }) {
  const { member } = props
  return (
    <div className="hovercard" style={{ left: `${props.x + 14}px`, top: `${props.y + 14}px` }}>
      <div className="who" style={{ "--collar": props.collar ?? "#ccc" } as React.CSSProperties}>
        {props.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="avatar" src={props.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 20, height: 20 }} />
        ) : (
          <span className="bell" />
        )}
        <span>
          <strong>{member.author}</strong> · {member.breed.name}
        </span>
      </div>
      <div className="title">{member.pr.title}</div>
      <div className="meta">
        {repoShort(member.pr.repo, props.scope)}#{member.pr.number} ·{" "}
        {member.kind === "merged"
          ? member.release === "waiting"
            ? `waiting for release · merged ${relative(member.pr.mergedAt, props.now)}`
            : member.release === "recent"
              ? `released ${relative(member.pr.releasedAt ?? member.pr.mergedAt, props.now)}`
              : `merged ${relative(member.pr.mergedAt, props.now)}`
          : `${openDetail(member.pr)} · updated ${relative(member.pr.updatedAt, props.now)}`}
      </div>
    </div>
  )
}
