import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");

/**
 * Strictly allowed SPDX licenses per SPEC.md section 3 and AGENTS.md.
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
]);

/**
 * Explicitly banned packages per SPEC.md section 2 & 3 and AGENTS.md.
 */
export const FORBIDDEN_PACKAGE_PATTERNS = [/^tldraw$/i, /^@tldraw\//i];

/**
 * Explicitly banned copyleft and source-available license prefixes per AGENTS.md.
 * Cannot be overridden even via license-exceptions.json.
 */
export const HARD_FORBIDDEN_LICENSE_TOKENS = [
  "GPL",
  "AGPL",
  "LGPL",
  "SSPL",
  "BUSL",
  "BSL-1",
  "COMMONS-CLAUSE",
  "UNLICENSED",
  "PROPRIETARY",
];

export function loadExceptions(exceptionsFilePath) {
  if (!existsSync(exceptionsFilePath)) {
    return new Map();
  }
  const raw = JSON.parse(readFileSync(exceptionsFilePath, "utf8"));
  if (!raw || !Array.isArray(raw.exceptions)) {
    throw new Error(
      `[check-licenses] Некорректный формат ${relative(repoRoot, exceptionsFilePath)}: ожидается объект с массивом "exceptions".`,
    );
  }

  const map = new Map();
  for (const item of raw.exceptions) {
    if (
      !item ||
      typeof item.package !== "string" ||
      item.package.trim() === "" ||
      typeof item.license !== "string" ||
      item.license.trim() === "" ||
      typeof item.reason !== "string" ||
      item.reason.trim().length < 10
    ) {
      throw new Error(
        `[check-licenses] Каждое исключение в license-exceptions.json обязано содержать непустые поля "package", "license" и подробное пояснение "reason" (минимум 10 символов). Найдено: ${JSON.stringify(item)}`,
      );
    }

    const pkgName = item.package.trim();
    if (FORBIDDEN_PACKAGE_PATTERNS.some((re) => re.test(pkgName))) {
      throw new Error(
        `[check-licenses] Пакет "${pkgName}" категорически запрещён правилами проекта (SPEC.md / AGENTS.md) и не может быть добавлен в исключения.`,
      );
    }

    const upperLic = item.license.trim().toUpperCase();
    if (HARD_FORBIDDEN_LICENSE_TOKENS.some((tok) => upperLic.includes(tok))) {
      throw new Error(
        `[check-licenses] Лицензия "${item.license}" для пакета "${pkgName}" относится к запрещённым (GPL/AGPL/SSPL/source-available) и не может быть добавлена в исключения.`,
      );
    }

    map.set(pkgName, {
      license: item.license.trim(),
      reason: item.reason.trim(),
    });
  }
  return map;
}

/**
 * Extracts normalized license string from a package.json object.
 */
export function extractLicenseString(pkgJson) {
  if (typeof pkgJson.license === "string" && pkgJson.license.trim() !== "") {
    return pkgJson.license.trim();
  }
  if (
    pkgJson.license &&
    typeof pkgJson.license === "object" &&
    typeof pkgJson.license.type === "string"
  ) {
    return pkgJson.license.type.trim();
  }
  if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length > 0) {
    const types = pkgJson.licenses
      .map((l) => (typeof l === "string" ? l : l && typeof l.type === "string" ? l.type : ""))
      .filter(Boolean);
    if (types.length > 0) {
      return types.join(" OR ");
    }
  }
  return "UNKNOWN";
}

/**
 * Evaluates a single SPDX license expression (including compound OR / AND expressions)
 * against ALLOWED_LICENSES.
 */
export function isLicenseExpressionAllowed(licenseExpr) {
  if (!licenseExpr || licenseExpr === "UNKNOWN") {
    return false;
  }

  const upper = licenseExpr.toUpperCase();
  if (HARD_FORBIDDEN_LICENSE_TOKENS.some((tok) => upper.includes(tok))) {
    return false;
  }

  const cleaned = licenseExpr.replace(/[()]/g, " ").trim();

  if (/\s+OR\s+/i.test(cleaned)) {
    const branches = cleaned.split(/\s+OR\s+/i).map((part) => part.trim());
    return branches.some((branch) => isLicenseExpressionAllowed(branch));
  }

  if (/\s+AND\s+/i.test(cleaned)) {
    const branches = cleaned.split(/\s+AND\s+/i).map((part) => part.trim());
    return branches.every((branch) => isLicenseExpressionAllowed(branch));
  }

  return ALLOWED_LICENSES.has(cleaned);
}

export function isPackagePermitted(pkgName, licenseStr, exceptionsMap) {
  if (FORBIDDEN_PACKAGE_PATTERNS.some((re) => re.test(pkgName))) {
    return {
      ok: false,
      reason: `Пакет "${pkgName}" явно запрещён спецификацией (SPEC.md раздел 2 и 3, AGENTS.md).`,
    };
  }

  const upper = (licenseStr || "UNKNOWN").toUpperCase();
  if (HARD_FORBIDDEN_LICENSE_TOKENS.some((tok) => upper.includes(tok))) {
    return {
      ok: false,
      reason: `Лицензия "${licenseStr}" запрещена (copyleft / source-available / proprietary не допускаются).`,
    };
  }

  if (isLicenseExpressionAllowed(licenseStr)) {
    return { ok: true };
  }

  const exception = exceptionsMap.get(pkgName);
  if (exception && exception.license === licenseStr) {
    return { ok: true, exceptionReason: exception.reason };
  }

  return {
    ok: false,
    reason: `Лицензия "${licenseStr}" не входит в список разрешённых (${Array.from(ALLOWED_LICENSES).join(", ")}) и не описана в license-exceptions.json.`,
  };
}

function collectNodeModulesPackages(nodeModulesDir, results = []) {
  if (!existsSync(nodeModulesDir)) {
    return results;
  }

  const entries = readdirSync(nodeModulesDir);
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const fullPath = resolve(nodeModulesDir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    if (entry.startsWith("@")) {
      const scopedEntries = readdirSync(fullPath);
      for (const scoped of scopedEntries) {
        if (scoped.startsWith(".")) {
          continue;
        }
        const scopedPath = resolve(fullPath, scoped);
        let scopedStat;
        try {
          scopedStat = statSync(scopedPath);
        } catch {
          continue;
        }
        if (scopedStat.isDirectory()) {
          const pkgJsonPath = resolve(scopedPath, "package.json");
          if (existsSync(pkgJsonPath)) {
            results.push(pkgJsonPath);
          }
          collectNodeModulesPackages(resolve(scopedPath, "node_modules"), results);
        }
      }
    } else {
      const pkgJsonPath = resolve(fullPath, "package.json");
      if (existsSync(pkgJsonPath)) {
        results.push(pkgJsonPath);
      }
      collectNodeModulesPackages(resolve(fullPath, "node_modules"), results);
    }
  }

  return results;
}

export function main() {
  const exceptionsPath = resolve(repoRoot, "license-exceptions.json");
  let exceptionsMap;
  try {
    exceptionsMap = loadExceptions(exceptionsPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const violations = [];
  const checkedPackages = new Map();

  // 1. Check workspace package.json files and their declared dependency names
  const workspacePkgPaths = [
    resolve(repoRoot, "package.json"),
    resolve(repoRoot, "web/package.json"),
    resolve(repoRoot, "worker/package.json"),
  ];

  for (const pkgPath of workspacePkgPaths) {
    if (!existsSync(pkgPath)) {
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
    const relPath = relative(repoRoot, pkgPath);

    if (pkgJson.license) {
      const res = isPackagePermitted(pkgJson.name || relPath, pkgJson.license, exceptionsMap);
      if (!res.ok) {
        violations.push({
          pkg: `${pkgJson.name || relPath}@${pkgJson.version || "0.0.0"}`,
          license: pkgJson.license,
          location: relPath,
          reason: res.reason,
        });
      }
    }

    const depSections = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ];
    for (const section of depSections) {
      const deps = pkgJson[section];
      if (!deps || typeof deps !== "object") {
        continue;
      }
      for (const depName of Object.keys(deps)) {
        if (FORBIDDEN_PACKAGE_PATTERNS.some((re) => re.test(depName))) {
          violations.push({
            pkg: `${depName}@${deps[depName]}`,
            license: "FORBIDDEN_PACKAGE",
            location: `${relPath} (${section})`,
            reason: `Пакет "${depName}" явно запрещён спецификацией (SPEC.md раздел 2 и 3, AGENTS.md).`,
          });
        }
      }
    }
  }

  // 2. Check package-lock.json if present
  const lockfilePath = resolve(repoRoot, "package-lock.json");
  if (existsSync(lockfilePath)) {
    const lockJson = JSON.parse(readFileSync(lockfilePath, "utf8"));
    if (lockJson.packages && typeof lockJson.packages === "object") {
      for (const [pkgLoc, meta] of Object.entries(lockJson.packages)) {
        if (!pkgLoc || !pkgLoc.includes("node_modules/") || meta.link === true) {
          continue;
        }
        const parts = pkgLoc.split("node_modules/");
        const pkgName = parts[parts.length - 1];
        const version = meta.version || "unknown";
        const licenseStr = extractLicenseString(meta);
        checkedPackages.set(`${pkgName}@${version}`, licenseStr);

        const res = isPackagePermitted(pkgName, licenseStr, exceptionsMap);
        if (!res.ok) {
          violations.push({
            pkg: `${pkgName}@${version}`,
            license: licenseStr,
            location: `package-lock.json (${pkgLoc})`,
            reason: res.reason,
          });
        }
      }
    }
  }

  // 3. Check all installed packages in node_modules directories
  const nodeModulesDirs = [
    resolve(repoRoot, "node_modules"),
    resolve(repoRoot, "web/node_modules"),
    resolve(repoRoot, "worker/node_modules"),
  ];

  const installedPkgJsonPaths = [];
  for (const dir of nodeModulesDirs) {
    collectNodeModulesPackages(dir, installedPkgJsonPaths);
  }

  for (const pkgJsonPath of installedPkgJsonPaths) {
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    if (!pkgJson.name) {
      continue;
    }
    const version = pkgJson.version || "unknown";
    const licenseStr = extractLicenseString(pkgJson);
    const relPath = relative(repoRoot, pkgJsonPath);
    checkedPackages.set(`${pkgJson.name}@${version}`, licenseStr);

    const res = isPackagePermitted(pkgJson.name, licenseStr, exceptionsMap);
    if (!res.ok) {
      violations.push({
        pkg: `${pkgJson.name}@${version}`,
        license: licenseStr,
        location: relPath,
        reason: res.reason,
      });
    }
  }

  if (violations.length > 0) {
    console.error("==================================================================");
    console.error("[check-licenses] ОШИБКА ПРОВЕРКИ ЛИЦЕНЗИЙ ЗАВИСИМОСТЕЙ");
    console.error("==================================================================");
    console.error(
      `Разрешённые лицензии: ${Array.from(ALLOWED_LICENSES).join(", ")} (см. SPEC.md раздел 3 и AGENTS.md).`,
    );
    console.error(`Обнаружено нарушений: ${violations.length}\n`);
    for (const v of violations) {
      console.error(`  ✖ Пакет:    ${v.pkg}`);
      console.error(`    Лицензия: ${v.license}`);
      console.error(`    Источник: ${v.location}`);
      console.error(`    Причина:  ${v.reason}\n`);
    }
    console.error(
      'Чтобы исправить: удалите/замените зависимость с запрещённой лицензией или (если это пермиссивная лицензия транзитивного пакета, согласованная с владельцем) добавьте её в license-exceptions.json с обязательным пояснением в поле "reason".',
    );
    process.exit(1);
  }

  console.log(
    `[check-licenses] OK — проверено пакетов: ${checkedPackages.size}, исключений в license-exceptions.json: ${exceptionsMap.size}. Запрещённых лицензий не обнаружено.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
