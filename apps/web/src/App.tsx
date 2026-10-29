import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Command, ExternalLink, GitBranch, Github, Info, Layers3, LoaderCircle, Network, PanelLeftOpen, Plus, Settings2, ShieldCheck, X } from 'lucide-react';
import { api, setAccessToken } from './lib/api';
import { auth } from './lib/auth';
import type { Config, ImportJob, Model, RepoSummary, Session, Snapshot } from './lib/types';
import { Brand } from './components/Brand';
import { CodeGraph } from './components/CodeGraph';
import { Dock } from './components/Dock';
import { Explorer } from './components/Explorer';
import { Inspector } from './components/Inspector';
import { Modal } from './components/Modal';
import { AuthPanel } from './components/AuthPanel';
import { RepositoryDialog } from './components/RepositoryDialog';
import { AdminDialog } from './components/AdminDialog';

type Dialog = 'repository' | 'settings' | 'admin' | 'auth' | 'coverage' | null;
class GraphBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null), [session, setSession] = useState<Session | null>(null);
  const [repositories, setRepositories] = useState<RepoSummary[]>([]), [snapshot, setSnapshot] = useState<Snapshot | null>(null), [selectedId, setSelectedId] = useState('');
  const [models, setModels] = useState<Model[]>([]), [modelId, setModelId] = useState('local-guide');
  const [booting, setBooting] = useState(true), [bootError, setBootError] = useState(''), [loadingGraph, setLoadingGraph] = useState(false);
  const [recovery, setRecovery] = useState(false), [dialog, setDialog] = useState<Dialog>(null), [query, setQuery] = useState(''), [sidebar, setSidebar] = useState(() => window.innerWidth >= 1000), [inspector, setInspector] = useState(() => window.innerWidth >= 730);
  const [mode, setMode] = useState<'3d' | '2d'>(() => localStorage.getItem('codetree.graphMode') === '2d' ? '2d' : '3d');
  const [focus, setFocus] = useState(false), [showData, setShowData] = useState(false), [toast, setToast] = useState(''), [branchJob, setBranchJob] = useState<ImportJob | null>(null);
  const workspace = useRef(''), loadSequence = useRef(0);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { localStorage.setItem('codetree.graphMode', mode); }, [mode]);
  const loadSnapshot = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current; setLoadingGraph(true);
    try {
      const result = await api<Snapshot>(`/snapshots/${id}`); if (sequence !== loadSequence.current) return;
      setSnapshot(result); setSelectedId(result.graph.nodes.find(node => node.entry)?.id || result.graph.nodes.find(node => node.kind === 'function' && node.exported && /(?:^|\/)(?:index|main|server|app)\.[jt]sx?$/.test(node.path))?.id || result.graph.nodes.find(node => node.kind === 'function')?.id || result.graph.nodes[0]?.id || '');
      setFocus(false); setInspector(window.innerWidth >= 730); setQuery('');
      if (workspace.current) localStorage.setItem(`codetree.snapshot.${workspace.current}`, id);
    } finally { if (sequence === loadSequence.current) setLoadingGraph(false); }
  }, []);
  const refreshModels = useCallback(async () => {
    const result = await api<Model[]>('/models'); setModels(result);
    setModelId(previous => result.some(model => model.id === previous && model.configured) ? previous : result.find(model => model.configured && model.provider !== 'local')?.id || 'local-guide');
  }, []);
  const loadWorkspace = useCallback(async () => {
    const me = await api<Session>('/session'); workspace.current = me.workspaceId; setSession(me);
    const [repos, catalog] = await Promise.all([api<RepoSummary[]>('/repositories'), api<Model[]>('/models')]);
    setRepositories(repos); setModels(catalog); setModelId(catalog.find(model => model.provider !== 'local' && model.configured)?.id || 'local-guide');
    const stored = localStorage.getItem(`codetree.snapshot.${me.workspaceId}`);
    const active = repos.find(repo => repo.id === stored) || repos[0];
    if (active) await loadSnapshot(active.id);
  }, [loadSnapshot]);
  useEffect(() => {
    let disposed = false, unsubscribe: (() => void) | undefined;
    async function start() {
      try {
        const settings = await api<Config>('/config'); if (disposed) return; setConfig(settings);
        const client = auth(settings);
        if (client) {
          const { data } = await client.auth.getSession(); setAccessToken(data.session?.access_token);
          if (data.session) await loadWorkspace();
          const subscription = client.auth.onAuthStateChange((event, next) => {
            setAccessToken(next?.access_token);
            if (event === 'PASSWORD_RECOVERY') { setRecovery(true); setDialog('auth'); }
            if (event === 'SIGNED_OUT') { setSession(null); setSnapshot(null); }
            if (event === 'SIGNED_IN' && next) setTimeout(() => { loadWorkspace().then(() => setDialog(null)).catch(error => notify(error.message)); }, 0);
          });
          unsubscribe = () => subscription.data.subscription.unsubscribe();
        } else await loadWorkspace();
        const github = new URLSearchParams(window.location.search).get('github');
        if (new URLSearchParams(window.location.search).get('reset') === '1') { setRecovery(true); setDialog('auth'); }
        if (github) { notify(github === 'connected' ? 'GitHub connected. Your repositories are ready to explore.' : 'GitHub could not be connected. Check the app configuration and try again.'); history.replaceState(null, '', window.location.pathname); }
      } catch (error) { if (!disposed) setBootError((error as Error).message); }
      finally { if (!disposed) setBooting(false); }
    }
    start(); return () => { disposed = true; unsubscribe?.(); };
  }, [loadWorkspace, notify]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSidebar(true); setTimeout(() => document.getElementById('symbol-search')?.focus(), 0); }
    }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const onSelect = useCallback((id: string) => { setSelectedId(id); setInspector(true); }, []);
  const reloadRepositories = useCallback(async () => { const result = await api<RepoSummary[]>('/repositories'); setRepositories(result); return result; }, []);
  const imported = useCallback(async (id: string) => { await reloadRepositories(); await loadSnapshot(id); notify('Your codebase map is ready. Pick a node and start exploring.'); }, [reloadRepositories, loadSnapshot, notify]);
  async function removeSnapshot(id: string) { await api(`/snapshots/${id}`, { method: 'DELETE' }); const repos = await reloadRepositories(); if (snapshot?.id === id && repos[0]) await loadSnapshot(repos[0].id); }
  async function changeBranch(branch: string) {
    if (!snapshot || snapshot.repository.sample || branchJob && ['running', 'queued'].includes(branchJob.status)) return;
    try { const job = await api<ImportJob>('/repositories', { method: 'POST', body: JSON.stringify({ url: snapshot.repository.url, branch }) }); setBranchJob(job); }
    catch (error) { notify((error as Error).message); }
  }
  useEffect(() => {
    if (!branchJob || !['queued', 'running'].includes(branchJob.status)) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<ImportJob>(`/imports/${branchJob.id}`); if (disposed) return; setBranchJob(next);
        if (next.status === 'complete' && next.snapshotId) { await imported(next.snapshotId); setBranchJob(null); }
        else if (next.status === 'failed' || next.status === 'cancelled') { notify(next.error || 'Branch import stopped.'); setBranchJob(null); }
        else timer = setTimeout(poll, 850);
      } catch (error) { if (!disposed) { notify((error as Error).message); setBranchJob(null); } }
    };
    timer = setTimeout(poll, 600); return () => { disposed = true; clearTimeout(timer); };
  }, [branchJob?.id]);
  async function connectGithub() {
    try { const result = await api<{ url: string }>('/github/connect', { method: 'POST' }); window.location.assign(result.url); }
    catch (error) { notify((error as Error).message); }
  }
  async function signOut() {
    try { if (config && auth(config)) { await auth(config)!.auth.signOut(); setSession(null); } else { await api('/session/logout', { method: 'POST' }); window.location.reload(); } }
    catch (error) { notify((error as Error).message); }
  }
  const node = snapshot?.graph.nodes.find(node => node.id === selectedId);
  const model = models.find(model => model.id === modelId);
  if (booting) return <div className="startup"><Brand /><div><LoaderCircle size={18} className="spin" /><span>Finding the connections…</span></div></div>;
  if (bootError) return <div className="startup"><Brand /><h2>Let’s get connected.</h2><p>{bootError}</p><p className="muted">Run <code>npm run dev</code> from the project folder to start the frontend and Go API.</p><button className="button primary" onClick={() => window.location.reload()}>Try again<ArrowRight size={15} /></button></div>;
  if (!session && config) return <div className="auth-screen"><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /><div className="auth-screen-card"><AuthPanel config={config} /></div><span className="auth-tagline">Find your way through the code.</span></div>;
  if (!snapshot || !session || !config) return <div className="startup"><Brand /><p>No repository is available yet.</p><button className="button primary" onClick={() => window.location.reload()}>Reload workspace</button></div>;
  return <div className="app-shell">
    <header className="app-header"><div className="header-brand"><Brand /><span className="header-divider" /><button className="workspace-switch" onClick={() => setDialog('repository')}><span className="workspace-avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span>Personal workspace</span><ChevronDown size={12} /></button></div><div className="header-right"><span className="build-badge"><span />EARLY ACCESS</span><button className="help-button icon-button" aria-label="Analysis coverage and help" onClick={() => setDialog('coverage')}><CircleHelp size={17} /></button><button className="button primary header-connect" onClick={() => setDialog('repository')}><Plus size={15} />Connect repository</button></div></header>
    <div className="workspace-bar"><div><button className="icon-button" aria-label={sidebar ? 'Hide explorer' : 'Show explorer'} onClick={() => setSidebar(!sidebar)}><PanelLeftOpen size={16} /></button><span className="breadcrumb-separator" /><Github size={15} /><button className="repo-switch" onClick={() => setDialog('repository')}><span>{snapshot.repository.owner}<span className="repo-slash">/</span><strong>{snapshot.repository.name}</strong></span><ChevronDown size={12} /></button>{snapshot.repository.sample && <span className="sample-badge">Sample project</span>}<ChevronRight size={13} className="crumb-chevron" /><span className="workspace-view"><Network size={14} />Codebase map</span></div><div className="workspace-stats"><span><span className="status-dot" />{branchJob ? 'Indexing repository' : 'Graph ready'}</span><span>{snapshot.graph.nodes.length} nodes</span><span>{snapshot.graph.edges.length} connections</span><button className="icon-button" aria-label="View analysis coverage" onClick={() => setDialog('coverage')}><Info size={14} /></button></div></div>
    <main className={`workspace-main ${sidebar ? '' : 'sidebar-hidden'} ${inspector ? 'has-inspector' : ''}`}>
      {sidebar && <Explorer snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} query={query} setQuery={setQuery} onImport={() => setDialog('repository')} onClose={() => setSidebar(false)} />}
      <section className="graph-workspace">
        <GraphBoundary key={`${mode}:${snapshot.id}`} fallback={<div className="graph-fallback"><Layers3 size={30} /><h2>The map needs another angle.</h2><p>Your browser could not initialize the 3D renderer.</p><button className="button primary" onClick={() => setMode('2d')}>Open the 2D map<ArrowRight size={15} /></button></div>}><CodeGraph snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} mode={mode} setMode={setMode} focus={focus} setFocus={setFocus} showData={showData} /></GraphBoundary>
        <div className="graph-legend"><span className="legend-title">THE MAP KEY</span><div><span><i style={{ background: '#61afef' }} />Functions</span><span><i style={{ background: '#e6a95c' }} />Objects</span><span><i style={{ background: '#cc79a7' }} />Types</span><span><i style={{ background: '#56b4e9' }} />Files</span></div><span className="legend-connections"><i />Directional relationships</span></div>
        <Dock models={models} modelId={modelId} setModel={setModelId} snapshot={snapshot} session={session} onBranch={changeBranch} onSettings={() => setDialog('settings')} onAdmin={() => setDialog('admin')} onAuth={() => setDialog('auth')} onSignOut={signOut} focus={focus} setFocus={setFocus} />
        {(loadingGraph || branchJob) && <div className="graph-loading"><LoaderCircle size={16} className="spin" />{branchJob?.stage || 'Opening snapshot…'}</div>}
        {!inspector && node && <button className="reopen-inspector button secondary" onClick={() => setInspector(true)}>Inspect {node.name}<ChevronRight size={14} /></button>}
      </section>
      {inspector && node && <Inspector snapshot={snapshot} node={node} model={model} onSelect={onSelect} onClose={() => setInspector(false)} onError={notify} />}
    </main>
    <footer className="app-statusbar"><span><span className="status-dot" />{session.user.local ? 'Local workspace' : 'Personal workspace'}<span className="status-divider">/</span><GitBranch size={11} />{snapshot.repository.branch}<span className="mono commit-label">{snapshot.repository.commit.slice(0, 7)}</span></span><span><span className="status-tip"><Command size={11} />K to find anything</span><span className="status-divider">/</span>Built for the curious.</span></footer>
    {toast && <div role="status" className="toast"><Info size={16} /><span>{toast}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {dialog === 'repository' && <RepositoryDialog repositories={repositories} activeId={snapshot.id} onSelect={id => loadSnapshot(id).catch(error => notify(error.message))} onImported={imported} onDelete={removeSnapshot} onClose={() => setDialog(null)} onError={notify} onBackground={job => { setBranchJob(job); notify('Your repository is indexing in the background.'); }} />}
    {dialog === 'admin' && session.user.admin && <AdminDialog onClose={() => setDialog(null)} onChanged={refreshModels} />}
    {dialog === 'auth' && <Modal title="Your CodeTree account" onClose={() => setDialog(null)}><AuthPanel config={config} recovery={recovery} onLocal={() => setDialog(null)} /></Modal>}
    {dialog === 'settings' && <Modal title="Make yourself at home." subtitle="A few things to help you see the code your way." onClose={() => setDialog(null)}>
      <div className="settings-section"><span className="section-label">YOUR WORKSPACE</span><div className="setting-row"><span><strong>Default graph view</strong><small>Choose the perspective that feels right.</small></span><div className="view-switch"><button className={mode === '2d' ? 'active' : ''} onClick={() => setMode('2d')}>2D</button><button className={mode === '3d' ? 'active' : ''} onClick={() => setMode('3d')}>3D</button></div></div><div className="setting-row"><span><strong>Data declarations</strong><small>Include constants in the overview.</small></span><button className={`toggle ${showData ? 'on' : ''}`} role="switch" aria-checked={showData} aria-label="Show data declarations" onClick={() => setShowData(!showData)}><span /></button></div></div>
      <div className="settings-section"><span className="section-label">CONNECTIONS</span><div className="setting-row"><span className="setting-provider"><Github size={23} /><span><strong>GitHub</strong><small>{session.githubLogin ? `Connected as ${session.githubLogin}` : 'Connect private repositories and more.'}</small></span></span>{session.githubLogin ? <button className="button secondary compact" onClick={async () => { try { await api('/github/connect', { method: 'DELETE' }); setSession({ ...session, githubLogin: '' }); notify('GitHub disconnected.'); } catch (error) { notify((error as Error).message); } }}>Disconnect</button> : <button className="button secondary compact" onClick={connectGithub}>Connect<ArrowUpRight size={13} /></button>}</div>{!config.githubConfigured && <div className="settings-info">Set <code>GITHUB_APP_CLIENT_ID</code> and <code>GITHUB_APP_CLIENT_SECRET</code> to enable GitHub connections. Public repositories can already be imported.</div>}{config.githubAppSlug && <a className="text-link" target="_blank" rel="noreferrer" href={`https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new`}>Install CodeTree’s GitHub App<ExternalLink size={13} /></a>}</div>
      <div className="settings-section"><span className="section-label">ACCOUNT & INTELLIGENCE</span><button className="settings-link" onClick={() => setDialog('auth')}><span><strong>{session.user.local ? 'Set up authentication' : 'Account'}</strong><small>{session.user.local ? 'Google, GitHub, Apple, and email/password.' : session.user.email}</small></span><ChevronRight size={16} /></button>{session.user.admin && <button className="settings-link" onClick={() => setDialog('admin')}><span className="setting-provider"><ShieldCheck size={20} /><span><strong>Developer console</strong><small>Manage models and provider credentials.</small></span></span><ChevronRight size={16} /></button>}</div>
      <div className="settings-footer"><Brand compact /><span>CodeTree v{config.version} · local development edition</span></div>
    </Modal>}
    {dialog === 'coverage' && <Modal title="A map with a little honesty." subtitle="What this snapshot knows, and what still needs a closer look." onClose={() => setDialog(null)}><div className="coverage-summary"><div><strong>{snapshot.graph.nodes.filter(n => n.kind === 'file').length}</strong><span>source files</span></div><div><strong>{snapshot.graph.nodes.length}</strong><span>graph nodes</span></div><div><strong>{snapshot.graph.edges.filter(e => e.kind === 'calls').length}</strong><span>resolved calls</span></div></div><div className="coverage-list">{snapshot.graph.diagnostics.map((message, i) => <div key={i}><Info size={16} /><p>{message}</p></div>)}</div><p className="coverage-note">A codebase can have multiple entry points and cycles. Runtime behavior may depend on dynamic imports, reflection, configuration, or external packages. The graph shows the relationships resolved from this snapshot.</p><div className="coverage-commit"><GitBranch size={14} />{snapshot.repository.branch}<span className="mono">{snapshot.repository.commit.slice(0, 12)}</span><span>Immutable source snapshot</span></div></Modal>}
  </div>;
}
