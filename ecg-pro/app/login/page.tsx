"use client";

import { useState, type FormEvent } from "react";

export default function DashboardLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/v1/dashboard/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        cache: "no-store",
      });
      if (!response.ok) {
        const result: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(result.error || "Unable to sign in. Please try again.");
      }
      // Refresh the document so the signed HttpOnly cookie is sent with the
      // initial request and the authenticated Socket.IO connection.
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-slate-900">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-white/10 text-2xl font-bold">
            E
          </div>
          <h1 className="text-3xl font-bold tracking-tight">ECG Energy Monitor</h1>
          <p className="mt-2 text-sm text-slate-300">Secure dashboard access</p>
        </div>

        <form onSubmit={submit} className="rounded-2xl bg-white p-7 shadow-2xl sm:p-8">
          <h2 className="mb-6 text-xl font-semibold">Sign in</h2>
          <label htmlFor="username" className="block text-sm font-medium text-slate-700">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            maxLength={128}
            required
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Dashboard username"
            className="mt-2 mb-5 w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
          <label htmlFor="password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={512}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Dashboard password"
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="mt-6 w-full rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 disabled:cursor-wait disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in to dashboard"}
          </button>
          <p className="mt-5 text-center text-xs text-slate-500">
            Use the dashboard credentials configured on Render.
          </p>
        </form>
      </div>
    </main>
  );
}
