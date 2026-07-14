import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("production build contains the branded pool application shell", async () => {
  const [buildId, layout, page, workbench] = await Promise.all([
    readFile(new URL("../.next/BUILD_ID", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
  ]);

  assert.ok(buildId.trim(), "Next.js should emit a production build id");
  await access(new URL("../.next/server/app/page.js", import.meta.url));
  assert.match(layout, /<html lang="zh-CN">/i);
  assert.match(page, /PoolWorkbench/);
  assert.match(workbench, /PoolWorkbench/);
  assert.doesNotMatch(
    workbench,
    /codex-preview|react-loading-skeleton|Your site is taking shape/i,
  );
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

test("pool workbench includes avatar bets, frozen regulation score, and podium UI", async () => {
  const [workbench, podium, avatarData, avatarFiles] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PoolPodium.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/participant-avatars.ts", import.meta.url), "utf8"),
    readdir(new URL("../public/avatars/", import.meta.url)),
  ]);

  assert.match(workbench, /群内结算基准/);
  assert.match(workbench, /下注人[\s\S]*项目[\s\S]*赔率/);
  assert.match(workbench, /不含加时与点球/);
  assert.match(workbench, /等待对阵与赔率/);
  assert.match(podium, /本场中奖榜领奖台/);
  assert.match(avatarData, /\/avatars\/gao\.png/);
  assert.deepEqual(
    avatarFiles.filter((name) => name.endsWith(".png")).sort(),
    ["bo.png", "dong.png", "gao.png", "kang.png", "qiu.png", "ye.png", "zhao.png"],
  );
});
