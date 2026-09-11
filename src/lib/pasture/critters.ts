/**
 * Everyone on the field who is not a cow: the farmer, and the office pets
 * from #moon-bean-appreciation, who run laps around the pens having a nice time.
 */
import type { AlarmSeverity } from "./types"

export type CritterKind = "dog" | "cat" | "farmer" | "wolf"

export type Critter = {
  id: string
  name: string
  kind: CritterKind
  /** One line for the hover card. */
  blurb: string
  /** Coat colour; the farmer's is his hoodie. */
  body: string
  /** Second colour: a muzzle and chest for dogs, unused for cats. */
  patch?: string
  eyes: string
  /** Relative size; a cow is 1. */
  size: number
  ears: "floppy" | "up" | "point"
  legs: "short" | "regular"
  /** Cruising speed in field units per second. */
  speed: number
  /** Whose heels this one stays on. */
  follows?: string
  /** Eyes that shine: wolves. */
  glow?: boolean
}

export const FARMER_ID = "kobi"

export const CRITTERS: Critter[] = [
  {
    id: FARMER_ID,
    name: "Kobi",
    kind: "farmer",
    blurb: "The farmer. Walks the fences. Do not click.",
    body: "#1c1c1c",
    eyes: "#1d1917",
    size: 1,
    ears: "up",
    legs: "regular",
    speed: 1.6,
  },
  {
    id: "moon",
    name: "Moon",
    kind: "dog",
    blurb: "Kobi's queen. Does NOT want to go on a walk.",
    body: "#efe9dc",
    patch: "#f8f5ee",
    eyes: "#2b1d14",
    size: 0.84,
    ears: "floppy",
    legs: "regular",
    speed: 3.4,
    follows: FARMER_ID,
  },
  {
    id: "bean",
    name: "Bean",
    kind: "dog",
    blurb: "Kobi's other one. Famous for the bean lean.",
    body: "#c0763d",
    patch: "#e8c79a",
    eyes: "#2b1d14",
    size: 0.68,
    ears: "floppy",
    legs: "short",
    speed: 2.6,
    follows: FARMER_ID,
  },
  {
    id: "waffles",
    name: "Waffles",
    kind: "dog",
    blurb: "Mallory's prince. Every photo a renaissance painting.",
    body: "#d9a45f",
    patch: "#f7f1e6",
    eyes: "#2b1d14",
    size: 0.68,
    ears: "floppy",
    legs: "regular",
    speed: 3.8,
  },
  {
    id: "felix",
    name: "Felix",
    kind: "cat",
    blurb: "Office cat, north corner. Profoundly masculine.",
    body: "#141414",
    eyes: "#7bd389",
    size: 0.58,
    ears: "point",
    legs: "regular",
    speed: 2.8,
  },
  {
    id: "haru",
    name: "Haru",
    kind: "cat",
    blurb: "Office cat, south corner. It's her desk now.",
    body: "#181818",
    eyes: "#f0c419",
    size: 0.52,
    ears: "point",
    legs: "regular",
    speed: 3.2,
  },
]

export const critterByID = (id: string) => CRITTERS.find((critter) => critter.id === id)

/** What the farmer says when you click him. He is busy. */
export const FARMER_LINES = [
  "Get back to work.",
  "Those PRs won't review themselves.",
  "I'm not paying you to click on me.",
  "Cows to move. Comments to resolve. Chop chop.",
  "Ship it. Then we'll talk.",
  "You've got three unresolved threads and you're poking a farmer?",
  "Queues are lookin' healthy. Your PR isn't.",
]

/** What he says instead when there are wolves at the fence. */
export const WOLF_LINES = [
  "Wolves at the fence. Who's on call?",
  "That's a page, not a PR. Go.",
  "Nobody merges anything until the wolves are gone.",
  "Check the incident channel. Then check it again.",
  "The cows can smell it. So can I.",
  "Don't click me. Click the runbook.",
]

// ---------------------------------------------------------------- wolves

/** A wolf's critter id is its alarm id behind this prefix, so a pick knows which it is. */
export const WOLF_PREFIX = "wolf:"
export const isWolfID = (id: string) => id.startsWith(WOLF_PREFIX)
export const wolfID = (alarmID: string) => WOLF_PREFIX + alarmID
export const alarmIDOf = (wolfID: string) => wolfID.slice(WOLF_PREFIX.length)

/** One wolf per firing page. A critical page is a bigger, darker, faster wolf. */
export function wolfSpec(alarmID: string, severity: AlarmSeverity): Critter {
  const critical = severity === "critical"
  return {
    id: wolfID(alarmID),
    name: critical ? "Wolf" : "Wolf",
    kind: "wolf",
    blurb: critical ? "A big one. Somebody is being paged." : "Prowling the fence. Somebody is being paged.",
    body: critical ? "#33333a" : "#6b665f",
    patch: critical ? "#55535b" : "#a39d94",
    eyes: "#f2c318",
    size: critical ? 1.08 : 0.92,
    ears: "point",
    legs: "regular",
    speed: critical ? 2.6 : 2.0,
    glow: true,
  }
}
