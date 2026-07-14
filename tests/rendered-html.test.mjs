import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("production build contains the branded pool application shell", async () => {
  const assetDirectory = new URL("../dist/server/ssr/assets/", import.meta.url);
  const assetName = (await readdir(assetDirectory)).find((name) =>
    name.startsWith("PoolWorkbench-"),
  );
  assert.ok(assetName, "PoolWorkbench SSR asset should be emitted");

  const [asset, layout, page] = await Promise.all([
    readFile(new URL(assetName, assetDirectory), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /<html lang="zh-CN">/i);
  assert.match(page, /球局 · 世界杯奖池/);
  assert.match(asset, /世界杯奖池/);
  assert.match(asset, /左右滑动切换比赛/);
  assert.doesNotMatch(asset, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("starter preview code and dependency are removed", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /PoolWorkbench/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(packageJson, /qiuju-world-cup-pool/);
  assert.doesNotMatch(page, /_sites-preview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
