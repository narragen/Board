// Generated token handles: `board token add` with no name mints
// "<color>-<animal>" (e.g. red-armadillo). WHY: the @mention convention
// (docs/feedback-grammar.md, D23 follow-through) makes the token principal an
// agent's addressable handle in comment bodies, so a minted name must be
// memorable enough to type and say aloud — the Google-Docs-style
// anonymous-handle pattern (owner direction, 2026-09-22). Curated in-repo
// lists, no deps and no dictionary randomness: every word is lowercase ASCII
// with no hyphen of its own, chosen to be inoffensive and easy to say — a
// handle is spoken aloud in an invite.
import { getRandomValues } from "node:crypto";
import {
  type CreatedToken,
  TokenNameTaken,
} from "../../../server/src/tokens.ts";

// 32 colors × 64 animals = 2048 combinations — far more than a daemon's token
// population. Both lengths are powers of two, so `% list.length` on a 32-bit
// draw is exactly unbiased (2^32 divides evenly). Exported for the curation
// tests.
export const COLORS: readonly string[] = [
  "amber",
  "azure",
  "beige",
  "blue",
  "coral",
  "crimson",
  "cyan",
  "ebony",
  "gold",
  "gray",
  "green",
  "indigo",
  "ivory",
  "jade",
  "lavender",
  "lime",
  "magenta",
  "maroon",
  "mauve",
  "olive",
  "orange",
  "orchid",
  "plum",
  "red",
  "rose",
  "ruby",
  "rust",
  "saffron",
  "scarlet",
  "teal",
  "violet",
  "white",
];

export const ANIMALS: readonly string[] = [
  "armadillo",
  "badger",
  "bat",
  "beaver",
  "bison",
  "cardinal",
  "cassowary",
  "chinchilla",
  "cormorant",
  "crab",
  "dolphin",
  "dormouse",
  "dragonfly",
  "eagle",
  "ermine",
  "falcon",
  "ferret",
  "finch",
  "fox",
  "gecko",
  "hedgehog",
  "heron",
  "ibex",
  "ibis",
  "jaguar",
  "kingfisher",
  "ladybug",
  "lemur",
  "lynx",
  "manatee",
  "marmot",
  "mink",
  "mole",
  "mongoose",
  "narwhal",
  "newt",
  "octopus",
  "orangutan",
  "orca",
  "otter",
  "owl",
  "pangolin",
  "panther",
  "pelican",
  "penguin",
  "porcupine",
  "puma",
  "quail",
  "quokka",
  "raven",
  "salamander",
  "sloth",
  "snail",
  "sparrow",
  "stoat",
  "swallow",
  "tapir",
  "toucan",
  "turtle",
  "vole",
  "walrus",
  "weasel",
  "wombat",
  "wren",
];

// Bounded mint retries (8): the mint attempt itself is the collision oracle —
// the D17 taken-name error — so there is no inventory pre-fetch to go stale
// and concurrent mints cannot race one. Against 2048 combinations, 8 attempts
// exhaust only under a deliberately adversarial name space; the failure names
// the remedy.
const MAX_MINT_ATTEMPTS = 8;

export class GeneratedNameExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedNameExhausted";
  }
}

function pick(list: readonly string[]): string {
  return list[getRandomValues(new Uint32Array(1))[0] % list.length];
}

export function generatedHandle(previous?: string): string {
  let handle = `${pick(COLORS)}-${pick(ANIMALS)}`;
  // Redraw only on an immediate repeat of the previous attempt (1/2048 per
  // try) — never repeating the last candidate keeps the retry loop honest.
  while (handle === previous) {
    handle = `${pick(COLORS)}-${pick(ANIMALS)}`;
  }
  return handle;
}

// Mint with a generated handle, regenerating on the mint authority's
// taken-name error until a free name lands or the attempt bound is hit. The
// mint error — not a pre-fetched inventory — is the source of truth, so the
// outcome is race-free by construction.
export function mintWithGeneratedName(
  mint: (name: string) => CreatedToken,
): CreatedToken {
  let previous: string | undefined;
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const name = generatedHandle(previous);
    previous = name;
    try {
      return mint(name);
    } catch (err) {
      if (err instanceof TokenNameTaken) {
        continue;
      }
      throw err;
    }
  }
  throw new GeneratedNameExhausted(
    `no free generated handle after ${MAX_MINT_ATTEMPTS} attempts — pass an explicit name instead: board token add <name>`,
  );
}
