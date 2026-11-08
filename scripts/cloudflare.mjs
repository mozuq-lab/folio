import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { configureToolEnvironment } from './tool-environment.mjs';
import { assertNoDevAuth } from './build-guard.mjs';
import { readCloudflareSettings, CLOUDFLARE_SETTINGS_PATH, UNCONFIGURED_DATABASE_ID } from './cloudflare-config.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);configureToolEnvironment(root);
const [command,...args]=process.argv.slice(2);
const settingsPath=resolve(process.env.FOLIO_CLOUDFLARE_CONFIG||CLOUDFLARE_SETTINGS_PATH);
const SECRET_KEYS=['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'];
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
const deploymentPath=resolve('.folio/deploy/wrangler.json');
const runtimePath=resolve('.folio/runtime/wrangler.json');
function save(path,value) {mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function run(script,argv=[],options={}) {
 const result=spawnSync(process.execPath,[script,...argv],{cwd:root,env:process.env,stdio:'inherit',...options});
 if(result.error||result.status!==0)throw new Error('コマンドが完了しませんでした。上のエラーを確認してください。');
 return result;
}
function runtimeConfig(settings) {
 save(runtimePath,{name:settings.workerName,account_id:settings.accountId,compatibility_date:'2026-05-15',main:resolve('worker/index.ts')});
 return runtimePath;
}
function configuredTarget({database=true}={}) {
 const settings=readCloudflareSettings({required:true});
 if(!settings.accountId)throw new Error('設定ファイルのaccountIdに、ご自身のCloudflareアカウントIDを指定してください。');
 if(database&&settings.databaseId===UNCONFIGURED_DATABASE_ID)throw new Error('cloudflare:db:create を実行するか、既存D1のdatabaseIdを設定してください。');
 return settings;
}
function build() {
 run(resolve('scripts/run-framework.mjs'),['build']);
 assertNoDevAuth(resolve('dist/server'));
 const built=JSON.parse(readFileSync('dist/server/wrangler.json','utf8'));
 if(built.vars?.FOLIO_DEPLOYMENT!=='self-hosted-cloudflare'||built.assets?.run_worker_first!==true||built.assets?.binding!=='ASSETS')throw new Error('Cloudflare専用ビルドと認証保護を確認できませんでした。');
 const directory=resolve('dist/server');
 save(deploymentPath,{...built,main:resolve(directory,built.main),assets:{...built.assets,directory:resolve(directory,built.assets.directory)},d1_databases:built.d1_databases.map(db=>({...db,migrations_dir:resolve('drizzle')}))});
 return deploymentPath;
}
function migrations(settings,config) {
 console.log(`D1 migration: ${settings.databaseName} / ${settings.databaseId}`);
 run(wrangler,['d1','migrations','apply','DB','--remote','--config',config]);
}
try {
 const commands=new Set(['init','login','whoami','build','dev','dry-run','db-create','db-migrate','bootstrap','deploy','secret','secret-from-env']);
 if(command&&!commands.has(command))throw new Error('不明なコマンドです。scripts/cloudflare.mjs を引数なしで実行して一覧を確認してください。');
 if(args.length&&!['login','dev','secret','secret-from-env'].includes(command))throw new Error('このコマンドへ追加引数は渡せません。確認のみの場合は npm run cloudflare:dry-run を使用してください。');
 const secretKey=command==='secret'?args[0]:command==='secret-from-env'?args[1]:undefined;
 if((command==='secret'&&args.length!==1)||(command==='secret-from-env'&&args.length!==2)||((command==='secret'||command==='secret-from-env')&&!SECRET_KEYS.includes(secretKey)))throw new Error(`登録できるキーは ${SECRET_KEYS.join('、')} のいずれかです。例: secret <キー名> / secret-from-env <環境ファイル> <キー名>`);
 switch(command) {
  case 'init':
   if(existsSync(settingsPath))console.log(`既存の設定を使用します: ${settingsPath}`);
   else{save(settingsPath,JSON.parse(readFileSync('cloudflare.example.json','utf8')));console.log(`設定ファイルを作成しました: ${settingsPath}`);}
   break;
  case 'login':run(wrangler,['login',...args]);break;
  case 'whoami':run(wrangler,['whoami']);break;
  case 'build':build();break;
  case 'dev':run(resolve('scripts/run-framework.mjs'),['dev',...args]);break;
  case 'dry-run':{const config=build();run(wrangler,['deploy','--dry-run','--config',config,'--outdir',resolve('.folio/dry-run')]);break;}
  case 'db-create':{
   const settings=configuredTarget({database:false});
   if(settings.databaseId!==UNCONFIGURED_DATABASE_ID)throw new Error('databaseIdが設定済みです。既存D1を使用してください。');
   const config=runtimeConfig(settings);
   run(wrangler,['d1','create',settings.databaseName,'--config',config,'--update-config=false']);
   // Read back the newly created resource instead of parsing human-readable output.
   const result=run(wrangler,['d1','list','--json','--config',config],{stdio:['ignore','pipe','inherit'],encoding:'utf8'});
   let database;
   try{database=JSON.parse(result.stdout).find(db=>db.name===settings.databaseName);}catch{/* leave the existing file untouched */}
   if(!database?.uuid)throw new Error('D1は作成済みです。CloudflareのD1一覧でIDを確認し、databaseIdへ設定してください。作成を繰り返さないでください。');
   save(settingsPath,{...settings,databaseId:database.uuid});console.log('作成したD1のIDを設定へ保存しました。');break;
  }
  case 'db-migrate':{const settings=configuredTarget();migrations(settings,build());break;}
  case 'bootstrap':
  case 'deploy':{
   const settings=readCloudflareSettings({deployment:true,bootstrap:command==='bootstrap'});
   console.log(`デプロイ先: ${settings.workerName} / account ${settings.accountId}`);
   if(command==='bootstrap')console.log('初回配置: Access未設定の間はすべてのリクエストを拒否します。');
   const config=build();migrations(settings,config);run(wrangler,['deploy','--config',config]);break;
  }
  case 'secret':{
   const settings=configuredTarget({database:false});
   run(wrangler,['secret','put',secretKey,'--config',runtimeConfig(settings)]);break;
  }
  case 'secret-from-env':{
   const settings=configuredTarget({database:false});
   const file=resolve(args[0]);if(!statSync(file).isFile())throw new Error('環境ファイルを確認してください。');
   const secret=parseEnv(readFileSync(file,'utf8'))[secretKey];
   if(!secret?.trim()||/[\r\n]/.test(secret))throw new Error(`${secretKey}を読み込めませんでした。`);
   run(wrangler,['secret','put',secretKey,'--config',runtimeConfig(settings)],{input:secret+'\n',stdio:['pipe','inherit','inherit']});
   console.log(`${secretKey}をCloudflare Secretに登録しました。値は出力していません。`);break;
  }
  default:console.log('使用方法: node scripts/cloudflare.mjs init|login|whoami|build|dev|dry-run|db-create|db-migrate|bootstrap|deploy|secret <キー名>|secret-from-env <環境ファイル> <キー名>');
 }
}catch(error){console.error(error instanceof Error?error.message:'Cloudflareの操作に失敗しました。');process.exitCode=1;}
