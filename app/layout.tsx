import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata={title:'Folio — あなたの好奇心に、つづきを。',description:'好みを学習するRSSリーダー。気になるメディアをひとつに、あなたにぴったりの記事との出会いを。',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
