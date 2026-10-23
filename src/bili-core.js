// B站 只读取数逻辑（与 MCP 传输层解耦，便于直接调用测试）。
//
// 关键约束（实测）：
// - `web-interface/view` 有 wbi 签名风控，无 cookie 一律 412 ⇒ 拿不到"bvid → cid/封面"。
//   因此 cid 与封面 URL 必须从**列表接口**（popular）里带出来，工具参数按 cid / 封面 URL 收，
//   而不是按 bvid 反查。
// - 弹幕接口 `x/v1/dm/list.so` 返回 `content-encoding: deflate`，safe-fetch 不解压 ⇒ 这里自己解。
import zlib from 'node:zlib';
import { safeFetch, safeFetchBuffer, safeFetchBytes } from './safe-fetch.js';

const BILI = 'https://api.bilibili.com';

/** 用户关心的"绝望/问号"类弹幕关键词。 */
export const QUESTION_WORDS = [
  '活到头', '人类毁灭', '毁灭吧', '我不活', '这也行', '科学无法解释',
  '寄了', '完了', '离谱', '逆天', '绷不住',
];

/**
 * 解压 + 转文本。
 *
 * 判定"已经是明文"时要求**以 XML 开头**，而不是只搜 `<d p=`：压缩流（尤其 brotli）
 * 的字节里可能恰好包含这段 ASCII，直接返回就会得到一段乱码前缀 + 后面被截断的内容。
 * 实测 bilibili 目前返回 deflate；这里多一层判断是为了不把"能凑巧解出来"当成成功。
 */
export function decodeMaybeCompressed(buf) {
  const direct = buf.toString('utf8');
  if (/^\uFEFF?\s*(?:<\?xml|<i[\s>])/i.test(direct)) return direct;
  for (const fn of [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync, zlib.brotliDecompressSync]) {
    try {
      const out = fn(buf).toString('utf8');
      if (out.includes('<d p=')) return out;
    } catch { /* 试下一种 */ }
  }
  return direct;
}

export function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function fetchJson(url) {
  const res = await safeFetch(url, 4_000_000);
  const body = String(res.body ?? '').trim();
  if (!body) throw new Error(`空响应（HTTP ${res.statusCode}）`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${res.statusCode}，前 80 字符：${body.slice(0, 80)}）`);
  }
  if (json.code !== 0) throw new Error(`B站接口返回 code=${json.code} ${json.message ?? ''}`.trim());
  return json.data;
}

export function assertCid(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,20}$/.test(s)) throw new Error(`cid 必须是纯数字（从 bili_popular 的 cid= 取）`);
  return s;
}

/** 只允许 hdslb.com 上的 https 图片，避免被当成任意 URL 抓取器。 */
export function assertHdslbUrl(raw) {
  const s = String(raw ?? '').trim();
  let u;
  try { u = new URL(s); } catch { throw new Error('封面 URL 无效'); }
  if (u.protocol === 'http:') u.protocol = 'https:'; // 列表里给的是 http，hdslb 支持 https
  if (u.protocol !== 'https:') throw new Error('封面 URL 必须是 https');
  if (!/(^|\.)hdslb\.com$/i.test(u.hostname)) throw new Error(`只允许 hdslb.com 的图片，收到 ${u.hostname}`);
  return u.toString();
}

/** 热门列表：带 bvid / cid / 发布距今天数 / 封面 URL，并可只保留 N 天内发布的。 */
export async function popularReport(limit = 12, pn = 1, maxDays = 5) {
  // 多取一些再过滤：热门榜里常年混着老视频，按 maxDays 筛完可能不够 limit 条。
  const fetchCount = Math.min(50, Math.max(limit * 3, 20));
  const data = await fetchJson(`${BILI}/x/web-interface/popular?ps=${fetchCount}&pn=${pn}`);
  const list = data.list ?? [];
  const nowSec = Date.now() / 1000;
  const rows = [];
  let stale = 0;
  for (const v of list) {
    const pub = Number(v.pubdate ?? 0);
    const ageDays = pub > 0 ? Math.max(0, (nowSec - pub) / 86400) : Number.POSITIVE_INFINITY;
    if (maxDays > 0 && ageDays > maxDays) { stale++; continue; }
    rows.push({ v, ageDays });
    if (rows.length >= limit) break;
  }
  if (!rows.length) {
    return `本页 ${list.length} 条热门里没有 ${maxDays} 天内发布的视频（已排除 ${stale} 条旧视频）。换 pn（+1）再试，或放宽 maxDays。`;
  }
  const out = rows.map(({ v, ageDays }, i) => {
    const mm = Math.floor((v.duration ?? 0) / 60);
    const ss = String((v.duration ?? 0) % 60).padStart(2, '0');
    const age = Number.isFinite(ageDays) ? `${Math.floor(ageDays)}天前` : '发布时间未知';
    return `${i + 1}. ${v.bvid} | cid=${v.cid} | ${age} | 弹幕${v.stat?.danmaku ?? 0} | ${mm}:${ss} | ${v.tname ?? ''} | ${v.title} | UP:${v.owner?.name ?? ''}\n   封面：${v.pic ?? ''}`;
  });
  if (stale > 0) out.push(`（已按 ${maxDays} 天窗口过滤掉 ${stale} 条旧视频）`);
  return out.join('\n');
}

/**
 * 按 bvid 查视频基础信息。
 *
 * 为什么绕这么远：`web-interface/view` 有 wbi 风控（无 cookie 一律 412），拿不到
 * title/pic/cid。可行组合是：
 *   - cid ← `x/player/pagelist?bvid=`（不设防，返回每个分P 的 cid）；
 *   - 标题/封面/UP ← 视频页 HTML 的 <title>、og:image、og:description。
 */
export async function videoInfo(bvid) {
  const pages = await fetchJson(`${BILI}/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`);
  const first = Array.isArray(pages) ? pages[0] : null;
  if (!first?.cid) throw new Error(`取不到 ${bvid} 的 cid（视频可能已删除或仅会员可见）`);
  // 这里不走 safeFetch：桌面 UA 拿到的页面壳里没有 og 标签，移动 UA 才有。
  // 域名与路径都由本函数拼（bvid 已按 BV 号格式校验），不接受任意 URL。
  const res = await fetch(`https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      referer: 'https://www.bilibili.com/',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const html = (await res.text()).slice(0, 600_000);
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/_哔哩哔哩_bilibili\s*$/i, '').trim();
  const pic = /property="og:image"\s+content="([^"]+)"/i.exec(html)?.[1] ?? '';
  const desc = /property="og:description"\s+content="([^"]+)"/i.exec(html)?.[1] ?? '';
  return {
    bvid,
    cid: String(first.cid),
    part: first.part ?? '',
    duration: Number(first.duration) || 0,
    title,
    pic,
    desc,
  };
}

/** 按 bvid 或 cid 归一成 cid：纯数字当 cid，否则用 pagelist 反查。 */
export async function resolveCid(bvidOrCid) {
  const s = String(bvidOrCid ?? '').trim();
  if (/^\d{1,20}$/.test(s)) return s;
  const m = /(BV[0-9A-Za-z]{8,12})/.exec(s);
  if (!m) throw new Error(`无法识别 bvid/cid：${s || '空'}`);
  const info = await videoInfo(m[1]);
  return info.cid;
}

/** 拉某视频的弹幕文本。 */
export async function loadDanmaku(cid) {
  const res = await safeFetchBytes(`${BILI}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`, 4 * 1024 * 1024);
  const xml = decodeMaybeCompressed(res.buffer);
  if (!xml.includes('<d p=')) throw new Error('弹幕内容无法解析（可能被风控或该视频没有弹幕）');
  return [...xml.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)]
    .map((m) => decodeXmlEntities(m[1]).trim())
    .filter(Boolean);
}

/** 弹幕统计 + 人类可读报告。 */
export async function danmakuReport(cid, sample = 15) {
  const texts = await loadDanmaku(cid);
  if (!texts.length) return { cid, total: 0, text: `cid=${cid} 没有取到弹幕（可能已关闭弹幕或过少）` };

  const qRe = /[?？]{2,}/;
  const qHits = texts.filter((t) => qRe.test(t));
  const kwHits = texts.filter((t) => QUESTION_WORDS.some((k) => t.includes(k)));
  const pct = (x) => `${((x / texts.length) * 100).toFixed(1)}%`;
  const lines = [
    `cid=${cid} 本次采样 ${texts.length} 条弹幕`,
    `问号弹幕（连续≥2 个问号）：${qHits.length} 条，占 ${pct(qHits.length)}`,
    `绝望/抽象关键词命中：${kwHits.length} 条，占 ${pct(kwHits.length)}`,
  ];
  if (kwHits.length) lines.push(`命中样本：${kwHits.slice(0, 6).join(' / ')}`);
  if (sample > 0) {
    const picks = [...new Set([...qHits, ...kwHits, ...texts])].slice(0, sample);
    lines.push('', '样本弹幕：', ...picks.map((t, i) => `${i + 1}. ${t}`));
  }
  return { cid, total: texts.length, qHits: qHits.length, kwHits: kwHits.length, text: lines.join('\n') };
}

/** 封面字节（只允许 hdslb.com）。 */
export async function coverBuffer(picUrl) {
  const url = assertHdslbUrl(picUrl);
  const res = await safeFetchBuffer(url, 6 * 1024 * 1024);
  return { url, buffer: res.buffer, statusCode: res.statusCode };
}
