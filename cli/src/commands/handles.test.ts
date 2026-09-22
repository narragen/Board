// Generated-handle unit tests: curation invariants + the retry loop with an
// injected mint (the real-mint behavior is covered in token.test.ts).
import { describe, expect, test } from "bun:test";
import { TokenNameTaken } from "../../../server/src/tokens.ts";
import {
  ANIMALS,
  COLORS,
  GeneratedNameExhausted,
  generatedHandle,
  mintWithGeneratedName,
} from "./handles.ts";

// The server (server/src/tokens.ts) enforces name UNIQUENESS only (the
// tokens.name PRIMARY KEY; there is no charset/length rule to satisfy — mint
// is CLI-local-db by design, docs/api.md). The generator holds itself to the
// stricter mention-friendly shape regardless.
const HANDLE_RE = /^[a-z]+-[a-z]+$/;

describe("generatedHandle", () => {
  test("every draw is color-animal, lowercase ASCII, hyphen-joined", () => {
    for (let i = 0; i < 500; i++) {
      const handle = generatedHandle();
      expect(handle).toMatch(HANDLE_RE);
      const [color, animal] = handle.split("-");
      expect(COLORS).toContain(color);
      expect(ANIMALS).toContain(animal);
    }
  });

  test("never repeats the immediately previous handle", () => {
    for (let i = 0; i < 500; i++) {
      expect(generatedHandle("red-armadillo")).not.toBe("red-armadillo");
    }
  });

  test("curation: 32 colors, 64 animals, clean words, no duplicates", () => {
    expect(COLORS).toHaveLength(32);
    expect(ANIMALS).toHaveLength(64);
    for (const list of [COLORS, ANIMALS]) {
      for (const word of list) {
        expect(word).toMatch(/^[a-z]+$/);
        expect(word.length).toBeLessThanOrEqual(10); // longest: chinchilla/orangutan/porcupine/salamander
      }
      expect(new Set(list).size).toBe(list.length); // no accidental duplicates
    }
  });
});

describe("mintWithGeneratedName", () => {
  test("mints on the first try when the name is free", () => {
    const mints: string[] = [];
    const created = mintWithGeneratedName((name) => {
      mints.push(name);
      return { name, token: "t", scopes: [], created_at: "" };
    });
    expect(mints).toEqual([created.name]);
    expect(created.name).toMatch(HANDLE_RE);
  });

  test("retries on TokenNameTaken and never repeats a rejected name consecutively", () => {
    const minted: string[] = [];
    const rejected: string[] = [];
    const created = mintWithGeneratedName((name) => {
      minted.push(name);
      // fail the first two attempts, then let one through
      if (minted.length <= 2) {
        rejected.push(name);
        throw new TokenNameTaken(`a token named "${name}" already exists`);
      }
      return { name, token: "t", scopes: [], created_at: "" };
    });
    expect(minted).toHaveLength(3);
    expect(created.name).toBe(minted[2]);
    expect(created.name).not.toBe(rejected[1]); // no immediate repeat
  });

  test("is honest at exhaustion: 8 attempts, then a remediation error", () => {
    let attempts = 0;
    const fail = (): never => {
      attempts++;
      throw new TokenNameTaken("taken");
    };
    expect(() => mintWithGeneratedName(fail)).toThrow(GeneratedNameExhausted);
    expect(attempts).toBe(8);
    expect(() => mintWithGeneratedName(fail)).toThrow(/pass an explicit name/);
  });

  test("propagates non-collision mint errors", () => {
    expect(() =>
      mintWithGeneratedName(() => {
        throw new Error("db gone");
      }),
    ).toThrow("db gone");
  });
});
