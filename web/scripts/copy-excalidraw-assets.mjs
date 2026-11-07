import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(currentDir, "..");
const repoRoot = resolve(webRoot, "..");

const candidateNodeModules = [
  resolve(webRoot, "node_modules/@excalidraw/excalidraw/dist"),
  resolve(repoRoot, "node_modules/@excalidraw/excalidraw/dist"),
];

const publicDir = resolve(webRoot, "public");
mkdirSync(publicDir, { recursive: true });

for (const distDir of candidateNodeModules) {
  const prodFontsDir = resolve(distDir, "prod/fonts");
  if (existsSync(prodFontsDir)) {
    const targetFontsDir = resolve(publicDir, "fonts");
    mkdirSync(targetFontsDir, { recursive: true });
    cpSync(prodFontsDir, targetFontsDir, { recursive: true });
    console.log(`[web] Copied self-hosted Excalidraw fonts from ${prodFontsDir}`);
    break;
  }

  const legacyAssetsDir = resolve(distDir, "excalidraw-assets");
  if (existsSync(legacyAssetsDir)) {
    const targetAssetsDir = resolve(publicDir, "excalidraw-assets");
    mkdirSync(targetAssetsDir, { recursive: true });
    cpSync(legacyAssetsDir, targetAssetsDir, { recursive: true });
    console.log(`[web] Copied self-hosted Excalidraw assets from ${legacyAssetsDir}`);
    break;
  }
}
