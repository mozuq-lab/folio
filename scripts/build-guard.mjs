import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEV_AUTH_MARKER = "dev:local";
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".json"]);

function* textFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* textFiles(file);
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) yield file;
  }
}

// 開発用の認証（利用者ID dev:local）が本番ビルドに入っていないことを確認する。
export function assertNoDevAuth(directory) {
  for (const file of textFiles(directory)) {
    if (readFileSync(file, "utf8").includes(DEV_AUTH_MARKER)) {
      throw new Error(`ビルド成果物に開発用の認証（${DEV_AUTH_MARKER}）が含まれています: ${path.relative(directory, file)}`);
    }
  }
}
