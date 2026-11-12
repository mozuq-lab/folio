import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCloudflareSettings, workerConfiguration } from '../scripts/cloudflare-config.mjs';

const settings={workerName:'folio-personal',databaseName:'folio',databaseId:'12345678-1234-1234-1234-123456789abc',accountId:'a'.repeat(32),accessTeamDomain:'https://reader.cloudflareaccess.com',accessAudience:'b'.repeat(64),allowedEmails:['Owner@example.com'],customDomain:''};
test('Cloudflareの設定を正規化し、DBと全URLの認証を必要とする構成にする',()=>{
 const config=parseCloudflareSettings(settings,{deployment:true});
 assert.deepEqual(config.allowedEmails,['owner@example.com']);
 const worker=workerConfiguration(config);
 assert.equal(worker.name,'folio-personal');assert.equal(worker.main,'./worker/index.ts');
 assert.equal(worker.assets.run_worker_first,true);assert.equal(worker.assets.binding,'ASSETS');
 assert.deepEqual(worker.ai,{binding:'AI'});assert.equal(worker.d1_databases[0].binding,'DB');assert.equal(worker.preview_urls,false);
 assert.equal(worker.vars.FOLIO_ALLOWED_EMAILS,'owner@example.com');
 assert.equal(Object.hasOwn(worker.vars,'OPENAI_API_KEY'),false);
 // console に出した記録（AIの失敗の区分など）だけをWorkers Logsに残し、リクエストごとの記録は残さない。
 assert.deepEqual(worker.observability,{enabled:true,logs:{invocation_logs:false}});
});
test('本番では未設定account/database/Access/メールを拒否し、bootstrapでもaccount/databaseが必要',()=>{
 for(const change of [{accountId:''},{databaseId:'00000000-0000-4000-8000-000000000000'},{accessAudience:''},{accessTeamDomain:''},{allowedEmails:[]}])assert.throws(()=>parseCloudflareSettings({...settings,...change},{deployment:true}));
 assert.doesNotThrow(()=>parseCloudflareSettings({...settings,accessTeamDomain:'',accessAudience:''},{deployment:true,bootstrap:true}));
 assert.throws(()=>parseCloudflareSettings({...settings,accountId:''},{deployment:true,bootstrap:true}));
});
test('設定に秘密値や未知キーを混入させず、名前・ドメイン・メールを検証する',()=>{
 for(const change of [{OPENAI_API_KEY:'test-only'},{workerName:'--delete'},{databaseName:'a;drop table'},{accessTeamDomain:'https://reader.cloudflareaccess.com.evil.test'},{accessTeamDomain:'https://user@reader.cloudflareaccess.com'},{accessTeamDomain:'https://reader.cloudflareaccess.com:443'},{accessTeamDomain:'http://reader.cloudflareaccess.com'},{customDomain:'https://example.com/path'},{allowedEmails:['a@example.com\nb@example.com']}])assert.throws(()=>parseCloudflareSettings({...settings,...change}));
});
test('開発用の未設定値はビルド可能で、通常本番デプロイには使用できない',()=>{
 const initial={...settings,accountId:'',databaseId:'00000000-0000-4000-8000-000000000000',accessTeamDomain:'',accessAudience:'',allowedEmails:[]};
 assert.doesNotThrow(()=>parseCloudflareSettings(initial));
 assert.throws(()=>parseCloudflareSettings(initial,{deployment:true}));
});
test('定期実行のCronを5分ごとに設定する',()=>{
 assert.deepEqual(workerConfiguration(parseCloudflareSettings(settings,{deployment:true})).triggers,{crons:['*/5 * * * *']});
});
