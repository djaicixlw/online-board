import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLicenseString,
  isLicenseExpressionAllowed,
  isPackagePermitted,
  loadExceptions,
} from "../../scripts/check-licenses.mjs";

describe("Dependency license checker (scripts/check-licenses.mjs)", () => {
  it("allows MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC and compound OR/AND expressions", () => {
    expect(isLicenseExpressionAllowed("MIT")).toBe(true);
    expect(isLicenseExpressionAllowed("Apache-2.0")).toBe(true);
    expect(isLicenseExpressionAllowed("BSD-2-Clause")).toBe(true);
    expect(isLicenseExpressionAllowed("BSD-3-Clause")).toBe(true);
    expect(isLicenseExpressionAllowed("ISC")).toBe(true);
    expect(isLicenseExpressionAllowed("MIT OR Apache-2.0")).toBe(true);
    expect(isLicenseExpressionAllowed("(MIT AND ISC)")).toBe(true);
  });

  it("rejects copyleft, source-available, and unknown licenses", () => {
    expect(isLicenseExpressionAllowed("GPL-3.0-only")).toBe(false);
    expect(isLicenseExpressionAllowed("AGPL-3.0-or-later")).toBe(false);
    expect(isLicenseExpressionAllowed("SSPL-1.0")).toBe(false);
    expect(isLicenseExpressionAllowed("MPL-2.0")).toBe(false);
    expect(isLicenseExpressionAllowed("UNKNOWN")).toBe(false);
  });

  it("rejects tldraw and @tldraw/* packages regardless of license", () => {
    const emptyExceptions = new Map();
    expect(isPackagePermitted("tldraw", "MIT", emptyExceptions).ok).toBe(false);
    expect(isPackagePermitted("@tldraw/editor", "MIT", emptyExceptions).ok).toBe(false);
  });

  it("loads license-exceptions.json and permits documented transitive exceptions", () => {
    const directPath = resolve(process.cwd(), "license-exceptions.json");
    const exceptionsPath = existsSync(directPath)
      ? directPath
      : resolve(process.cwd(), "../license-exceptions.json");
    const exceptions = loadExceptions(exceptionsPath);
    expect(exceptions.has("tslib")).toBe(true);
    const tslibCheck = isPackagePermitted("tslib", "0BSD", exceptions);
    expect(tslibCheck.ok).toBe(true);
  });

  it("extracts license strings from standard and legacy package.json structures", () => {
    expect(extractLicenseString({ license: "MIT" })).toBe("MIT");
    expect(extractLicenseString({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
    expect(extractLicenseString({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "MIT OR Apache-2.0",
    );
    expect(extractLicenseString({})).toBe("UNKNOWN");
  });
});
