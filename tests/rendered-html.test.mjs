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
  assert.match(workbench, /LIVE_SYNC_INTERVAL_MS = 180_000/);
  assert.match(workbench, /fixtureInLiveSyncWindow/);
  assert.match(podium, /本场中奖榜领奖台/);
  assert.match(avatarData, /\/avatars\/gao\.png/);
  assert.deepEqual(
    avatarFiles.filter((name) => name.endsWith(".png")).sort(),
    ["bo.png", "dong.png", "gao.png", "kang.png", "qiu.png", "ye.png", "zhao.png"],
  );
});

test("initial ledger load is not blocked by result synchronization", async () => {
  const workbench = await readFile(
    new URL("../app/components/PoolWorkbench.tsx", import.meta.url),
    "utf8",
  );
  const flowStart = workbench.indexOf("async function loadLedgerThenSyncResults()");
  const flowEnd = workbench.indexOf("async function pollLiveFixture()", flowStart);

  assert.ok(flowStart >= 0 && flowEnd > flowStart, "initial loading flow should be explicit");
  const initialFlow = workbench.slice(flowStart, flowEnd);
  const firstLedgerLoad = initialFlow.indexOf("await refreshState(signal)");
  const resultSync = initialFlow.indexOf('fetch("/api/results/sync"');
  const refreshedLedger = initialFlow.indexOf(
    "await refreshState(signal)",
    firstLedgerLoad + 1,
  );

  assert.ok(firstLedgerLoad >= 0, "persisted ledger should load immediately");
  assert.ok(resultSync > firstLedgerLoad, "result synchronization must start after the first ledger load");
  assert.ok(refreshedLedger > resultSync, "successful synchronization should refresh the ledger once");
  assert.doesNotMatch(initialFlow, /\.then\(\(\) => fetch\("\/api\/state"/);
});

test("fixture snapping and static provider widgets keep their reuse invariants", async () => {
  const [workbench, widget, css] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ApiSportsGameWidget.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--wb-card-width:\s*min\(88vw, 540px\)/);
  assert.match(css, /--wb-track-edge:[^;]*var\(--wb-card-width\)/);
  assert.match(css, /flex:\s*0 0 var\(--wb-card-width\)/);

  const scrollHandler = workbench.slice(
    workbench.indexOf("function handleTrackScroll()"),
    workbench.indexOf("function addDraftParticipant"),
  );
  assert.match(scrollHandler, /window\.setTimeout/);
  assert.ok(
    scrollHandler.indexOf("window.setTimeout") < scrollHandler.indexOf("setSelectedFixtureId"),
    "the selected fixture should change only after scroll settling",
  );

  const reuseGuard = widget.indexOf("retained.fixtureId === fixtureId");
  const providerFetch = widget.indexOf("void fetch(`/api/api-football/fixtures");
  assert.ok(reuseGuard >= 0 && providerFetch > reuseGuard, "a retained widget should bypass the provider preflight");
  assert.match(widget, /retained\?\.phase === "live"/);
  assert.doesNotMatch(
    widget,
    /controller\.abort\(\);\s*host\?\.replaceChildren\(\);/,
    "dependency cleanup should not detach a reusable static widget",
  );
});

test("pool totals expose an accessible per-person contribution sheet", async () => {
  const [workbench, css] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.equal(
    [...workbench.matchAll(/onClick=\{\(\) => setSheet\("pool"\)\}/g)].length,
    2,
    "both pool total and participant count should open the same detail sheet",
  );
  assert.match(workbench, /aria-haspopup="dialog"/);
  assert.match(workbench, /selectedFixture\?\.settlement\?\.poolBeforeCents \?\? carryBefore/);
  assert.match(workbench, /money\(entry\.stakeCents\)[\s\S]*entry\.betCount/);
  assert.match(workbench, /ParticipantAvatar[\s\S]*wb-avatar-pool/);
  assert.match(css, /\.wb-stat-link[\s\S]*min-height:\s*48px/);
  assert.match(css, /\.wb-pool-people/);
});
