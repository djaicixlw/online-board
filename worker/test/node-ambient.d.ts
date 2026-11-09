declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:crypto" {
  export const webcrypto: Crypto;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};
