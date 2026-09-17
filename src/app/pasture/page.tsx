import { redirect } from "next/navigation"
import { auth } from "@/auth"
import Pasture from "@/components/Pasture"
import { authConfigured, tokenMode } from "@/lib/token"
import { signOutAction } from "./actions"
import { releaseSourceConfigured } from "@/lib/release-feed-server"

export const dynamic = "force-dynamic"

export default async function PasturePage() {
  const mode = tokenMode()
  if (!mode) {
    if (!authConfigured()) redirect("/")
    const session = await auth()
    if (!session) redirect("/")
  }
  return (
    <Pasture
      defaultScope={process.env.PASTURE_DEFAULT_ORG || "me"}
      tokenMode={mode}
      releaseEnabled={releaseSourceConfigured()}
      signOut={mode ? undefined : signOutAction}
    />
  )
}
