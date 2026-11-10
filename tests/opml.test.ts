import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpml, parseOpmlDetailed, exportOpml } from '../lib/opml.ts';
import type { Feed } from '../lib/types.ts';
const wrap=(body:string)=>`<?xml version="1.0"?><opml version="2.0"><head><title>Subscriptions</title></head><body>${body}</body></opml>`;
test('入れ子folderのカテゴリとRSSメタデータを保持する',()=>{
  const feeds=parseOpml(wrap('<outline text="技術"><outline text="AI"><outline type="rss" text="研究 &amp; 実装" xmlUrl="https://example.com/feed" htmlUrl="https://example.com/blog"/></outline></outline>'));
  assert.equal(feeds.length,1);assert.equal(feeds[0].name,'研究 & 実装');assert.equal(feeds[0].category,'技術 / AI');assert.equal(feeds[0].url,'https://example.com/feed');assert.equal(feeds[0].website,'https://example.com/blog');assert.ok(feeds[0].id);
});
test('URLの表記差を正規化し重複を除外する',()=>{
  const feeds=parseOpml(wrap('<outline xmlUrl="https://EXAMPLE.com:443/feed#one"/><outline xmlUrl="https://example.com/feed#two"/>'));
  assert.equal(feeds.length,1);assert.equal(feeds[0].url,'https://example.com/feed');
});
test('httpのフィードとサイトURLは読み替えずにそのまま取り込む',()=>{
  const result=parseOpmlDetailed(wrap('<outline text="セキュリティ"><outline type="rss" text="JPCERT" xmlUrl="http://www.jpcert.or.jp/rss/jpcert.rdf" htmlUrl="http://www.jpcert.or.jp/"/></outline><outline xmlUrl="https://example.com/feed"/>'));
  assert.deepEqual(result.feeds.map(f=>f.url),['http://www.jpcert.or.jp/rss/jpcert.rdf','https://example.com/feed']);
  assert.equal(result.feeds[0].website,'http://www.jpcert.or.jp/');assert.equal(result.feeds[0].category,'セキュリティ');
  assert.deepEqual(result.skipped,[]);
  assert.equal(parseOpml(wrap('<outline xmlUrl="http://EXAMPLE.com:80/rss#x"/>'))[0].url,'http://example.com/rss');
});
test('危険・非公開のURLは取り込まず、名前と理由を返して残りを取り込む',()=>{
  const bad=['javascript:alert(1)','https://127.0.0.1/rss','http://10.0.0.1/rss','https://[::1]/rss','https://user:pass@example.com/rss','https://localhost/rss','https://example.internal/rss','https://example.com:8443/rss','http://example.com:8080/rss','ftp://example.com/rss'];
  const result=parseOpmlDetailed(wrap(bad.map((url,i)=>`<outline text="bad${i}" xmlUrl="${url}"/>`).join('')+'<outline text="ok" xmlUrl="https://example.com/ok"/>'));
  assert.deepEqual(result.feeds.map(f=>f.url),['https://example.com/ok']);
  assert.equal(result.skipped.length,bad.length);
  assert.deepEqual(result.skipped[0],{name:'bad0',url:'javascript:alert(1)',reason:'公開されたURLとして読み込めません'});
});
test('DOCTYPE、entity、壊れたXMLとOPML以外はファイル全体を拒否する',()=>{
  for(const xml of ['<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+wrap('<outline text="&x;"/>'),'<opml><body>','<rss><channel/></rss>']) { assert.throws(()=>parseOpml(xml));assert.throws(()=>parseOpmlDetailed(xml)); }
});
test('巨大ファイルは拒否し、500件を超えた分は取り込まずに知らせる',()=>{
  assert.throws(()=>parseOpml(wrap(' '.repeat(1024*1024))));
  const many=parseOpmlDetailed(wrap(Array.from({length:501},(_,i)=>`<outline text="f${i}" xmlUrl="https://example.com/${i}"/>`).join('')));
  assert.equal(many.feeds.length,500);assert.deepEqual(many.skipped,[{name:'f500',url:'https://example.com/500',reason:'一度に取り込めるのは500件までです'}]);
});
test('特殊文字を含むfeedのexportを再importして内容を保持する',()=>{
  const feeds=parseOpml(wrap('<outline text="技術 &amp; 研究"><outline text="A &quot;B&quot; &lt;C&gt;" xmlUrl="https://example.com/feed?x=1&amp;y=2" htmlUrl="https://example.com/"/></outline>'));
  const xml=exportOpml(feeds);const restored=parseOpml(xml);
  assert.equal(restored[0].name,'A "B" <C>');assert.equal(restored[0].category,'技術 & 研究');assert.equal(restored[0].url,'https://example.com/feed?x=1&y=2');assert.equal(restored[0].website,'https://example.com/');
  assert.equal(parseOpml(exportOpml([])).length,0);
});

test('exportOpml: 分類を渡すとその順で書き出し、複数の分類に入ったフィードは各分類に書き、どこにも無いものは未分類にする', () => {
  const f = (id: string) => ({ id, name: id, url: `https://${id}.example/feed`, website: `https://${id}.example`, category: 'x', color: '#000', initial: id }) as Feed;
  const xml = exportOpml([f('a'), f('b'), f('c')], [{ name: '後', feedIds: ['b'] }, { name: '先', feedIds: ['a', 'b'] }]);
  const order = [...xml.matchAll(/<outline (?:text="([^"]+)">|type="rss" text="([^"]+)")/g)].map(m => m[1] ?? m[2]);
  assert.deepEqual(order, ['後', 'b', '先', 'a', 'b', '未分類', 'c']);
  const parsed = parseOpml(xml);
  assert.deepEqual(parsed.map(feed => [feed.name, feed.category]), [['b', '後'], ['a', '先'], ['c', '未分類']]);
});
