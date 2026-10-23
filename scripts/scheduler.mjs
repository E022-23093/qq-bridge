// 定时调度器（独立进程，配合 start.bat 运行）。
//
// 干两件事：
//   1) 峰谷切角色：高峰时段用短人格卡（傲娇助手，504 字）省输入 token；
//      空闲时段（价格减半）用长人格卡（小鲸鱼）。峰谷判定复用 src/model-prices.js
//      的 isPeakAt()，与「令牌与花费」看板同一口径。
//   2) 每天两个随机时间点触发一次"搬屎"：不再靠主动开口的概率，避免 AI 一有
//      主动机会就去刷 B 站、白烧 token。
//
// 为什么不改 bridge.js：控制台已经提供 /api/role 与 /api/console/notify-ai，
// 外部进程调用即可，桥接本体零改动（出问题停掉这个进程就行）。
//
// 为什么槽位不落盘：state/ 被 harden-state-acl 收紧了权限，外部进程写不进去；
// 改成「按日期做种子的确定性随机」——同一天重启也是同样两个时间点，天然幂等。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPeakAt } from '../src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// 峰 / 谷 使用的人格卡、搬屎与主动开口的时间安排，全部走 config.json 的 `scheduler` 段，
// 这样控制台「调度」页可以直接改，不用改代码。下面是没配置时的默认值。
const DEFAULTS = {
  roles: { enabled: true, peak: '傲娇助手', off: '小鲸鱼' },
  videoShare: { enabled: true, timesPerDay: 2, startMin: 9 * 60, endMin: 23 * 60 + 30, minGapMin: 120 },
  proactiveChat: { enabled: true, timesPerDay: 2, probability: 0.5, minGapMin: 120 }
};
// 允许迟到的宽限：启动晚了超过这个窗口就跳过，避免一启动连补两条。
const SLOT_GRACE_MIN = 10;
// 和搬屎时间点至少隔开 30 分钟，避免同一时刻两条唤醒。
const CHAT_GAP_FROM_VIDEO_MIN = 30;
// 最近 60 分钟内有互动就不主动插话，免得打断正在进行的对话。
const CHAT_SKIP_IF_ACTIVE_MS = 60 * 60 * 1000;

/** 读调度配置（缺省值兜底 + 数值钳制）。 */
function schedCfg() {
  const c = readConfig().scheduler ?? {};
  const roles = { ...DEFAULTS.roles, ...(c.roles ?? {}) };
  const video = { ...DEFAULTS.videoShare, ...(c.videoShare ?? {}) };
  const chat = { ...DEFAULTS.proactiveChat, ...(c.proactiveChat ?? {}) };
  const clampInt = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  return {
    rolesEnabled: roles.enabled !== false,
    peakRole: String(roles.peak || DEFAULTS.roles.peak),
    offRole: String(roles.off || DEFAULTS.roles.off),
    videoEnabled: video.enabled !== false,
    videoCount: clampInt(video.timesPerDay, 0, 6, DEFAULTS.videoShare.timesPerDay),
    chatEnabled: chat.enabled !== false,
    chatCount: clampInt(chat.timesPerDay, 0, 6, DEFAULTS.proactiveChat.timesPerDay),
    chatProbability: Math.min(1, Math.max(0, Number(chat.probability ?? DEFAULTS.proactiveChat.probability))),
    startMin: clampInt(video.startMin, 0, 23 * 60, DEFAULTS.videoShare.startMin),
    endMin: clampInt(video.endMin, 0, 24 * 60, DEFAULTS.videoShare.endMin),
    minGapMin: clampInt(video.minGapMin, 0, 720, DEFAULTS.videoShare.minGapMin),
    chatMinGapMin: clampInt(chat.minGapMin, 0, 720, DEFAULTS.proactiveChat.minGapMin)
  };
}

function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} [scheduler] ${msg}`;
  // 先落盘：无窗口运行时 stdout 可能是关闭的，console.log 会抛错，
  // 所以文件写入必须在前面，且每个位置都单独兜底。
  // state/ 的 ACL 被收紧过（只有当前用户/SYSTEM/管理员），优先写仓库根目录更稳。
  for (const target of [path.join(ROOT, 'scheduler.log'), path.join(ROOT, 'state', 'scheduler.log')]) {
    try { fs.appendFileSync(target, `${line}\n`); break; } catch { /* 试下一个位置 */ }
  }
  try { process.stdout.write(`${line}\n`); } catch { /* 无控制台时忽略 */ }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function consoleToken() {
  const fromCfg = String(readConfig().consoleToken ?? '').trim();
  if (fromCfg) return fromCfg;
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function api(pathname, body) {
  const port = Number(readConfig().consolePort) || 3100;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken() },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(`${pathname} 失败：HTTP ${res.status} ${json?.error ?? ''}`.trim());
  }
  return json;
}

async function apiGet(pathname) {
  const port = Number(readConfig().consolePort) || 3100;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'x-console-token': consoleToken() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${pathname} 失败：HTTP ${res.status}`);
  return res.json();
}

// ── 上下文守护：超过阈值就重置该会话 ────────────────────────────────────────
//
// 为什么需要：QQ 会话的历史会一直累积，而模型每步都要重发全部上下文。
// 实测一个活跃群一小时能从 2 万涨到 34 万 token，每步成本涨 8 倍。
// 这里按账本里"最新一步的输入 token"判断，超阈值就重置会话（下一条消息自动新建）。
// 记忆不受影响：重要信息存在 qq_memory 里，重置后仍可查回。

const lastResetAt = new Map();

async function guardContext() {
  const cfg = readConfig();
  const v2 = cfg.socialV2 ?? {};
  const globalGuard = v2.contextGuard ?? {};
  if (globalGuard.enabled === false) return;
  const perKey = (key) => {
    const ov = v2.conversations?.[key]?.contextGuard;
    return (ov && typeof ov === 'object') ? { ...globalGuard, ...ov } : globalGuard;
  };
  let data;
  try { data = await apiGet('/api/tokens/recent'); } catch { return; }
  const latest = new Map();
  for (const e of data.entries ?? []) {
    const k = String(e?.key ?? '');
    if (!k || k.startsWith('internal:')) continue;
    const tokens = Number(e.tokens);
    if (!Number.isFinite(tokens)) continue;
    const prev = latest.get(k);
    if (!prev || Number(e.time) > Number(prev.time)) latest.set(k, e);
  }
  for (const [key, e] of latest) {
    const g = perKey(key);
    if (g.enabled === false) continue;
    const max = Math.max(10_000, Number(g.maxTokens) || 80_000);
    const cooldown = Math.max(60_000, Number(g.cooldownMs) || 600_000);
    const tokens = Number(e.tokens);
    if (tokens < max) continue;
    if (Date.now() - (lastResetAt.get(key) || 0) < cooldown) continue;
    try {
      await api('/api/session/reset', { key });
      lastResetAt.set(key, Date.now());
      log(`上下文守护：${key} 已到 ${tokens} token（阈值 ${max}），已重置会话`);
    } catch {
      // 会话正忙 / 正在跑回合：下轮再试，别刷日志
    }
  }
}

// ── 1. 峰谷切角色 ───────────────────────────────────────────────────────────

let lastTier = null;
let retryTimer = null;

/** 桥接控制台起来之前，切角色必然 fetch failed —— 先探活，别刷失败日志。 */
async function waitForConsole(maxMs = 300_000) {
  const deadline = Date.now() + maxMs;
  const port = Number(readConfig().consolePort) || 3100;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-console-token': consoleToken() },
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        if (announced) log(`桥接控制台已就绪（:${port}）`);
        return true;
      }
    } catch { /* 还没起来，继续等 */ }
    if (!announced) { log(`等待桥接控制台 :${port} …（桥接可能还没启动）`); announced = true; }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  log(`等待桥接控制台超时（${Math.round(maxMs / 1000)}s）；后续轮询会继续重试`);
  return false;
}

async function syncRole(force = false) {
  const sc = schedCfg();
  if (!sc.rolesEnabled) { lastTier = null; return; }
  const peak = isPeakAt(Date.now());
  if (!force && peak === lastTier) return;
  const role = peak ? sc.peakRole : sc.offRole;
  try {
    await api('/api/role', { role });
    lastTier = peak;
    log(`峰谷：${peak ? '高峰' : '空闲'} → 角色「${role}」`);
  } catch (error) {
    log(`峰谷：切角色失败（${error?.message ?? error}），5s 后重试`);
    // 失败不要等满一分钟：桥接可能刚起来，快速重试。
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; void syncRole(true); }, 5_000);
      retryTimer.unref?.();
    }
  }
}

// ── 2. 每天两个随机时间点 ────────────────────────────────────────────────────

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** FNV-1a：把日期串变成稳定的 32 位种子。 */
function daySeed(day) {
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而稳的确定性伪随机。 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 当天在 [起, 止] 内、且属于"空闲时段"的所有分钟。 */
function offPeakMinutes(date) {
  const sc = schedCfg();
  const out = [];
  for (let m = sc.startMin; m <= sc.endMin; m++) {
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60, 0, 0);
    if (!isPeakAt(at.getTime())) out.push(m);
  }
  return out;
}

/** 从允许的分钟里抽 count 个，彼此至少隔 minGap 分钟。 */
function pickTimes(rnd, allowed, count, minGap) {
  if (!allowed.length || count <= 0) return [];
  if (allowed.length === 1) return [allowed[0]];
  const picked = [];
  for (let i = 0; i < 800 && picked.length < count; i++) {
    const m = allowed[Math.floor(rnd() * allowed.length)];
    if (picked.every((p) => Math.abs(p - m) >= minGap)) picked.push(m);
  }
  // 抽不满就退化为等距取样，保证数量
  if (picked.length < count) {
    for (let i = 0; i < allowed.length && picked.length < count; i++) {
      const m = allowed[Math.floor((i * allowed.length) / count)];
      if (!picked.includes(m)) picked.push(m);
    }
  }
  return picked.sort((a, b) => a - b);
}

/** 当天搬屎的时间点：只在空闲时段里抽（确定性随机，重启不变）。 */
function videoSlotsFor(date) {
  const sc = schedCfg();
  if (!sc.videoEnabled || sc.videoCount <= 0) return [];
  return pickTimes(makeRng(daySeed(localDayKey(date))), offPeakMinutes(date), sc.videoCount, sc.minGapMin);
}

/** 私聊"主动开口"的时间点：另一个种子，同样只在空闲时段，且避开搬屎时间点。 */
function chatSlotsFor(date) {
  const sc = schedCfg();
  if (!sc.chatEnabled || sc.chatCount <= 0) return [];
  const allowed = offPeakMinutes(date);
  const video = videoSlotsFor(date);
  const farEnough = (x) => video.every((v) => Math.abs(x - v) >= CHAT_GAP_FROM_VIDEO_MIN);
  const raw = pickTimes(makeRng(daySeed(`${localDayKey(date)}#chat`)), allowed, sc.chatCount, sc.chatMinGapMin);
  return raw
    .map((m) => {
      if (farEnough(m)) return m;
      // 从 m 往外找最近的合法空闲分钟
      const sorted = allowed.slice().sort((a, b) => Math.abs(a - m) - Math.abs(b - m));
      return sorted.find(farEnough) ?? m;
    })
    .sort((a, b) => a - b);
}

/** 某个时间点这次要不要开口（按日期+时间确定性掷，重启不改结果）。 */
function chatRoll(day, minute) {
  return makeRng(daySeed(`${day}#chat#${minute}`))() < schedCfg().chatProbability;
}

const fired = new Set(); // key: `${day}|${minute}`

async function fireSlot(day, minute) {
  const cfg = readConfig();
  const owner = String(cfg.ownerQQ ?? '').trim();
  if (!owner) { log('未配置 ownerQQ，跳过搬屎'); return; }
  try {
    await api('/api/console/notify-ai', {
      key: `private:${owner}`,
      message: '【定时任务·搬屎】到点了：按老规矩去 B站 找一条 5 天内的二次元抽象整活（AI 调音 / 换声 / "假如 XX 魂穿 XX" / 离谱混剪那类，非真人），确认是屎再发给我；找不到就说"今天没找到"，别硬发、别凑数。',
    });
    fired.add(`${day}|${minute}`);
    log(`已触发搬屎（${fmtMin(minute)}）`);
  } catch (error) {
    log(`搬屎触发失败（${fmtMin(minute)}）：${error?.message ?? error}，下轮重试`);
  }
}

// ── 主循环：一分钟轮询 ─────────────────────────────────────────────────────

/** 读私聊会话状态：用 lastAiReplyAt 判断刚才是不是正在聊。 */
async function privateState(key) {
  try {
    const port = Number(readConfig().consolePort) || 3100;
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/state?key=${encodeURIComponent(key)}`, {
      headers: { 'x-console-token': consoleToken() },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fireChat(day, minute) {
  const owner = String(readConfig().ownerQQ ?? '').trim();
  if (!owner) return;
  const key = `private:${owner}`;

  if (!chatRoll(day, minute)) {
    fired.add(`${day}|chat|${minute}`);
    log(`主动开口机会（${fmtMin(minute)}）：50% 没掷中，跳过（不产生任何回合）`);
    return;
  }

  const st = await privateState(key);
  const lastReply = Number(st?.lastAiReplyAt ?? 0);
  if (lastReply && Date.now() - lastReply < CHAT_SKIP_IF_ACTIVE_MS) {
    fired.add(`${day}|chat|${minute}`);
    log(`主动开口机会（${fmtMin(minute)}）：刚聊过，跳过`);
    return;
  }

  try {
    await api('/api/console/notify-ai', {
      key,
      message: '【主动机会】现在没人找你。主动开个话头找老大聊两句：1~2 句，随你当时想到什么（吐槽、见闻、问他在干嘛都行）；不要客套、不要汇报、不要念设定。',
    });
    fired.add(`${day}|chat|${minute}`);
    log(`已触发主动开口（${fmtMin(minute)}）`);
  } catch (error) {
    log(`主动开口触发失败（${fmtMin(minute)}）：${error?.message ?? error}，下轮重试`);
  }
}

async function tick() {
  try {
    await syncRole();
    await guardContext();
    const now = new Date();
    const day = localDayKey(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const minute of videoSlotsFor(now)) {
      const key = `${day}|${minute}`;
      if (fired.has(key)) continue;
      if (nowMin >= minute && nowMin - minute <= SLOT_GRACE_MIN) await fireSlot(day, minute);
      else if (nowMin - minute > SLOT_GRACE_MIN) fired.add(key); // 错过窗口，今天不再补
    }
    for (const minute of chatSlotsFor(now)) {
      const key = `${day}|chat|${minute}`;
      if (fired.has(key)) continue;
      if (nowMin >= minute && nowMin - minute <= SLOT_GRACE_MIN) await fireChat(day, minute);
      else if (nowMin - minute > SLOT_GRACE_MIN) fired.add(key);
    }
  } catch (error) {
    log(`轮询异常：${error?.message ?? error}`);
  }
}

const bootAt = new Date();
const bootCfg = schedCfg();
log(`启动：峰→${bootCfg.peakRole}，谷→${bootCfg.offRole}${bootCfg.rolesEnabled ? '' : '（峰谷切角色已关闭）'}`);
log(`今日（空闲时段内）搬屎：${videoSlotsFor(bootAt).map(fmtMin).join(' / ') || '（已关闭）'}｜主动开口机会：${chatSlotsFor(bootAt).map(fmtMin).join(' / ') || '（已关闭）'}（每次 ${Math.round(bootCfg.chatProbability * 100)}%）`);
log('时间说明：谷时按 DeepSeek 定价的北京时间判定；上面显示的是本机本地时间（东京 UTC+9，比北京早 1 小时）');

// 单实例互斥：start.bat 每跑一次都会再起一个调度器窗口，不挡住会重复触发搬屎。
// 用本地端口当锁，不依赖文件权限（state/ 的 ACL 被收紧过，外部进程写不进去）。
const mutex = net.createServer();
await new Promise((resolve, reject) => {
  mutex.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      log('已有调度器在运行（端口 3199 被占用），本实例退出');
      process.exit(0);
    }
    reject(error);
  });
  mutex.listen(3199, '127.0.0.1', () => resolve());
});

await waitForConsole();
await tick();
setInterval(tick, 60_000);
