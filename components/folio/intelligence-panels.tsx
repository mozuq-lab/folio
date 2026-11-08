'use client';

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowUpRight, Bookmark, BookOpen, Check, Clock3, Compass, FileText, Layers3, LoaderCircle, MessageSquare, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import type { Article, ReaderState } from '../../lib/types';
import type { AIRequest, AIResult, ArticleNote, DigestResult, IntelligenceState, StoryReport } from '../../lib/intelligence-types';
import { buildReadingPlan, clusterStories, searchLibrary, selectExploration } from '../../lib/discovery';
import './intelligence-panels.css';

export interface FeaturePanelProps {
  reader: ReaderState;
  intelligence: IntelligenceState;
  setIntelligence: Dispatch<SetStateAction<IntelligenceState>>;
  onOpen: (article: Article) => void;
  onSave: (article: Article) => void;
  onFeedback: (article: Article, value: 'like' | 'dislike') => void;
  requestAI: (request: AIRequest) => Promise<AIResult>;
  aiAvailable: boolean;
  aiBusy: boolean;
  aiLabel?: string;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '処理を完了できませんでした。もう一度お試しください。';
function AIStatus({ available, label }: { available: boolean; label?: string }) {
  return <p className="fi-status"><Sparkles size={15} /><span>{available ? 'AI機能はボタンを押したときに実行されます。' : 'AI接続の準備中。記事の整理・閲覧は利用できます。'}</span>{label && <span className="fi-status-model">{label}</span>}</p>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="fi-empty"><BookOpen size={28} /><p>{children}</p></div>;
}
function ErrorNotice({ message }: { message: string }) {
  return message ? <p className="fi-error" role="alert">{message}</p> : null;
}
function SourceButton({ article, onOpen }: { article: Article; onOpen: FeaturePanelProps['onOpen'] }) {
  return <button type="button" className="fi-source" onClick={() => onOpen(article)}><span>{article.sourceName}</span><span>{article.title}</span><ArrowUpRight size={14} /></button>;
}

function DigestContent({ digest, articles, onOpen }: { digest: DigestResult; articles: Article[]; onOpen: FeaturePanelProps['onOpen'] }) {
  return <section className="fi-card fi-digest-result">
    <div className="fi-heading"><span className="fi-badge">{digest.mode === 'ai' ? 'AIによる要約' : '記事概要の抜粋'}</span><span className="fi-meta"><Clock3 size={14} />合計 {digest.totalMinutes} 分</span></div>
    <h2>{digest.title}</h2><p className="fi-copy">{digest.overview}</p>
    <ol className="fi-digest-list">{digest.items.map((item, index) => {
      const article = articles.find(article => article.id === item.articleId);
      return <li key={`${item.articleId}-${index}`}><div className="fi-heading"><span className="fi-number">{String(index + 1).padStart(2, '0')}</span><span className="fi-meta">約{item.minutes}分</span></div>
        <h3>{article?.title ?? 'ライブラリにない記事'}</h3><p className="fi-copy">{item.summary}</p>{item.takeaway && <p className="fi-takeaway">{item.takeaway}</p>}
        {article && <SourceButton article={article} onOpen={onOpen} />}</li>;
    })}</ol>
  </section>;
}

export function DigestView(props: FeaturePanelProps) {
  const { reader, intelligence, setIntelligence, onOpen, requestAI, aiAvailable, aiBusy } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const budget = intelligence.digestMinutes || 5;
  const plan = useMemo(() => buildReadingPlan(reader.articles, budget, reader.read), [reader.articles, reader.read, budget]);
  const unread = reader.articles.filter(article => !reader.read.includes(article.id) && !article.isSample).slice(0, 30);
  async function generate() {
    if (!aiAvailable || aiBusy || pending || !unread.length) return;
    setPending(true); setError('');
    try {
      const result = await requestAI({ action: 'digest', articles: unread, budgetMinutes: budget });
      if (result.kind !== 'digest') throw new Error('読書プランの応答を確認できませんでした。');
      setIntelligence(current => ({ ...current, digest: result.digest }));
    } catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  return <div className="fi-panel">
    <div className="fi-banner"><span className="fi-banner-icon"><Clock3 size={25} /></span><div><span className="fi-eyebrow">A LITTLE TIME, A NEW PERSPECTIVE</span><h2>今日の「読む」を、ひとまとまりに。</h2><p>空いた時間に収まる未読記事を、概要と出典から選べます。</p></div></div>
    <div className="fi-toolbar"><div className="fi-segment" role="group" aria-label="読書プランの時間">{[5, 10, 15].map(minutes => <button key={minutes} type="button" aria-pressed={budget === minutes} onClick={() => setIntelligence(current => ({ ...current, digestMinutes: minutes }))}>{minutes}分</button>)}</div>
      {aiAvailable && <button className="fi-button fi-primary" type="button" disabled={aiBusy || pending || !unread.length} onClick={generate}>{pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{pending ? '要約を作成中…' : 'AIで要約する'}</button>}</div>
    <AIStatus available={aiAvailable} label={props.aiLabel} /><ErrorNotice message={error} />
    {intelligence.digest && <DigestContent digest={intelligence.digest} articles={reader.articles} onOpen={onOpen} />}
    <div className="fi-section-title"><BookOpen size={18} /><h2>すぐに読めるプラン</h2><span>AIを使わず作成</span></div>
    {plan.items.length ? <DigestContent digest={plan} articles={reader.articles} onOpen={onOpen} /> : <Empty>{reader.articles.length ? 'この時間内に読める未読記事がありません。時間を増やすか、新しい記事を取り込んでください。' : 'フィードを追加すると、未読記事から読書プランを作れます。'}</Empty>}
  </div>;
}

function ReportContent({ report, articles, onOpen }: { report: StoryReport; articles: Article[]; onOpen: FeaturePanelProps['onOpen'] }) {
  function citations(ids: string[]) {
    return [...new Set(ids)].map(id => articles.find(article => article.id === id)).filter((article): article is Article => Boolean(article)).map(article => <SourceButton key={article.id} article={article} onOpen={onOpen} />);
  }
  return <div className="fi-report"><span className="fi-badge"><Sparkles size={13} />AIによる比較</span><p className="fi-copy">{report.overview}</p>
    {report.developments.length > 0 && <div><h3>報道の進展</h3>{report.developments.map((development, i) => <div className="fi-report-point" key={i}><p>{development.text}</p>{citations(development.articleIds)}</div>)}</div>}
    {report.perspectives.length > 0 && <div><h3>媒体ごとの視点</h3>{report.perspectives.map((perspective, i) => <div className="fi-report-point" key={i}><strong>{perspective.sourceName}</strong><p>{perspective.point}</p>{citations(perspective.articleIds)}</div>)}</div>}
    {report.uncertainties.length > 0 && <div className="fi-caution"><h3>記事だけでは分からないこと</h3><ul>{report.uncertainties.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
  </div>;
}

export function StoriesView(props: FeaturePanelProps) {
  const { reader, intelligence, setIntelligence, onOpen, requestAI, aiAvailable, aiBusy } = props;
  const [includeSingles, setIncludeSingles] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const clusters = useMemo(() => clusterStories(reader.articles, reader.read), [reader.articles, reader.read]);
  const shown = clusters.filter(cluster => includeSingles || cluster.articles.length > 1);
  async function compare(id: string, articles: Article[]) {
    if (!aiAvailable || aiBusy || pending) return;
    setPending(id); setError('');
    try {
      const selected = articles.slice(0, 30);
      const result = await requestAI({ action: 'compare', articles: selected, readIds: reader.read.filter(id => selected.some(article => article.id === id)) });
      if (result.kind !== 'compare') throw new Error('ニュース比較の応答を確認できませんでした。');
      setIntelligence(current => ({ ...current, storyReports: { ...current.storyReports, [id]: result.report } }));
    } catch (error) { setError(errorMessage(error)); } finally { setPending(null); }
  }
  return <div className="fi-panel"><div className="fi-toolbar"><p className="fi-copy">同じニュースをまとめて、続報や媒体の違いを読み比べる。</p><label className="fi-checkbox"><input type="checkbox" checked={includeSingles} onChange={event => setIncludeSingles(event.target.checked)} />単独の記事も表示</label></div>
    <AIStatus available={aiAvailable} label={props.aiLabel} /><ErrorNotice message={error} />
    {!shown.length && <Empty>{reader.articles.length ? '複数の記事で報じられたニュースはまだありません。単独の記事も表示できます。' : 'フィードを追加すると、同じニュースの記事をここにまとめます。'}</Empty>}
    {shown.map(cluster => <article className="fi-card fi-story" key={cluster.id}><div className="fi-heading"><span className="fi-badge"><Layers3 size={14} />{cluster.articles.length}記事 · {new Set(cluster.articles.map(article => article.sourceId)).size}媒体</span><span className="fi-meta">既読 {cluster.readArticles.length} / 未読 {cluster.unreadArticles.length}</span></div>
      <h2>{cluster.title}</h2>
      {cluster.newCoverage.length > 0 && <div className="fi-coverage"><h3>新着の報道</h3><p className="fi-help">未読記事の見出し・概要の抜粋です。新しい事実の判定ではありません。</p><ul>{cluster.newCoverage.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
      <div className="fi-story-sources">{cluster.articles.map(article => <div key={article.id} className="fi-story-source"><span className={`fi-read-state ${reader.read.includes(article.id) ? 'is-read' : ''}`}>{reader.read.includes(article.id) ? <Check size={13} /> : <span className="fi-unread-dot" />}{reader.read.includes(article.id) ? '既読' : '未読'}</span><SourceButton article={article} onOpen={onOpen} /></div>)}</div>
      {aiAvailable && <button className="fi-button" type="button" disabled={aiBusy || pending !== null} onClick={() => compare(cluster.id, cluster.articles)}>{pending === cluster.id ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{pending === cluster.id ? '報道を比較中…' : 'AIで報道を比較'}</button>}
      {intelligence.storyReports[cluster.id] && <ReportContent report={intelligence.storyReports[cluster.id]} articles={cluster.articles} onOpen={onOpen} />}
    </article>)}
  </div>;
}

function NoteCard({ note, article, onOpen, onUpdate, onDelete }: { note: ArticleNote; article?: Article; onOpen: FeaturePanelProps['onOpen']; onUpdate: (body: string) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(note.body);
  const [editing, setEditing] = useState(false);
  return <article className="fi-card fi-note"><div className="fi-heading"><span className="fi-badge"><FileText size={14} />{note.quote ? 'ハイライトとノート' : 'ノート'}</span><button className="fi-icon-button fi-delete" type="button" aria-label="このノートを削除" onClick={onDelete}><Trash2 size={16} /></button></div>
    {note.quote && <blockquote>{note.quote}</blockquote>}
    {editing ? <form onSubmit={event => { event.preventDefault(); onUpdate(draft); setEditing(false); }}><label className="fi-label" htmlFor={`note-${note.id}`}>メモを編集</label><textarea id={`note-${note.id}`} className="fi-textarea" value={draft} maxLength={10000} onChange={event => setDraft(event.target.value)} rows={4} /><div className="fi-actions"><button className="fi-button fi-primary" type="submit">保存する</button><button className="fi-button" type="button" onClick={() => setEditing(false)}>キャンセル</button></div></form> : <><p className="fi-copy fi-note-body">{note.body || 'メモはまだありません。'}</p><button type="button" className="fi-text-button" onClick={() => { setDraft(note.body); setEditing(true); }}>メモを編集</button></>}
    {article ? <SourceButton article={article} onOpen={onOpen} /> : <p className="fi-help">元の記事は現在のライブラリにありません。ノートは保持されています。</p>}
  </article>;
}

export function NotebookView(props: FeaturePanelProps) {
  const { reader, intelligence, setIntelligence, onOpen, onSave, requestAI, aiAvailable, aiBusy } = props;
  const [tab, setTab] = useState<'saved' | 'notes'>('saved');
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const library = useMemo(() => reader.articles.filter(article => reader.saved.includes(article.id) || intelligence.notes.some(note => note.articleId === article.id)), [reader.articles, reader.saved, intelligence.notes]);
  const found = useMemo(() => query.trim() ? searchLibrary(library, intelligence.notes, query, 200) : library, [library, intelligence.notes, query]);
  const foundIds = new Set(found.map(article => article.id));
  const saved = found.filter(article => reader.saved.includes(article.id));
  const notes = intelligence.notes.filter(note => !query.trim() || foundIds.has(note.articleId) || `${note.body} ${note.quote}`.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase().trim()));
  async function ask() {
    if (!question.trim() || !aiAvailable || aiBusy || pending || !found.length) return;
    const submitted = question.trim();
    const context = found.filter(article => !article.isSample).slice(0, 30);
    if (!context.length) { setError('質問するには、サンプル以外の記事を保存してください。'); return; }
    setPending(true); setError('');
    try {
      const contextIds = new Set(context.map(article => article.id));
      const result = await requestAI({ action: 'ask', articles: context, question: submitted, notes: intelligence.notes.filter(note => contextIds.has(note.articleId)).slice(0, 100) });
      if (result.kind !== 'ask') throw new Error('質問への応答を確認できませんでした。');
      setIntelligence(current => ({ ...current, chats: [{ id: crypto.randomUUID(), question: submitted, result: result.result, createdAt: new Date().toISOString() }, ...current.chats].slice(0, 20) }));
      setQuestion('');
    } catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  return <div className="fi-panel"><label className="fi-search"><Search size={18} /><input aria-label="保存記事とノートを検索" value={query} onChange={event => setQuery(event.target.value)} placeholder="記事・メモ・ハイライトを検索" type="search" /><span>{found.length}記事</span></label>
    <section className="fi-card fi-ask"><div className="fi-section-title"><MessageSquare size={18} /><h2>ライブラリに聞く</h2></div><p className="fi-copy">保存記事とノートを根拠に、出典付きで回答します。検索中は、その結果の最大30記事が対象です。</p><AIStatus available={aiAvailable} label={props.aiLabel} />
      {aiAvailable && <form onSubmit={event => { event.preventDefault(); void ask(); }}><label className="fi-label" htmlFor="fi-library-question">記事についての質問</label><textarea id="fi-library-question" className="fi-textarea" value={question} onChange={event => setQuestion(event.target.value)} placeholder="この記事に共通する論点は？" rows={2} maxLength={2000} /><div className="fi-actions"><span className="fi-help">回答には対象の記事・ノートを使います。</span><button className="fi-button fi-primary" type="submit" disabled={!question.trim() || !found.length || aiBusy || pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{pending ? '出典を確認中…' : '質問する'}</button></div></form>}
      <ErrorNotice message={error} /></section>
    {intelligence.chats.length > 0 && <details className="fi-chat-history" open><summary><MessageSquare size={16} />質問と回答 <span>{intelligence.chats.length}</span></summary>{intelligence.chats.map(chat => <article className="fi-card fi-answer" key={chat.id}><h3>{chat.question}</h3><span className="fi-badge">AIによる回答</span><p className="fi-copy fi-note-body">{chat.result.answer}</p><div className="fi-citations">{chat.result.citations.map((citation, i) => { const article = reader.articles.find(article => article.id === citation.articleId); return <div key={`${citation.articleId}-${i}`}><blockquote>{citation.quote}</blockquote>{article ? <SourceButton article={article} onOpen={onOpen} /> : <p className="fi-help">出典の記事は現在のライブラリにありません。</p>}</div>; })}</div></article>)}</details>}
    <div className="fi-segment fi-notebook-tabs" role="group" aria-label="ライブラリの表示"><button type="button" aria-pressed={tab === 'saved'} onClick={() => setTab('saved')}><Bookmark size={15} />保存記事 {saved.length}</button><button type="button" aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}><FileText size={15} />ノート {notes.length}</button></div>
    {tab === 'saved' ? saved.length ? <div className="fi-library-grid">{saved.map(article => <article className="fi-card fi-library-article" key={article.id}><span className="fi-meta">{article.sourceName} · 約{article.readingMinutes}分</span><button className="fi-title-button" type="button" onClick={() => onOpen(article)}><h3>{article.title}</h3></button><p className="fi-copy">{article.description}</p><div className="fi-actions"><button className="fi-button" type="button" onClick={() => onOpen(article)}>記事を読む<ArrowUpRight size={14} /></button><button className="fi-icon-button is-active" type="button" aria-label={`${article.title}の保存を解除`} onClick={() => onSave(article)}><Bookmark size={17} fill="currentColor" /></button></div></article>)}</div> : <Empty>{query.trim() ? '一致する保存記事がありません。別のキーワードで検索してください。' : '気になった記事を保存すると、ここから読み返せます。'}</Empty> : notes.length ? <div className="fi-note-list">{notes.map(note => <NoteCard key={note.id} note={note} article={reader.articles.find(article => article.id === note.articleId)} onOpen={onOpen} onUpdate={body => setIntelligence(current => ({ ...current, notes: current.notes.map(item => item.id === note.id ? { ...item, body, updatedAt: new Date().toISOString() } : item) }))} onDelete={() => setIntelligence(current => ({ ...current, notes: current.notes.filter(item => item.id !== note.id) }))} />)}</div> : <Empty>{query.trim() ? '一致するノートがありません。別のキーワードで検索してください。' : '記事を開いて、気になった言葉や自分の考えをノートに残せます。'}</Empty>}
  </div>;
}

export function ExploreView(props: FeaturePanelProps) {
  const { reader, intelligence, setIntelligence, onOpen, onSave, onFeedback } = props;
  const articles = useMemo(() => selectExploration(reader.articles, reader.preferences, reader.feedback, 18, reader.read), [reader.articles, reader.preferences, reader.feedback, reader.read]);
  return <div className="fi-panel"><div className="fi-banner"><span className="fi-banner-icon"><Compass size={27} /></span><div><span className="fi-eyebrow">BEYOND YOUR USUAL FEED</span><h2>いつもの関心の、少し外へ。</h2><p>まだ読んでいない分野や、違う媒体の視点に出会うための場所です。</p></div></div>
    <section className="fi-card fi-exploration-setting"><div className="fi-heading"><label className="fi-label" htmlFor="fi-exploration-ratio">おすすめに混ぜる探索記事の割合</label><strong>{intelligence.exploration}%</strong></div><input id="fi-exploration-ratio" type="range" min={0} max={50} step={5} value={intelligence.exploration} onChange={event => setIntelligence(current => ({ ...current, exploration: Number(event.target.value) }))} /><div className="fi-range-labels"><span>いつもの関心を中心に</span><span>新しい分野を多めに</span></div><p className="fi-help">「多様性」は媒体の偏りを調整する設定です。探索は、関心に登録していない分野をおすすめに加えます。</p></section>
    <div className="fi-section-title"><Compass size={18} /><h2>新しい視点を見つける</h2><span>{articles.length}記事</span></div>
    {!articles.length && <Empty>探索できる未読記事がありません。いつもと違う分野のフィードを追加すると、新しい記事に出会えます。</Empty>}
    <div className="fi-library-grid">{articles.map(article => { const novelTags = article.tags.filter(tag => !reader.preferences.interests.includes(tag)); const saved = reader.saved.includes(article.id); return <article className="fi-card fi-explore-article" key={article.id}><span className="fi-meta">{article.sourceName} · 約{article.readingMinutes}分</span><button className="fi-title-button" type="button" onClick={() => onOpen(article)}><h3>{article.title}</h3></button><p className="fi-copy">{article.description}</p><p className="fi-explore-reason"><Compass size={14} />{novelTags.length ? `登録した関心にないタグ：${novelTags.slice(0, 2).join('・')}` : '未読記事から、媒体の偏りを抑えて選びました'}</p><div className="fi-tags">{article.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div><div className="fi-explore-actions"><button className={`fi-button ${reader.feedback[article.id] === 'like' ? 'is-active' : ''}`} type="button" aria-pressed={reader.feedback[article.id] === 'like'} onClick={() => onFeedback(article, 'like')}><ThumbsUp size={15} />興味あり</button><button className="fi-button" type="button" onClick={() => onFeedback(article, 'dislike')}><ThumbsDown size={15} />興味なし</button><button className={`fi-icon-button ${saved ? 'is-active' : ''}`} type="button" aria-label={saved ? '保存を解除' : '記事を保存'} aria-pressed={saved} onClick={() => onSave(article)}><Bookmark size={18} fill={saved ? 'currentColor' : 'none'} /></button></div><SourceButton article={article} onOpen={onOpen} /></article>; })}</div>
  </div>;
}
