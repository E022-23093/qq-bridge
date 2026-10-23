// bili-core 的离线单测：不联网、不启动 MCP。
// 覆盖三件最容易改坏的事：cid/封面 URL 的入参校验、弹幕 deflate 解压、XML 实体解码。
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';
import {
  assertCid,
  assertHdslbUrl,
  decodeMaybeCompressed,
  decodeXmlEntities,
} from '../src/bili-core.js';

test('assertCid only accepts plain decimal cid', () => {
  assert.equal(assertCid('123456'), '123456');
  assert.equal(assertCid(' 42 '), '42');
  for (const bad of ['', null, undefined, '12a', '../../etc/passwd', '1.5', '-1', '9'.repeat(21)]) {
    assert.throws(() => assertCid(bad), /cid 必须是纯数字/);
  }
});

test('assertHdslbUrl upgrades http and only allows hdslb.com', () => {
  const upgraded = assertHdslbUrl('http://i0.hdslb.com/bfs/archive/a.jpg');
  assert.ok(upgraded.startsWith('https://i0.hdslb.com/'));
  assert.ok(assertHdslbUrl('https://i1.hdslb.com/bfs/a.png').includes('i1.hdslb.com'));
  // 子域名后缀伪装、非 hdslb、非 http(s) 一律拒绝
  for (const bad of [
    'https://evil-hdslb.com/a.jpg',
    'https://hdslb.com.evil.com/a.jpg',
    'https://example.com/a.jpg',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.throws(() => assertHdslbUrl(bad), /hdslb|封面 URL/);
  }
});

test('decodeMaybeCompressed handles plain / raw-deflate / gzip / brotli', () => {
  const xml = '<?xml version="1.0"?><i><d p="1,2,3">草</d><d p="4">？？</d></i>';
  const buf = Buffer.from(xml, 'utf8');
  assert.equal(decodeMaybeCompressed(buf), xml);
  assert.equal(decodeMaybeCompressed(zlib.deflateRawSync(buf)), xml);
  assert.equal(decodeMaybeCompressed(zlib.deflateSync(buf)), xml);
  assert.equal(decodeMaybeCompressed(zlib.gzipSync(buf)), xml);
  assert.equal(decodeMaybeCompressed(zlib.brotliCompressSync(buf)), xml);
  // 完全解不开时原样返回，交给调用方报「无法解析」
  assert.equal(decodeMaybeCompressed(Buffer.from('not xml')), 'not xml');
});

test('decodeXmlEntities unescapes the five entities used by dm/list.so', () => {
  assert.equal(decodeXmlEntities('a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;'), `a < b & c > d "e" 'f'`);
});
