import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('deployへdry-runのつもりで渡した未知引数を無視して本番公開しない',()=>{
 const result=spawnSync(process.execPath,['scripts/cloudflare.mjs','deploy','--dry-run'],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/cloudflare:dry-run/);
});
test('未知のCLIサブコマンドを成功として扱わない',()=>{
 const result=spawnSync(process.execPath,['scripts/cloudflare.mjs','deply'],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/不明なコマンド/);
});
test('secretは許可されたキー名以外を拒否する',()=>{
 for(const args of [['secret','FOO_KEY'],['secret'],['secret','OPENAI_API_KEY','extra'],['secret-from-env','.env','FOO_KEY'],['secret-from-env','.env']]){
  const result=spawnSync(process.execPath,['scripts/cloudflare.mjs',...args],{encoding:'utf8'});
  assert.equal(result.status,1,args.join(' '));assert.match(result.stderr,/OPENAI_API_KEY/);
 }
});
