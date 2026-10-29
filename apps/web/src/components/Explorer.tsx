import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, Search, Plus, ArrowUpRight, CircleDot, PanelLeftClose, FileCode2 } from 'lucide-react';
import { KIND_META, type CodeNode, type Snapshot } from '../lib/types';

export function Explorer({ snapshot, selectedId, onSelect, onImport, query, setQuery, onClose }: {
  snapshot: Snapshot; selectedId: string; onSelect: (id: string) => void; onImport: () => void; query: string; setQuery: (query: string) => void; onClose: () => void;
}) {
  const selected = snapshot.graph.nodes.find(n => n.id === selectedId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(selected?.path ? [selected.path] : []));
  useEffect(() => { if (selected?.path) setExpanded(previous => new Set([...previous, selected.path])); }, [selected?.path]);
  const files = useMemo(() => snapshot.graph.nodes.filter(n => n.kind === 'file'), [snapshot]);
  const entry = snapshot.graph.nodes.find(n => n.entry);
  const filtered = query ? snapshot.graph.nodes.filter(n => n.name.toLowerCase().includes(query.toLowerCase()) || n.path.toLowerCase().includes(query.toLowerCase())).slice(0, 80) : [];
  function toggle(path: string) { setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  function symbol(node: CodeNode) {
    return <button key={node.id} title={`${node.name} · ${node.path}:${node.startLine}`} className={`symbol-row ${node.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(node.id)} style={{ paddingLeft: query ? 14 : node.kind === 'method' ? 47 : 33 }}>
      <span className="symbol-kind" style={{ color: KIND_META[node.kind].color }}>{KIND_META[node.kind].short}</span><span className="truncate">{node.name}</span>{node.entry && <span className="entry-dot" />}
    </button>;
  }
  return <aside className="explorer">
    <div className="explorer-title"><span><FolderTree size={15} />Explorer</span><button className="icon-button" onClick={onClose} aria-label="Hide explorer"><PanelLeftClose size={15} /></button></div>
    <label className="explorer-search"><Search size={14} /><input id="symbol-search" aria-label="Search symbols" placeholder="Find a file or symbol…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
    <div className="explorer-repo"><ChevronDown size={13} /><span>{snapshot.repository.name}</span><span className="count">{files.length}</span></div>
    <div className="file-tree">
      {query ? <><div className="search-count">{filtered.length}{filtered.length === 80 ? '+' : ''} results</div>{filtered.map(symbol)}{filtered.length === 0 && <div className="empty-inline">No matching symbols.</div>}</> : files.map(file => <div key={file.id}>
        <div className={`file-row ${selectedId === file.id ? 'selected' : ''}`}><button className="file-chevron" aria-label={`${expanded.has(file.path) ? 'Collapse' : 'Expand'} ${file.path}`} aria-expanded={expanded.has(file.path)} onClick={() => toggle(file.path)}>{expanded.has(file.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button><button className="file-select" onClick={() => { onSelect(file.id); toggle(file.path); }} title={file.path}><span className={`language-icon ${file.language === 'Go' ? 'go' : ''}`}>{file.language === 'TypeScript' ? 'TS' : file.language === 'JavaScript' ? 'JS' : file.language === 'Go' ? 'Go' : <FileCode2 size={12} />}</span><span className="truncate">{file.name}</span></button></div>
        {expanded.has(file.path) && snapshot.graph.nodes.filter(n => n.path === file.path && n.kind !== 'file').map(symbol)}
      </div>)}
    </div>
    <div className="explorer-bottom">
      {entry && <button className="entry-card" onClick={() => onSelect(entry.id)}><span className="entry-card-icon"><CircleDot size={17} /></span><span><strong>Start at the beginning</strong><span>Jump to an entry point</span></span><ArrowUpRight size={15} /></button>}
      <button className="button secondary full add-repo-small" onClick={onImport}><Plus size={15} />Connect a repository</button>
      <div className="workspace-footnote"><span className="status-dot" />{snapshot.repository.sample ? 'Sample project · locally analyzed' : 'Snapshot indexed'}<span className="mono">{snapshot.repository.commit.slice(0, 7)}</span></div>
    </div>
  </aside>;
}
