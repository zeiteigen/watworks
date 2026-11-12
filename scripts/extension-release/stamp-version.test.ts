import { expect, test } from "bun:test";
import { buildVersion } from "./stamp-version.js";

test("release builds keep major.minor and use the build number as the patch", () => {
  expect(buildVersion("0.1.0", 7)).toBe("0.1.7");
  expect(buildVersion("2.03.9", 65535)).toBe("2.3.65535");
});

test("invalid bases and build numbers Chrome would reject are refused", () => {
  for (const base of ["0.1", "v0.1.0", "0.1.0-beta"]) expect(() => buildVersion(base, 1)).toThrow();
  for (const build of [0, -1, 1.5, 65536, Number.NaN]) expect(() => buildVersion("0.1.0", build)).toThrow();
});
