import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoDevAuth } from "../scripts/build-guard.mjs";

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "folio-guard-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

test("ビルド成果物にdev:localが含まれていれば失敗する", () => {
  const dir = fixture({ "ok.js": "export {}", "assets/nested/chunk.mjs": 'const id = "dev:local";' });
  try {
    assert.throws(() => assertNoDevAuth(dir), /dev:local|開発用/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("クリーンな成果物なら失敗しない", () => {
  const dir = fixture({ "index.js": "export {}", "wrangler.json": "{}", "a/b.txt": "dev:local" });
  try {
    assert.doesNotThrow(() => assertNoDevAuth(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
