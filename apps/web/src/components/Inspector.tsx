import { useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Braces, Check, ChevronRight, Code2, Copy, ExternalLink, FileCode2, GitCommitHorizontal, LoaderCircle, MessageSquare, MoreHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api, streamChat } from '../lib/api';
import { KIND_META, type CodeNode, type Message, type Model, type Snapshot } from '../lib/types';

type Tab = 'overview' | 'source' | 'ask';
type TokenLine = { content: string; color?: string }[];

function Source({ node, onSelection }: { node: CodeNode; onSelection: (start: number, end: number) => void }) {
  const [tokens, setTokens] = useState<TokenLine[] | null>(null), [start, setStart] = useState<number | null>(null), [end, setEnd] = useState<number | null>(null);
  useEffect(() => {
    let disposed = false; setTokens(null); setStart(null); setEnd(null);
    const lang = node.language === 'TypeScript' ? (node.path.endsWith('tsx') ? 'tsx' : 'typescript') : node.language === 'Go' ? 'go' : node.language === 'JavaScript' ? 'javascript' : node.language === 'Python' ? 'python' : 'text';
    import('shiki').then(({ codeToTokens }) => codeToTokens(node.source, { lang, theme: 'github-dark-default' })).then(result => { if (!disposed) setTokens(result.tokens); }).catch(() => {});
    return () => { disposed = true; };
  }, [node]);
  const lines = tokens || node.source.split('\n').map(content => [{ content, color: '#c6d0d7' }]);
  return <div className="source-view">
    <div className="source-instruction"><FileCode2 size={13} /><span>Click line numbers to select a block.</span></div>
    <div className="source-code">{lines.map((line, i) => {
      const number = node.startLine + i, selected = start !== null && number >= Math.min(start, end ?? start) && number <= Math.max(start, end ?? start);
      return <div key={i} className={`source-line ${selected ? 'line-selected' : ''}`}><button aria-label={`Select line ${number}`} onClick={event => { if (event.shiftKey && start !== null) setEnd(number); else if (start !== null && end === null) setEnd(number); else { setStart(number); setEnd(null); } }}>{number}</button><code>{line.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content || ' '}</span>)}</code></div>;
    })}</div>
    {start !== null && <div className="source-selection"><span>Lines {Math.min(start, end ?? start)}–{Math.max(start, end ?? start)}</span><button className="button primary compact" onClick={() => onSelection(Math.min(start, end ?? start), Math.max(start, end ?? start))}>Ask about this <ArrowRight size={13} /></button></div>}
  </div>;
}

export function Inspector({ snapshot, node, model, onSelect, onClose, onError }: { snapshot: Snapshot; node: CodeNode; model?: Model; onSelect: (id: string) => void; onClose: () => void; onError: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview'), [question, setQuestion] = useState(''), [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [copied, setCopied] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const controller = useRef<AbortController | null>(null), subject = useRef(''), scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const key = `${snapshot.id}:${node.id}`;
  subject.current = key;
  const related = snapshot.graph.edges.filter(edge => edge.kind !== 'contains' && (edge.source === node.id || edge.target === node.id));
  const outgoing = related.filter(e => e.source === node.id), incoming = related.filter(e => e.target === node.id);
  const children = snapshot.graph.nodes.filter(n => n.parentId === node.id);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setMessages([]); setSelection(null); setQuestion(''); setBusy(false);
    api<Message[]>(`/conversations?snapshotId=${encodeURIComponent(snapshot.id)}&nodeId=${encodeURIComponent(node.id)}`, { signal: abort.signal }).then(setMessages).catch(error => { if (error.name !== 'AbortError') onError(error.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [key]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' }); }, [messages, busy, tab]);
  async function ask(text: string) {
    if (!text.trim() || busy || !model || loading) return;
    setTab('ask'); setQuestion(''); setBusy(true);
    const current = key, optimistic = crypto.randomUUID(), responseId = crypto.randomUUID();
    const userMessage: Message = { id: optimistic, role: 'user', content: text.trim(), createdAt: new Date().toISOString() };
    setMessages(previous => [...previous, userMessage, { id: responseId, role: 'assistant', content: '', modelId: model.id, createdAt: new Date().toISOString(), status: 'streaming' }]);
    const abort = new AbortController(); controller.current = abort;
    let received = false;
    try {
      await streamChat({ snapshotId: snapshot.id, nodeId: node.id, modelId: model.id, message: text.trim(), ...(selection ? { startLine: selection.start, endLine: selection.end } : {}) }, abort.signal, {
        meta: value => { received = true; if (subject.current === current) setMessages(previous => previous.map(message => message.id === optimistic ? value.userMessage : message.id === responseId ? { ...message, sources: value.sources } : message)); },
        delta: chunk => { if (subject.current === current) setMessages(previous => previous.map(message => message.id === responseId ? { ...message, content: message.content + chunk } : message)); },
        done: value => { if (subject.current === current) setMessages(previous => previous.map(message => message.id === responseId ? value : message)); },
      });
    } catch (error) {
      if (subject.current === current) {
        if ((error as Error).name !== 'AbortError') onError((error as Error).message);
        if (!received) { setMessages(previous => previous.filter(message => message.id !== optimistic && message.id !== responseId)); setQuestion(text); }
        else setMessages(previous => previous.map(message => message.id === responseId ? { ...message, status: abort.signal.aborted ? 'cancelled' : 'failed' } : message));
      }
    } finally { if (subject.current === current) { setBusy(false); setSelection(null); } }
  }
  async function clear() {
    try { await api(`/conversations?snapshotId=${snapshot.id}&nodeId=${node.id}`, { method: 'DELETE' }); setMessages([]); } catch (error) { onError((error as Error).message); }
  }
  async function copy() { try { await navigator.clipboard.writeText(node.source || node.signature); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { onError('Clipboard access is unavailable in this browser.'); } }
  function relationship(edge: typeof related[number], isOutgoing: boolean) {
    const target = snapshot.graph.nodes.find(n => n.id === (isOutgoing ? edge.target : edge.source)); if (!target) return null;
    return <button key={edge.id} className="relationship-row" onClick={() => onSelect(target.id)}><span className="symbol-kind" style={{ color: KIND_META[target.kind].color }}>{KIND_META[target.kind].short}</span><span><strong>{target.name}</strong><small>{target.path}</small></span><span className="relationship-label">{edge.kind}</span><ChevronRight size={13} /></button>;
  }
  return <aside className="inspector">
    <div className="inspector-top"><span className="eyebrow">NODE INSPECTOR</span><div><button className="icon-button" title="Copy source" aria-label="Copy source" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}</button><button className="icon-button" aria-label="Close inspector" onClick={onClose}><X size={16} /></button></div></div>
    <div className="node-heading"><div className="node-type-badges"><span className="node-kind-badge" style={{ color: KIND_META[node.kind].color }}><span>{KIND_META[node.kind].short}</span>{KIND_META[node.kind].label}</span>{node.entry && <span className="entry-badge"><span className="entry-dot" />Entry point</span>}</div><h2 title={node.name}>{node.name}<span>{node.kind === 'function' || node.kind === 'method' ? '()' : ''}</span></h2><button className="node-location" onClick={() => setTab('source')}><FileCode2 size={13} /><span>{node.path || snapshot.repository.name}</span>{node.startLine > 0 && <span>:{node.startLine}</span>}<ArrowUpRight size={12} /></button></div>
    <div className="inspector-tabs" role="tablist"><button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><Braces size={14} />Overview</button><button role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}><Code2 size={14} />Source</button><button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'active' : ''} onClick={() => setTab('ask')}><MessageSquare size={14} />Ask{messages.length > 0 && <span className="tab-count">{messages.filter(m => m.role === 'user').length}</span>}</button></div>
    <div className="inspector-body" ref={scroll}>
      {tab === 'overview' && <div className="overview">
        <div className="overview-summary"><span className="section-label">WHAT IT DOES</span><p>{node.description}</p></div>
        {node.signature && <div className="signature"><code>{node.signature}</code></div>}
        <div className="node-stats"><div><span>{outgoing.length}</span><small>Outgoing</small></div><div><span>{incoming.length}</span><small>Incoming</small></div><div><span>{Math.max(0, node.endLine - node.startLine + 1)}</span><small>Lines of code</small></div></div>
        {outgoing.length > 0 && <div className="relationships"><div className="section-label"><ArrowUpRight size={13} />CONNECTS TO<span>{outgoing.length}</span></div>{outgoing.map(edge => relationship(edge, true))}</div>}
        {incoming.length > 0 && <div className="relationships"><div className="section-label"><ArrowDown size={13} />REFERENCED BY<span>{incoming.length}</span></div>{incoming.map(edge => relationship(edge, false))}</div>}
        {children.length > 0 && <div className="relationships"><div className="section-label">CONTAINS<span>{children.length}</span></div>{children.slice(0, 15).map(child => <button key={child.id} className="relationship-row" onClick={() => onSelect(child.id)}><span className="symbol-kind" style={{ color: KIND_META[child.kind].color }}>{KIND_META[child.kind].short}</span><span><strong>{child.name}</strong><small>{KIND_META[child.kind].label}</small></span><ChevronRight size={13} /></button>)}</div>}
        <div className="ask-invitation"><span className="ask-icon"><Sparkles size={18} /></span><h3>Go beyond the surface.</h3><p>Ask a question about this {KIND_META[node.kind].label.toLowerCase()}. The context is already here.</p>{['Explain how this works', 'Trace its dependencies', 'What could go wrong?'].map(prompt => <button key={prompt} onClick={() => ask(prompt)} disabled={busy || loading}>{prompt}<ArrowUpRight size={13} /></button>)}</div>
      </div>}
      {tab === 'source' && (node.source ? <Source node={node} onSelection={(start, end) => { setSelection({ start, end }); setTab('ask'); setTimeout(() => input.current?.focus(), 0); }} /> : <div className="empty-panel"><FolderIcon /><h3>A bird’s-eye view.</h3><p>Select a file or symbol to inspect its source.</p></div>)}
      {tab === 'ask' && <div className="chat-content">
        {loading ? <div className="chat-loading"><LoaderCircle className="spin" size={18} />Loading this node’s conversation…</div> : messages.length === 0 ? <div className="chat-welcome"><span className="chat-welcome-icon"><Sparkles size={24} /></span><h3>A question worth asking.</h3><p>Explore <strong>{node.name}</strong> with {model?.name || 'your selected model'}. This conversation stays with this node.</p>{['Explain this in plain English', 'How does this fit into the codebase?', 'What are the important edge cases?'].map(prompt => <button key={prompt} onClick={() => ask(prompt)}>{prompt}<ArrowRight size={14} /></button>)}</div> : messages.map(message => <div key={message.id} className={`message ${message.role}`}><div className="message-byline">{message.role === 'assistant' ? <><span className="assistant-avatar"><Sparkles size={12} /></span>{message.modelId === 'local-guide' ? 'Source guide' : 'CodeTree'}{message.status === 'streaming' && <LoaderCircle size={12} className="spin" />}</> : <><span className="user-avatar">Y</span>You</>}</div><div className="markdown"><Markdown skipHtml>{message.content || (message.status === 'streaming' ? 'Finding the connections…' : 'No response content.')}</Markdown></div>{message.status && !['complete', 'streaming'].includes(message.status) && <div className="message-status">Response {message.status}.</div>}{message.role === 'assistant' && message.sources?.length ? <details className="message-sources"><summary>{message.sources.length} source{message.sources.length === 1 ? '' : 's'} in context<ChevronRight size={12} /></summary>{message.sources.map(source => <button key={source.nodeId} onClick={() => { onSelect(source.nodeId); setTab('source'); }}><FileCode2 size={12} /><span>{source.path}:{source.startLine}</span><ArrowUpRight size={12} /></button>)}</details> : null}</div>)}
      </div>}
    </div>
    {tab === 'ask' ? <div className="chat-composer-area">{selection && <div className="context-selection"><Code2 size={13} />Selected lines {selection.start}–{selection.end}<button className="icon-button" aria-label="Clear source selection" onClick={() => setSelection(null)}><X size={12} /></button></div>}<form className="chat-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); ask(question); }}><textarea ref={input} aria-label="Ask about this node" placeholder={`Ask about ${node.name}…`} value={question} onChange={event => setQuestion(event.target.value)} maxLength={6000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(question); } }} rows={2} /><div className="composer-footer"><span><span className="context-dot" />Node context attached</span>{busy ? <button className="send-button stop-button" type="button" aria-label="Stop response" onClick={() => controller.current?.abort()}><Square size={13} fill="currentColor" /></button> : <button className="send-button" aria-label="Send question" disabled={!question.trim() || !model || loading}><ArrowUp size={17} /></button>}</div></form><div className="chat-disclaimer"><span>{model?.provider === 'local' ? 'Local analysis · connect a model for AI reasoning' : `${model?.name || 'Choose a model'} · verify explanations against source`}</span>{messages.length > 0 && <button aria-label="Clear node conversation" title="Clear node conversation" disabled={busy} onClick={clear}><Trash2 size={12} /></button>}</div></div> : <button className="inspector-ask-button" onClick={() => { setTab('ask'); setTimeout(() => input.current?.focus(), 0); }}><Sparkles size={15} />Ask about this {node.kind === 'repository' ? 'repository' : 'node'}<span>↵</span></button>}
    <div className="inspector-snapshot"><GitCommitHorizontal size={12} /><span>{snapshot.repository.commit.slice(0, 7)}</span><span>·</span><span>{node.language}</span>{snapshot.repository.url && <a href={`${snapshot.repository.url}/blob/${snapshot.repository.commit}/${node.path}#L${node.startLine}`} target="_blank" rel="noreferrer" aria-label="View source on GitHub"><ExternalLink size={12} /></a>}</div>
  </aside>;
}
function FolderIcon() { return <MoreHorizontal size={28} />; }
