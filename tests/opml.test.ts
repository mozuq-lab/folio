import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpml, exportOpml } from '../lib/opml.ts';
const wrap=(body:string)=>`<?xml version="1.0"?><opml version="2.0"><head><title>Subscriptions</title></head><body>${body}</body></opml>`;
test('入れ子folderのカテゴリとRSSメタデータを保持する',()=>{
  const feeds=parseOpml(wrap('<outline text="技術"><outline text="AI"><outline type="rss" text="研究 &amp; 実装" xmlUrl="https://example.com/feed" htmlUrl="https://example.com/blog"/></outline></outline>'));
  assert.equal(feeds.length,1);assert.equal(feeds[0].name,'研究 & 実装');assert.equal(feeds[0].category,'技術 / AI');assert.equal(feeds[0].url,'https://example.com/feed');assert.equal(feeds[0].website,'https://example.com/blog');assert.ok(feeds[0].id);
});
test('URLの表記差を正規化し重複を除外する',()=>{
  const feeds=parseOpml(wrap('<outline xmlUrl="https://EXAMPLE.com:443/feed#one"/><outline xmlUrl="https://example.com/feed#two"/>'));
  assert.equal(feeds.length,1);assert.equal(feeds[0].url,'https://example.com/feed');
});
test('危険URL、DOCTYPE、entity、壊れたXMLとOPML以外を拒否する',()=>{
  for(const url of ['http://example.com/rss','javascript:alert(1)','https://127.0.0.1/rss','https://10.0.0.1/rss','https://[::1]/rss','https://user:pass@example.com/rss','https://localhost/rss','https://example.internal/rss','https://example.com:8443/rss']) assert.throws(()=>parseOpml(wrap(`<outline xmlUrl="${url}"/>`)));
  for(const xml of ['<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+wrap('<outline text="&x;"/>'),'<opml><body>','<rss><channel/></rss>']) assert.throws(()=>parseOpml(xml));
});
test('巨大ファイルと500件を超えるimportを拒否する',()=>{
  assert.throws(()=>parseOpml(wrap(' '.repeat(1024*1024))));
  assert.throws(()=>parseOpml(wrap(Array.from({length:501},(_,i)=>`<outline xmlUrl="https://example.com/${i}"/>`).join(''))));
});
test('特殊文字を含むfeedのexportを再importして内容を保持する',()=>{
  const feeds=parseOpml(wrap('<outline text="技術 &amp; 研究"><outline text="A &quot;B&quot; &lt;C&gt;" xmlUrl="https://example.com/feed?x=1&amp;y=2" htmlUrl="https://example.com/"/></outline>'));
  const xml=exportOpml(feeds);const restored=parseOpml(xml);
  assert.equal(restored[0].name,'A "B" <C>');assert.equal(restored[0].category,'技術 & 研究');assert.equal(restored[0].url,'https://example.com/feed?x=1&y=2');assert.equal(restored[0].website,'https://example.com/');
  assert.equal(parseOpml(exportOpml([])).length,0);
});
