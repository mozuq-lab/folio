import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CLOUDFLARE_SETTINGS_PATH='.folio/cloudflare.json';
export const UNCONFIGURED_DATABASE_ID='00000000-0000-4000-8000-000000000000';
const keys=['workerName','databaseName','databaseId','accountId','accessTeamDomain','accessAudience','allowedEmails','customDomain'];
const invalid=()=>{throw new Error('Cloudflare設定の項目・名前・ID・URL・メールアドレスを確認してください。秘密値は設定JSONに保存しないでください。');};
/** @param {unknown} value @param {{deployment?:boolean,bootstrap?:boolean}} options */
export function parseCloudflareSettings(value,options={}) {
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();
 const input=/** @type {Record<string,unknown>} */(value);
 if(Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>!(key in input)))invalid();
 if(keys.filter(key=>key!=='allowedEmails').some(key=>typeof input[key]!=='string'))invalid();
 const string=key=>/** @type {string} */(input[key]);
 const workerName=string('workerName'),databaseName=string('databaseName'),databaseId=string('databaseId'),accountId=string('accountId');
 const accessTeamDomain=string('accessTeamDomain'),accessAudience=string('accessAudience'),customDomain=string('customDomain');
 if(!/^[a-z][a-z0-9-]{0,62}$/.test(workerName)||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(databaseName)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId))invalid();
 if(accountId&&!/^[0-9a-f]{32}$/i.test(accountId))invalid();
 if(accessTeamDomain&&!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com\/?$/.test(accessTeamDomain))invalid();
 if(accessAudience&&!/^[A-Za-z0-9_-]{1,256}$/.test(accessAudience))invalid();
 if(customDomain&&!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(customDomain))invalid();
 if(!Array.isArray(input.allowedEmails)||input.allowedEmails.length>20||input.allowedEmails.some(email=>typeof email!=='string'||email.length>254||!/^[^\s@*,<>]+@[^\s@*,<>]+\.[^\s@*,<>]+$/.test(email)))invalid();
 const allowedEmails=[...new Set(input.allowedEmails.map(email=>email.toLowerCase()))];
 if(options.deployment&&(!accountId||databaseId===UNCONFIGURED_DATABASE_ID))throw new Error('本番用accountIdとdatabaseIdを設定してください。');
 if(options.deployment&&!options.bootstrap&&(!accessTeamDomain||!accessAudience||!allowedEmails.length))throw new Error('Cloudflare Accessのteam domain・AUD・許可メールを設定してください。認証設定前の初回配置にはbootstrapを使用できます。');
 return {workerName,databaseName,databaseId,accountId,accessTeamDomain:accessTeamDomain.replace(/\/$/,''),accessAudience,allowedEmails,customDomain};
}
/** @param {{deployment?:boolean,bootstrap?:boolean,required?:boolean}} options */
export function readCloudflareSettings(options={}) {
 const path=resolve(process.env.FOLIO_CLOUDFLARE_CONFIG||CLOUDFLARE_SETTINGS_PATH);
 let value;
 try {value=JSON.parse(readFileSync(path,'utf8'));}
 catch(error) {
  if(error.code!=='ENOENT')throw new Error('Cloudflare設定JSONを読み込めませんでした。');
  if(options.required||options.deployment)throw new Error('npm run cloudflare:init で設定ファイルを作成してください。');
  value=JSON.parse(readFileSync(new URL('../cloudflare.example.json',import.meta.url),'utf8'));
 }
 return parseCloudflareSettings(value,options);
}
/** @param {ReturnType<typeof parseCloudflareSettings>} settings */
export function workerConfiguration(settings) {
 return {
  name:settings.workerName,
  ...(settings.accountId?{account_id:settings.accountId}:{}),
  main:'./worker/index.ts',compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],
  workers_dev:true,preview_urls:false,
  assets:{binding:'ASSETS',run_worker_first:true},
  ai:{binding:'AI'},
  triggers:{crons:['*/5 * * * *']},
  d1_databases:[{binding:'DB',database_name:settings.databaseName,database_id:settings.databaseId,migrations_dir:resolve('drizzle')}],
  vars:{FOLIO_DEPLOYMENT:'self-hosted-cloudflare',FOLIO_ACCESS_TEAM_DOMAIN:settings.accessTeamDomain,FOLIO_ACCESS_AUD:settings.accessAudience,FOLIO_ALLOWED_EMAILS:settings.allowedEmails.join(',')},
  ...(settings.customDomain?{routes:[{pattern:settings.customDomain,custom_domain:true}]}:{}),
 };
}
