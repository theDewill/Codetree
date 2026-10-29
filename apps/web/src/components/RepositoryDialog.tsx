import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCircle2, GitBranch, Github, GitPullRequest, LoaderCircle, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ImportJob, RepoSummary } from '../lib/types';
import { Modal } from './Modal';

export function RepositoryDialog({ repositories, activeId, onSelect, onImported, onDelete, onClose, onError, onBackground }: { repositories: RepoSummary[]; activeId?: string; onSelect: (id: string) => void; onImported: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onClose: () => void; onError: (message: string) => void; onBackground: (job: ImportJob) => void }) {
  const [url, setURL] = useState(''), [branch, setBranch] = useState(''), [job, setJob] = useState<ImportJob | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await api<ImportJob>(`/imports/${job.id}`); if (disposed) return; setJob(updated);
        if (updated.status === 'complete' && updated.snapshotId) { await onImported(updated.snapshotId); if (!disposed) onClose(); }
        else if (['queued', 'running'].includes(updated.status)) timer = setTimeout(poll, 800);
        else { setBusy(false); if (updated.error) setError(updated.error); }
      } catch (error) { if (!disposed) { setError((error as Error).message); setBusy(false); } }
    };
    timer = setTimeout(poll, 500); return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const created = await api<ImportJob>('/repositories', { method: 'POST', body: JSON.stringify({ url: url.trim(), branch: branch.trim() }) }); setJob(created); }
    catch (error) { setBusy(false); setError((error as Error).message); }
  }
  async function cancel() { if (!job) return; try { await api(`/imports/${job.id}/cancel`, { method: 'POST' }); } catch (error) { onError((error as Error).message); } }
  function close() { if (job && ['queued', 'running'].includes(job.status)) onBackground(job); onClose(); }
  return <Modal title="A new perspective on your code." subtitle="Connect a GitHub repository and turn its source into something you can explore." onClose={close}>
    <form className="form-stack import-form" onSubmit={submit}>
      <label>Repository URL<div className="input-with-icon"><Github size={17} /><input autoFocus type="url" placeholder="https://github.com/owner/repository" required disabled={busy} value={url} onChange={event => setURL(event.target.value)} /></div></label>
      <label>Branch <span className="optional">optional</span><div className="input-with-icon"><GitBranch size={16} /><input placeholder="Use the default branch" disabled={busy} value={branch} onChange={event => setBranch(event.target.value)} /></div></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      {busy && job ? <div className="import-progress"><div><LoaderCircle className="spin" size={16} /><strong>{job.stage}</strong><span>{job.progress}%</span></div><div className="progress-track"><div style={{ width: `${job.progress}%` }} /></div><button type="button" className="text-button muted" onClick={cancel}>Cancel import</button></div> : <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Build my codebase map<ArrowRight size={16} /></button>}
    </form>
    <div className="import-note"><LockKeyhole size={15} /><span>Private repositories require a connected GitHub App account. Source is read without executing your code.</span></div>
    <div className="recent-repos"><div className="section-label">YOUR REPOSITORIES<span>{repositories.length}</span></div>{repositories.map(repo => <div key={repo.id} className="recent-repo"><button onClick={() => { onSelect(repo.id); onClose(); }}><span className="repo-list-icon">{repo.repository.sample ? <GitPullRequest size={19} /> : <Github size={19} />}</span><span><strong>{repo.repository.owner}<span>/</span>{repo.repository.name}</strong><small><GitBranch size={11} />{repo.repository.branch}<span>·</span>{repo.nodeCount} nodes{repo.repository.sample && <span className="sample-inline">Sample</span>}</small></span>{activeId === repo.id ? <Check size={16} className="accent" /> : <ArrowRight size={15} />}</button>{!repo.repository.sample && <button className="icon-button" title="Remove snapshot" aria-label={`Remove ${repo.repository.name} snapshot`} onClick={async () => { try { await onDelete(repo.id); } catch (error) { onError((error as Error).message); } }}><Trash2 size={14} /></button>}</div>)}</div>
  </Modal>;
}
