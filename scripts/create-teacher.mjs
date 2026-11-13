#!/usr/bin/env node
/**
 * scripts/create-teacher.mjs
 * Generates a new teacher account: 22-char base62 ID, crypto token (>= 32 bytes entropy),
 * and prints the SQL command for Cloudflare D1 insertion (token_hash).
 *
 * Usage:
 *   node scripts/create-teacher.mjs --name "Иван Иванович"
 */

import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function generateBase62(length) {
  const chars = [];
  const buf = new Uint8Array(length * 2);
  while (chars.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && chars.length < length; i++) {
      const b = buf[i];
      if (b < 248) {
        chars.push(BASE62[b % 62]);
      }
    }
  }
  return chars.join("");
}

function parseArgs() {
  const args = process.argv.slice(2);
  let name = "Преподаватель";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[i + 1].trim();
      i++;
    }
  }
  return { name };
}

function main() {
  const { name } = parseArgs();
  const id = generateBase62(22);
  // 44 base62 characters provides > 260 bits of cryptographic entropy
  const token = generateBase62(44);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const createdAt = Date.now();

  console.log("===============================================================");
  console.log("🎓 СОЗДАНИЕ УЧЁТНОЙ ЗАПИСИ ПРЕПОДАВАТЕЛЯ (T3)");
  console.log("===============================================================");
  console.log(`Имя: ${name}`);
  console.log(`ID:  ${id}`);
  console.log("\n🔑 СЕКРЕТНЫЙ ТОКЕН ДЛЯ ВХОДА В КАБИНЕТ (СОХРАНИТЕ ЕГО!):");
  console.log(`   ${token}`);
  console.log("\n⚠️  ВНИМАНИЕ: Сам токен нигде на сервере не хранится (только его SHA-256 хеш).");
  console.log(
    "    Если вы потеряете токен, восстановить его будет невозможно — придётся выпустить новый.\n",
  );

  const escapedName = name.replace(/'/g, "''");
  const sql = `INSERT INTO teachers (id, name, token_hash, created_at) VALUES ('${id}', '${escapedName}', '${tokenHash}', ${createdAt});`;

  console.log("---------------------------------------------------------------");
  console.log("Команда для добавления преподавателя на боевой сервер (Cloudflare D1):");
  console.log(`npx wrangler d1 execute online-board-db --remote --command "${sql}"`);
  console.log("\nКоманда для добавления преподавателя локально (wrangler dev):");
  console.log(`npx wrangler d1 execute online-board-db --local --command "${sql}"`);
  console.log("---------------------------------------------------------------\n");
}

main();
