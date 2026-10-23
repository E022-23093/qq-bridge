// 只读 B站 媒体 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 为什么需要它：QQ agent 只有 web-search-safe 的 web_search/web_fetch，而那个 web_fetch
// 只解码文本、不处理 content-encoding，于是：
//   - 弹幕接口（deflate）抓回来是乱码，数不了问号；
//   - 图片只能拿到 URL，模型没有看图能力。
// 本服务补上这两件事：弹幕文本统计、封面图以 image content 返回。
//
// 参数设计：B站 的 view 接口有 wbi 风控（无 cookie 一律 412），拿不到 bvid→cid，
// 所以 bili_popular 直接把 cid 和封面 URL 一起返回；后两个工具按 cid / 封面 URL 收参数。
//
// 安全边界：只读；出站全部走 safe-fetch（禁内网/环回/私有 IP、限制响应大小）；
// 封面 URL 只允许 hdslb.com，不接受任意域名。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { looksLikeImageBuffer } from './safe-fetch.js';
import {
  assertCid,
  coverBuffer,
  danmakuReport,
  popularReport,
  resolveCid,
  videoInfo,
} from './bili-core.js';

const server = new McpServer({ name: 'bili', version: '0.1.0' });

server.tool(
  'bili_popular',
  '取 B站 全站热门视频的紧凑列表：bvid / cid / 发布距今天数 / 弹幕数 / 时长 / 分区 / 标题 / UP主 / 封面URL。默认只保留 5 天内发布的视频。cid 和封面 URL 可直接喂给 bili_danmaku / bili_cover。只读。',
  {
    limit: z.number().int().min(1).max(30).optional().describe('返回条数，默认 12'),
    pn: z.number().int().min(1).max(10).optional().describe('翻页，默认 1；换页可拿不同批次'),
    maxDays: z.number().int().min(1).max(90).optional().describe('只要最近多少天内发布的，默认 5'),
  },
  async ({ limit, pn, maxDays }) => {
    try {
      const text = await popularReport(limit ?? 12, pn ?? 1, maxDays ?? 5);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `取热门失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_video',
  '按 bvid（或完整链接）查一个 B站 视频的标题、UP主、时长、简介摘要、封面URL、cid。用于核实一条链接到底是什么内容（是不是真人、是不是屎）。只读。',
  {
    bvid: z.string().describe('视频 bvid 或完整链接'),
  },
  async ({ bvid }) => {
    try {
      const m = /(BV[0-9A-Za-z]{8,12})/.exec(String(bvid ?? ''));
      if (!m) throw new Error('链接里没有找到 bvid');
      const info = await videoInfo(m[1]);
      const lines = [
        `标题：${info.title || '（未取到）'}`,
        `bvid：${info.bvid} | cid：${info.cid} | 时长：${info.duration}s${info.part ? ` | 分P：${info.part}` : ''}`,
        `简介：${String(info.desc || '').slice(0, 200)}`,
        `封面：${info.pic}`,
        '',
        `链接：https://www.bilibili.com/video/${info.bvid}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_danmaku',
  '读取某个 B站 视频的真实弹幕文本并统计：问号弹幕占比（连续≥2 个问号）、绝望/抽象关键词命中（活到头/人类毁灭/毁灭吧/我不活/科学无法解释 等），返回统计 + 样本弹幕。用来判断这个视频的"屎感"。只读。参数可以是 cid（bili_popular 给的）或 bvid。',
  {
    cid: z.string().describe('视频 cid（纯数字，来自 bili_popular 的 cid=...）或 bvid'),
    sample: z.number().int().min(0).max(40).optional().describe('返回多少条样本弹幕，默认 15'),
  },
  async ({ cid, sample }) => {
    try {
      const resolved = await resolveCid(cid);
      const r = await danmakuReport(assertCid(resolved), sample ?? 15);
      return { content: [{ type: 'text', text: r.text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读弹幕失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_cover',
  '取某个 B站 视频的封面图，直接以图像内容返回给视觉模型（你可以真的"看到"封面），用于判断封面是否离谱/抽象。只读。封面 URL 从 bili_popular 取（只接受 hdslb.com）。',
  {
    pic: z.string().describe('封面图 URL（来自 bili_popular 的「封面：」行，必须是 hdslb.com）'),
  },
  async ({ pic }) => {
    try {
      const { buffer, statusCode } = await coverBuffer(pic);
      if (!looksLikeImageBuffer(buffer)) {
        return { content: [{ type: 'text', text: `封面不是可识别的图片格式（HTTP ${statusCode}）` }], isError: true };
      }
      const mime = buffer[0] === 0x89 ? 'image/png'
        : buffer.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
          : buffer.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
            : 'image/jpeg';
      return {
        content: [
          { type: 'text', text: '封面：' },
          { type: 'image', mimeType: mime, data: buffer.toString('base64') },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `取封面失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
