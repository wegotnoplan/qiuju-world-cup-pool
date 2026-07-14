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
  assert.match(workbench, /未开赛 · 等待对阵/);
  assert.match(workbench, /未开赛 · 对阵已定/);
  assert.match(workbench, /if \(mode === "completed"\) return "完赛"/);
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
  assert.match(workbench, /if \(!ledgerReady\)[\s\S]*?正在读取本地比赛账本/);
  assert.ok(
    workbench.indexOf("if (!ledgerReady)") <
      workbench.indexOf('if (!selectedFixture) return <div className="wb-empty-page">'),
    "seed fixtures must not flash before the persisted ledger arrives",
  );
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

test("completed fixtures keep local history while the provider widget stays on the next fixture", async () => {
  const [workbench, css, stateRoute, syncRoute, schema, progression] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/results/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fixture-progression.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(
    [...workbench.matchAll(/<ApiSportsGameWidget/g)].length,
    1,
    "the provider widget should have one retained instance",
  );
  assert.match(workbench, /ledgerReady && nextFixture &&/);
  assert.match(workbench, /selectedFixture\.id === nextFixture\.id/);
  assert.match(workbench, /hidden=\{!showNextWidget\}/);
  assert.match(workbench, /fixtureId=\{[\s\S]*?nextFixture\.providerMatchId/);
  assert.match(workbench, /!showNextWidget && \([\s\S]*?<LocalMatchCard fixture=\{selectedFixture\}/);
  assert.match(workbench, /data-presentation=\{mode\}/);
  assert.match(workbench, /fixture\.recordStatus === "settled" \? "已结算" : "已锁定"/);
  assert.match(workbench, /fixture\.recordStatus === "settled" && \([\s\S]*?betSettlementLabel\(bet\)/);
  assert.match(workbench, /selectedFixture\.recordStatus === "settled"[\s\S]*?<PoolPodium/);
  assert.match(css, /\.wb-card-body\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.doesNotMatch(
    css,
    /\.wb-fixture-card\.is-readonly[^}]*pointer-events:\s*none/,
    "read-only cards must remain scrollable",
  );

  assert.match(schema, /winnerSide:\s*text\("winner_side"\)/);
  assert.match(stateRoute, /transaction\(async \(tx\)[\s\S]*?winnerSide:\s*currentPlan\.winnerSide/);
  assert.match(syncRoute, /transaction\(async \(tx\)[\s\S]*?winnerSide:\s*currentPlan\.winnerSide/);
  assert.match(syncRoute, /await persistProgression\(db, fixture\.id, winnerSide, now\)/);
  assert.match(syncRoute, /fixture\.winnerSide === null/);
  assert.match(progression, /M101[\s\S]*M102[\s\S]*M103[\s\S]*M104/);
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

test("admin PIN and per-person edit unlock remain server-authorized", async () => {
  const [workbench, stateRoute, syncRoute, schema] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/results/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workbench, /type="password"/);
  assert.match(workbench, /fetch\("\/api\/admin\/session"/);
  assert.doesNotMatch(workbench, /6666/, "the default PIN must not be shipped in client code");
  assert.match(workbench, /set-entry-edit-unlocked/);
  assert.match(workbench, /原注单仍然有效并计入奖池/);

  const guard = stateRoute.indexOf("await hasValidAdminSession(request)");
  const databaseOpen = stateRoute.indexOf("const db = getDb();", guard);
  assert.ok(guard >= 0 && databaseOpen > guard, "admin mutations must authenticate before opening the database");
  assert.match(stateRoute, /db\.transaction/);
  assert.match(syncRoute, /POST\(request: Request\)[\s\S]*hasValidAdminSession/);
  assert.match(schema, /editUnlockedAt:[\s\S]*revision:/);

  const livePoll = workbench.slice(
    workbench.indexOf("async function pollLiveFixture()"),
    workbench.indexOf("if (!toast) return"),
  );
  assert.doesNotMatch(livePoll, /method:\s*"POST"/);
});

test("manual result fallback exposes failures before claiming a local settlement", async () => {
  const [workbench, stateRoute, css] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(workbench, /\bmanualResultHasStarted\b|\bmanualResultIsFinalized\b/);
  assert.match(
    workbench,
    /if \(!managedReviewState\.canSubmit\) \{[\s\S]*?setManualResultError\(managedReviewState\.detail\);[\s\S]*?return;/,
  );
  assert.match(workbench, /managedReviewState\.canSubmit \? \(/);
  assert.match(
    workbench,
    /manualResultError && \([\s\S]*?className="wb-sheet-error wb-manual-result-error" role="alert"/,
    "manual validation and API failures must remain visible inside the score form",
  );
  assert.match(workbench, /setManualResultError\(reason instanceof Error \? reason\.message : "赛果保存失败"\)/);
  assert.match(workbench, /不依赖 API-SPORTS 或 Widget/);
  assert.match(workbench, /setSelectedFixtureId\(settledFixtureId\)/);
  assert.match(workbench, /setSheet\(null\);[\s\S]*?赛果已写入本地账本，金额与排行榜已完成结算/);
  assert.match(css, /\.wb-sheet-error\s*\{/);

  assert.match(
    stateRoute,
    /if \(input\.source === "manual"\) \{[\s\S]*?badRequest\([\s\S]*?半全场玩法/,
  );
  assert.match(stateRoute, /isGradeableOddsSelection\(offer\.marketType, offer\.selectionCode\)/);
});

test("manual knockout entry opens at T+3 and derives the winner from dynamic score fields", async () => {
  const [workbench, stateRoute, appData] = await Promise.all([
    readFile(new URL("../app/components/PoolWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/app-data.ts", import.meta.url), "utf8"),
  ]);

  const editorStart = workbench.indexOf("<h3>人工复核比分</h3>");
  const editorEnd = workbench.indexOf("</section>", editorStart);
  const editor = workbench.slice(editorStart, editorEnd);
  assert.ok(editorStart >= 0 && editorEnd > editorStart, "manual editor should remain visible");

  assert.match(workbench, /isManualReviewOpen\(/);
  for (const field of [
    "afterExtraHome",
    "afterExtraAway",
    "penaltyHome",
    "penaltyAway",
  ]) {
    assert.match(editor, new RegExp(`value=\\{${field}\\}`), `${field} must be rendered`);
  }
  assert.match(
    editor,
    /\{regulationIsDraw && \([\s\S]{0,900}?value=\{afterExtraHome\}/,
    "extra-time fields should appear only after a 90-minute draw",
  );
  assert.match(
    editor,
    /\{regulationIsDraw && afterExtraIsDraw && \([\s\S]{0,900}?value=\{penaltyHome\}/,
    "shoot-out fields should appear only after an extra-time draw",
  );
  assert.doesNotMatch(editor, /<select\b/, "the advancing side must not be selected manually");
  assert.doesNotMatch(workbench, /\bmanualWinnerSide\b/);

  const saveStart = workbench.indexOf("async function saveManualResult()");
  const saveEnd = workbench.indexOf("async function setSelectedEntryUnlocked", saveStart);
  const saveManualResult = workbench.slice(saveStart, saveEnd);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  for (const payloadField of [
    "afterExtraTimeHome",
    "afterExtraTimeAway",
    "penaltyShootoutHome",
    "penaltyShootoutAway",
  ]) {
    assert.match(saveManualResult, new RegExp(`\\b${payloadField}\\b`));
  }
  assert.doesNotMatch(saveManualResult, /\bwinnerSide\s*:/);

  const requestStart = appData.indexOf("export interface ManualResultRequest");
  const requestEnd = appData.indexOf("export type StateMutationRequest", requestStart);
  const requestContract = appData.slice(requestStart, requestEnd);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  assert.match(requestContract, /afterExtraTimeHome\?: number/);
  assert.match(requestContract, /penaltyShootoutHome\?: number/);
  assert.doesNotMatch(requestContract, /winnerSide/);

  const manualRouteStart = stateRoute.indexOf("async function manualResult(");
  const manualRouteEnd = stateRoute.indexOf("export async function GET", manualRouteStart);
  const manualRoute = stateRoute.slice(manualRouteStart, manualRouteEnd);
  assert.ok(manualRouteStart >= 0 && manualRouteEnd > manualRouteStart);
  assert.match(manualRoute, /isManualReviewOpen\(/);
  assert.match(manualRoute, /knockoutResultValidationError\(/);
  assert.match(manualRoute, /winnerSideFromKnockoutScores\(/);
  assert.doesNotMatch(manualRoute, /payload\.winnerSide/);
});

test("local result cards show extra time and bracketed shoot-out scores", async () => {
  const workbench = await readFile(
    new URL("../app/components/PoolWorkbench.tsx", import.meta.url),
    "utf8",
  );
  const localCardStart = workbench.indexOf("function LocalMatchCard(");
  const localCardEnd = workbench.indexOf("function DialogShell(", localCardStart);
  const localCard = workbench.slice(localCardStart, localCardEnd);

  assert.ok(localCardStart >= 0 && localCardEnd > localCardStart);
  assert.match(localCard, /fixture\.afterExtraTimeScore/);
  assert.match(localCard, /fixture\.penaltyShootoutScore/);
  assert.match(localCard, /加时/);
  assert.match(
    localCard,
    /const decidingScore\s*=\s*penalties\s*\?\?\s*afterExtraTime/,
    "shoot-out score should take precedence over the extra-time score",
  );
  assert.match(
    localCard,
    /<small>（\{decidingScore\.home\}\s*:\s*\{decidingScore\.away\}）<\/small>/,
    "the deciding score should be visually subordinate in parentheses",
  );
});

test("backend settlement grades money only from half-time and 90-minute scores", async () => {
  const stateRoute = await readFile(
    new URL("../app/api/state/route.ts", import.meta.url),
    "utf8",
  );
  const settleStart = stateRoute.indexOf("async function settleFixture(");
  const settleEnd = stateRoute.indexOf("async function manualResult(", settleStart);
  const settleFixture = stateRoute.slice(settleStart, settleEnd);
  assert.ok(settleStart >= 0 && settleEnd > settleStart);

  const gradingStart = settleFixture.indexOf("const score =");
  const gradingEnd = settleFixture.indexOf("const unsupported", gradingStart);
  const grading = settleFixture.slice(gradingStart, gradingEnd);
  assert.ok(gradingStart >= 0 && gradingEnd > gradingStart);
  assert.match(
    grading,
    /const score\s*=\s*\{\s*home:\s*input\.regularHome,\s*away:\s*input\.regularAway\s*\}/,
  );
  assert.match(
    grading,
    /gradeSelection\(bet\.marketType, bet\.selectionCode, score, halfTimeScore\)/,
  );
  assert.doesNotMatch(grading, /input\.(?:afterExtraTimeScore|penaltyShootoutScore)/);
  assert.match(settleFixture, /afterExtraTimeScore:\s*input\.afterExtraTimeScore/);
  assert.match(settleFixture, /penaltyShootoutScore:\s*input\.penaltyShootoutScore/);
});

test("result sync retries invalid responses and cools down before due-fixture discovery", async () => {
  const syncRoute = await readFile(
    new URL("../app/api/results/sync/route.ts", import.meta.url),
    "utf8",
  );

  const retrySetStart = syncRoute.indexOf("const RETRYABLE_PROVIDER_STATUSES");
  const retrySetEnd = syncRoute.indexOf("]);", retrySetStart);
  const retrySet = syncRoute.slice(retrySetStart, retrySetEnd);
  assert.ok(retrySetStart >= 0 && retrySetEnd > retrySetStart);
  assert.match(retrySet, /"INVALID_RESPONSE"/);

  const providerStart = syncRoute.indexOf("class ApiFootballProvider");
  const providerEnd = syncRoute.indexOf("async function ensureSeedData", providerStart);
  const provider = syncRoute.slice(providerStart, providerEnd);
  assert.match(
    provider,
    /error instanceof ApiFootballRequestError[\s\S]*?providerStatus:\s*error\.code[\s\S]*?outcome:\s*"waiting"/,
    "malformed upstream responses must remain retryable instead of forcing review",
  );

  const dueLoopStart = syncRoute.indexOf("for (const fixture of dueFixtures)");
  const providerFetch = syncRoute.indexOf(
    "const providerResult = await provider.getMatch(providerMatchId)",
    dueLoopStart,
  );
  const duePreparation = syncRoute.slice(dueLoopStart, providerFetch);
  assert.ok(dueLoopStart >= 0 && providerFetch > dueLoopStart);

  const cooldownGuard = duePreparation.indexOf("isInAutoRetryCooldown");
  const providerIdRead = duePreparation.indexOf("let providerMatchId");
  const providerDiscovery = duePreparation.indexOf("discoverProviderMatchId(fixture)");
  assert.ok(cooldownGuard >= 0, "due fixtures should consult the retry cooldown");
  assert.ok(
    cooldownGuard < providerIdRead && providerIdRead < providerDiscovery,
    "cooldown must short-circuit before reading or discovering a provider match ID",
  );
  assert.match(
    duePreparation.slice(cooldownGuard, providerIdRead),
    /outcome:\s*"cooldown"[\s\S]*?continue;/,
  );

  const retryableDiscovery = duePreparation.indexOf(
    "RETRYABLE_PROVIDER_STATUSES.has(discovery.providerStatus)",
  );
  const permanentReview = duePreparation.indexOf("markReviewRequired(");
  assert.ok(
    retryableDiscovery >= 0 && permanentReview > retryableDiscovery,
    "retryable discovery statuses must take the waiting path before permanent review",
  );
});
