import type { Metadata } from 'next';
import { themeInitScript } from '@/lib/theme';
import './globals.css';
export const metadata: Metadata={title:'Folio — あなたの好奇心に、つづきを。',description:'好みを学習するRSSリーダー。気になるフィードをひとつに、あなたにぴったりの記事との出会いを。',icons:{icon:'/favicon.svg'}};
// 手動で選んだ配色は、最初の描画の前に <html data-theme> へ反映する（既定の「端末に合わせる」はCSSだけで決まる）。属性はこのスクリプトが付けるので、<html> のハイドレーションの差を許す。
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeInitScript()}}/></head><body>{children}</body></html>;}
