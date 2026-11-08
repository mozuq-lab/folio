import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import { readCloudflareSettings, workerConfiguration } from '../cloudflare-config.mjs';
import { configureToolEnvironment } from '../tool-environment.mjs';

export function selfHostedCloudflareConfig(command:'serve'|'build') {
 configureToolEnvironment(process.cwd());
 const productionConfig=workerConfiguration(readCloudflareSettings());
 return {
  server:{host:'127.0.0.1'},
  plugins:[vinext(),cloudflare({
   viteEnvironment:{name:'rsc',childEnvironments:['ssr']},inspectorPort:false,
   // Vite serves its own virtual modules/CSS in development. The AI binding needs a Cloudflare login, so development omits it too. Production alone
   // routes every static asset through the authentication guard.
   persistState:{path:'.folio/local-state'},config:command==='serve'?{...productionConfig,assets:undefined,ai:undefined}:productionConfig,
  })],
 };
}
