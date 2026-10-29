import { useState, type FormEvent } from 'react';
import { Github, Apple, ArrowRight, Mail, CheckCircle2, ShieldCheck } from 'lucide-react';
import { auth } from '../lib/auth';
import type { Config } from '../lib/types';
import { Brand } from './Brand';

export function AuthPanel({ config, onLocal, recovery = false }: { config: Config; onLocal?: () => void; recovery?: boolean }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const client = auth(config);
  async function social(provider: 'google' | 'github' | 'apple') {
    if (!client) return;
    setBusy(true); setError('');
    const { error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } });
    if (error) { setError(error.message); setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (recovery) {
        const { error } = await client.auth.updateUser({ password }); if (error) throw error;
        setNotice('Password updated. You can close this window and continue exploring.');
        history.replaceState(null, '', window.location.pathname);
      } else if (mode === 'reset') {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/?reset=1' });
        if (error) throw error; setNotice('Check your email for a password reset link.');
      } else if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error; if (!data.session) setNotice('Check your email to confirm your account.');
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error;
      }
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  if (!client) return <div className="auth-panel">
    <div className="auth-emblem"><ShieldCheck size={26} /></div><h3>Your own little corner of the codebase.</h3>
    <p>You’re exploring a private local workspace. To enable Google, GitHub, Apple, and email accounts, connect Supabase Auth.</p>
    <div className="setup-code">SUPABASE_URL<br />SUPABASE_ANON_KEY</div>
    <p className="muted small">Add these values to <code>.env</code>, configure the sign-in providers, and restart the development server. Setup details are in the project README.</p>
    {onLocal && <button className="button primary full" onClick={onLocal}>Keep exploring locally <ArrowRight size={16} /></button>}
  </div>;
  if (recovery) return <div className="auth-panel"><h3>Choose your new password.</h3><p>Your reset link has opened a secure session. Set a new password to finish.</p><form onSubmit={submit} className="form-stack"><label>New password<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>{error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-success" role="status">{notice}</div>}<button className="button primary" disabled={busy || !!notice}>{busy ? 'Updating…' : 'Update password'}<ArrowRight size={15} /></button></form></div>;
  return <div className="auth-panel">
    <Brand /><h3>{mode === 'signup' ? 'A clearer view starts here.' : mode === 'reset' ? 'Let’s get you back in.' : 'Welcome to your next aha.'}</h3>
    <p>{mode === 'signup' ? 'Create your account and find your way through the code.' : 'Your codebase, connected. Your questions, in context.'}</p>
    {mode !== 'reset' && <><div className="social-options">
      <button className="button secondary" disabled={busy} onClick={() => social('google')}><span className="google-g">G</span>Google</button>
      <button className="button secondary" disabled={busy} onClick={() => social('github')}><Github size={17} />GitHub</button>
      <button className="button secondary" disabled={busy} onClick={() => social('apple')}><Apple size={17} />Apple</button>
    </div><div className="divider"><span>or continue with email</span></div></>}
    <form onSubmit={submit} className="form-stack">
      <label>Email address<input type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} required /></label>
      {mode !== 'reset' && <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder="At least 8 characters" minLength={8} value={password} onChange={event => setPassword(event.target.value)} required /></label>}
      {error && <div role="alert" className="form-error">{error}</div>}
      {notice && <div role="status" className="form-success"><CheckCircle2 size={17} />{notice}</div>}
      <button className="button primary full" disabled={busy}>{busy ? 'One moment…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}<ArrowRight size={16} /></button>
    </form>
    <div className="auth-links"><button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); setNotice(''); }}>{mode === 'signup' ? 'Already have an account? Sign in' : 'New to CodeTree? Create an account'}</button>{mode === 'signin' && <button onClick={() => setMode('reset')}>Forgot password?</button>}{mode === 'reset' && <button onClick={() => setMode('signin')}><Mail size={13} />Back to sign in</button>}</div>
  </div>;
}
