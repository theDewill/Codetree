export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><svg viewBox="0 0 32 32" width="29" height="29" fill="none" aria-hidden="true"><path d="M8 7v9a7 7 0 0 0 7 7h8M8 16h8a7 7 0 0 0 7-7V7" stroke="currentColor" strokeWidth="2" /><rect x="4" y="3" width="8" height="8" rx="2.5" fill="currentColor" /><rect x="19" y="3" width="8" height="8" rx="2.5" fill="currentColor" /><rect x="19" y="19" width="8" height="8" rx="2.5" fill="currentColor" /></svg>{!compact && <span>codetree<span className="brand-period">.</span></span>}</span>;
}
