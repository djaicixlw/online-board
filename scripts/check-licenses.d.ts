export const ALLOWED_LICENSES: Set<string>;
export const FORBIDDEN_PACKAGE_PATTERNS: RegExp[];
export const HARD_FORBIDDEN_LICENSE_TOKENS: string[];

export function loadExceptions(
  exceptionsFilePath: string,
): Map<string, { license: string; reason: string }>;

export function extractLicenseString(pkgJson: Record<string, unknown>): string;
export function isLicenseExpressionAllowed(licenseExpr: string): boolean;
export function isPackagePermitted(
  pkgName: string,
  licenseStr: string,
  exceptionsMap: Map<string, { license: string; reason: string }>,
): { ok: boolean; reason?: string; exceptionReason?: string };
export function main(): void;
