export type NodeKind = 'repository' | 'file' | 'function' | 'method' | 'class' | 'interface' | 'type' | 'constant';
export interface CodeNode {
  id: string; name: string; kind: NodeKind; path: string; startLine: number; endLine: number;
  signature: string; description: string; exported: boolean; entry: boolean;
  parentId: string; language: string; source: string;
}
export interface CodeEdge { id: string; source: string; target: string; kind: string; resolution: string; path: string; line: number }
export interface Repository { id: string; name: string; owner: string; url: string; description: string; branch: string; commit: string; branches: string[]; sample: boolean; indexedAt: string }
export interface Snapshot { id: string; repository: Repository; graph: { nodes: CodeNode[]; edges: CodeEdge[]; diagnostics: string[] } }
export interface RepoSummary { id: string; repository: Repository; nodeCount: number; edgeCount: number }
export interface Model { id: string; name: string; provider: string; modelId: string; baseUrl?: string; keyEnv?: string; enabled: boolean; configured: boolean; contextLimit: number }
export interface User { id: string; name: string; email?: string; admin: boolean; local: boolean }
export interface Session { user: User; workspaceId: string; githubLogin?: string }
export interface Config { authMode: 'local' | 'supabase'; supabaseUrl: string; supabaseKey: string; githubConfigured: boolean; githubAppSlug: string; storage: string; version: string }
export interface Citation { nodeId: string; name: string; path: string; startLine: number; endLine: number }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; modelId?: string; createdAt: string; status?: string; sources?: Citation[] }
export interface ImportJob { id: string; url: string; branch: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'; stage: string; progress: number; snapshotId?: string; error?: string }

export const KIND_META: Record<NodeKind, { label: string; color: string; short: string }> = {
  repository: { label: 'Repository', color: '#d5f78a', short: '◈' },
  file: { label: 'File', color: '#56b4e9', short: '▤' },
  function: { label: 'Function', color: '#61afef', short: 'ƒ' },
  method: { label: 'Method', color: '#61afef', short: 'ƒ' },
  class: { label: 'Object', color: '#e6a95c', short: '◇' },
  interface: { label: 'Interface', color: '#cc79a7', short: 'T' },
  type: { label: 'Type', color: '#cc79a7', short: 'T' },
  constant: { label: 'Constant', color: '#56b89b', short: 'C' },
};
