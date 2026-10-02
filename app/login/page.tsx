'use client';

import { useState } from 'react';
import { api, BASE_PATH } from '../base-path';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(api('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not sign in');
      // Shown in place of the page you asked for: reload it. On /login itself, go to the app.
      if (location.pathname.replace(/\/+$/, '') === `${BASE_PATH}/login`) location.href = `${BASE_PATH}/`;
      else location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <span className="logo">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z" />
          </svg>
        </span>
        <h1>
          Meeting<b>Master</b>
        </h1>
        <p className="muted">Enter the password to open your notes.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="login-error">{error}</p>}
        <button className="dark" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
