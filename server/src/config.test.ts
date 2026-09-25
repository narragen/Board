import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ephemeralDataDirWarning, makeConfig } from "./config.ts";

describe("makeConfig defaults", () => {
  test("applies documented defaults when env is empty", () => {
    const config = makeConfig({});
    expect(config.dataDir).toBe(join(homedir(), ".board"));
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7800);
    expect(config.bind).toEqual(["127.0.0.1"]);
  });
});

describe("makeConfig env parsing", () => {
  test("reads every variable", () => {
    const config = makeConfig({
      BOARD_DATA_DIR: "/tmp/board-data",
      BOARD_HOST: "localhost",
      BOARD_PORT: "8000",
      BOARD_BIND: "127.0.0.1,host.docker.internal",
    });
    expect(config.dataDir).toBe("/tmp/board-data");
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(8000);
    expect(config.bind).toEqual(["127.0.0.1", "host.docker.internal"]);
  });

  test("accepts port 0 for an ephemeral binding", () => {
    const config = makeConfig({ BOARD_PORT: "0" });
    expect(config.port).toBe(0);
  });

  test("expands ~ in BOARD_DATA_DIR", () => {
    const config = makeConfig({ BOARD_DATA_DIR: "~/.board-alt" });
    expect(config.dataDir).toBe(join(homedir(), ".board-alt"));
  });

  test("resolves a relative BOARD_DATA_DIR against the working directory", () => {
    const config = makeConfig({ BOARD_DATA_DIR: "data/here" });
    expect(config.dataDir).toBe(join(process.cwd(), "data/here"));
  });

  test("trims, lowercases, and dedupes BOARD_BIND entries", () => {
    const config = makeConfig({
      BOARD_BIND: " HOST.DOCKER.INTERNAL ,127.0.0.1, host.docker.internal ",
    });
    expect(config.bind).toEqual(["host.docker.internal", "127.0.0.1"]);
  });

  test("empty BOARD_BIND keeps the loopback-only default", () => {
    const config = makeConfig({ BOARD_BIND: "" });
    expect(config.bind).toEqual(["127.0.0.1"]);
  });
});

describe("makeConfig rejects bad values", () => {
  test("throws on a non-numeric BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "abc" })).toThrow(/BOARD_PORT/);
  });

  test("throws on a negative BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "-1" })).toThrow(/BOARD_PORT/);
  });

  test("throws on a fractional BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "78.5" })).toThrow(/BOARD_PORT/);
  });

  test("throws on BOARD_PORT above 65535", () => {
    expect(() => makeConfig({ BOARD_PORT: "65536" })).toThrow(/BOARD_PORT/);
  });

  test("throws on an empty BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "" })).toThrow(/BOARD_PORT/);
  });

  test("throws on an empty BOARD_HOST", () => {
    expect(() => makeConfig({ BOARD_HOST: "" })).toThrow(/BOARD_HOST/);
  });

  test("throws on a BOARD_HOST containing whitespace", () => {
    expect(() => makeConfig({ BOARD_HOST: "bad host" })).toThrow(/BOARD_HOST/);
  });

  test("throws on an empty BOARD_DATA_DIR", () => {
    expect(() => makeConfig({ BOARD_DATA_DIR: "" })).toThrow(/BOARD_DATA_DIR/);
  });

  test("throws on an empty BOARD_BIND entry", () => {
    expect(() => makeConfig({ BOARD_BIND: "a,,b" })).toThrow(/BOARD_BIND/);
  });
});

// D23 D3 ratified a persistent mount for the box's data dir and nothing
// enforced it, so a box that skipped the mount silently ran on the container's
// writable layer. These are the three conditions that make the warning true.
describe("ephemeralDataDirWarning", () => {
  const inABox = {
    dataDir: "/home/node/.board",
    inContainer: true,
    dataDirDevice: 56,
    rootDevice: 56,
    tmpDir: "/tmp",
  };

  test("warns when a container's data dir sits on the root filesystem", () => {
    const warning = ephemeralDataDirWarning(inABox);
    expect(warning).toContain("/home/node/.board");
    expect(warning).toContain("disappears when the container is re-created");
    // the fix, not just the diagnosis
    expect(warning).toContain("BOARD_DATA_DIR=/home/node/board");
  });

  test("says nothing on a host — the whole check is container-only", () => {
    expect(
      ephemeralDataDirWarning({ ...inABox, inContainer: false }),
    ).toBeNull();
  });

  // The measurement that makes this a fact rather than a guess: a volume or
  // bind mount is a different device from the container's root.
  test("says nothing when the data dir is on a mount", () => {
    expect(
      ephemeralDataDirWarning({ ...inABox, dataDirDevice: 65025 }),
    ).toBeNull();
  });

  // Every test and `make smoke` runs on a temp data dir, where the warning
  // would be true and useless.
  test("says nothing under the system temp dir", () => {
    expect(
      ephemeralDataDirWarning({ ...inABox, dataDir: "/tmp/board-smoke-aB12" }),
    ).toBeNull();
    // the prefix must be a path boundary, not a string prefix
    expect(
      ephemeralDataDirWarning({ ...inABox, dataDir: "/tmpfoo/.board" }),
    ).not.toBeNull();
  });

  test("says nothing when the device could not be read", () => {
    expect(
      ephemeralDataDirWarning({ ...inABox, dataDirDevice: null }),
    ).toBeNull();
    expect(ephemeralDataDirWarning({ ...inABox, rootDevice: null })).toBeNull();
  });
});
