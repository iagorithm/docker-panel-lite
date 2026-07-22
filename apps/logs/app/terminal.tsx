"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { AppLog } from "@/lib/logs";

function formattedCode(value: unknown) {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return value;
    }
  }
  return value;
}

async function responseBody(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as { error?: string; logs?: AppLog[]; idToken?: string } : {};
  } catch {
    throw new Error(`HTTP ${response.status} returned a non-JSON response`);
  }
}

export function LogsTerminal() {
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [agentInstruction, setAgentInstruction] = useState("");
  const [agentMarkdown, setAgentMarkdown] = useState(true);
  const [agentApply, setAgentApply] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<{ runId: string; report: string; branch?: string; changes?: Array<{ path: string; commit: string }> } | null>(null);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(() => new Set());
  const [actor, setActor] = useState("all");
  const [worker, setWorker] = useState("");
  const [container, setContainer] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = useCallback(() => {
    const params = new URLSearchParams({
      actor,
      from: String(from ? new Date(from).getTime() : 0),
      to: String(to ? new Date(to).getTime() : Number.MAX_SAFE_INTEGER),
    });
    if (worker) params.set("worker", worker);
    if (container) params.set("container", container);
    return params;
  }, [actor, worker, container, from, to]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/logs?${query()}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) {
        setNeedsLogin(response.status === 401);
        throw new Error(body.error || `Logs API returned HTTP ${response.status}`);
      }
      setLogs(body.logs || []);
      setNeedsLogin(false);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setLoggingIn(true);
    setError("");
    try {
      const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
      if (!apiKey) throw new Error("Firebase API key is not configured in the logs container");
      const authentication = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
      );
      const authBody = await responseBody(authentication);
      if (!authentication.ok || !authBody.idToken) {
        throw new Error(authBody.error || "Invalid email or password");
      }
      const session = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: authBody.idToken }),
      });
      const sessionBody = await responseBody(session);
      if (!session.ok) throw new Error(sessionBody.error || "Could not create the admin session");
      setPassword("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoggingIn(false);
    }
  };

  const workers = useMemo(
    () => [...new Set(logs.filter((log) => log.actorType === "worker").map((log) => log.actorId))].sort(),
    [logs],
  );
  const containers = useMemo(
    () => [...new Set(logs.map((log) => log.context?.containerId || "").filter(Boolean))].sort(),
    [logs],
  );

  const download = async () => {
    const response = await fetch(`/api/logs/drain?${query()}`, { method: "POST" });
    if (!response.ok) {
      const body = await responseBody(response);
      setError(body.error || `Download failed with HTTP ${response.status}`);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "app-logs.logs";
    link.click();
    URL.revokeObjectURL(url);
    await refresh();
  };

  const resetFilters = () => {
    setActor("all");
    setWorker("");
    setContainer("");
    setFrom("");
    setTo("");
  };

  const selectedLogs = useMemo(() => logs.filter((log) => selectedLogIds.has(log.id)), [logs, selectedLogIds]);

  const runAgent = async (logsToAnalyze: AppLog[] = selectedLogs) => {
    if (!logsToAnalyze.length) {
      setError("Select at least one log to analyze");
      return;
    }
    setAgentRunning(true);
    setError("");
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: logsToAnalyze, instruction: agentInstruction, format: agentMarkdown ? "markdown" : "summary", apply: agentApply }),
      });
      const body = await responseBody(response) as { error?: string; runId?: string; report?: string; branch?: string; changes?: Array<{ path: string; commit: string }> };
      if (!response.ok || !body.report || !body.runId) throw new Error(body.error || `CrewAI agent returned HTTP ${response.status}`);
      setAgentResult({ runId: body.runId, report: body.report, branch: body.branch, changes: body.changes });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAgentRunning(false);
    }
  };

  const downloadAgentReport = () => {
    if (!agentResult) return;
    const blob = new Blob([agentResult.report], { type: agentMarkdown ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `services-diagnostics-${agentResult.runId}.${agentMarkdown ? "md" : "txt"}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main>
      <header>
        <div><span className="prompt">root@docker-panel:~$</span><h1>error-log console</h1></div>
        <div><b>{logs.length}</b> errors</div>
      </header>
      {needsLogin ? (
        <form className="login" onSubmit={login}>
          <strong>admin authentication required</strong>
          <input type="email" placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <input type="password" placeholder="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button type="submit" disabled={loggingIn}>{loggingIn ? "authenticating..." : "sign in"}</button>
        </form>
      ) : null}
      <section className="filters">
        <label>from (empty = all)<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>to (empty = live)<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>source<select value={actor} onChange={(event) => setActor(event.target.value)}><option value="all">all</option><option value="worker">workers</option><option value="ui">ui/users</option></select></label>
        <label>worker<select value={worker} onChange={(event) => setWorker(event.target.value)}><option value="">all workers</option>{workers.map((id) => <option key={id}>{id}</option>)}</select></label>
        <label>container<select value={container} onChange={(event) => setContainer(event.target.value)}><option value="">all containers</option>{containers.map((id) => <option key={id}>{id}</option>)}</select></label>
        <button onClick={() => void refresh()}>refresh</button>
        <button onClick={resetFilters}>reset filters</button>
        <button className="download" onClick={() => void download()}>download + clear</button>
      </section>
      <section className="agent-controls">
        <div><strong>CrewAI services agent</strong><span>{selectedLogs.length} of {logs.length} logs selected · writes only to a dedicated GitHub branch</span></div>
        <input value={agentInstruction} onChange={(event) => setAgentInstruction(event.target.value)} placeholder="optional diagnostic instruction" />
        <label><input type="checkbox" checked={agentMarkdown} onChange={(event) => setAgentMarkdown(event.target.checked)} /> Markdown report</label>
        <label className="agent-apply"><input type="checkbox" checked={agentApply} onChange={(event) => setAgentApply(event.target.checked)} /> Apply fixes to branch</label>
        <button disabled={!logs.length} onClick={() => setSelectedLogIds(new Set(logs.map((log) => log.id)))}>select all</button>
        <button disabled={!selectedLogIds.size} onClick={() => setSelectedLogIds(new Set())}>clear selection</button>
        <button disabled={agentRunning || !selectedLogs.length || needsLogin} onClick={() => void runAgent()}>{agentRunning ? "analyzing..." : `analyze selected (${selectedLogs.length})`}</button>
      </section>
      {error ? <p className="error">ERROR {error}</p> : null}
      {agentResult ? (
        <section className="agent-report">
          <header><strong>agent run {agentResult.runId}</strong><span>{agentResult.branch ? `branch=${agentResult.branch}` : "analysis-only"}</span><button onClick={downloadAgentReport}>download report</button></header>
          <pre><code>{agentResult.report}</code></pre>
          {agentResult.changes?.length ? <small>changes: {agentResult.changes.map((change) => `${change.path}@${change.commit.slice(0, 8)}`).join(", ")}</small> : null}
        </section>
      ) : null}
      <section className="terminal">
        {logs.length ? logs.map((log) => (
          <article className={selectedLogIds.has(log.id) ? "is-selected" : ""} key={log.id}>
            <div className="log-selection">
              <input
                type="checkbox"
                checked={selectedLogIds.has(log.id)}
                aria-label={`Select ${log.action} log`}
                onChange={(event) => setSelectedLogIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(log.id); else next.delete(log.id);
                  return next;
                })}
              />
              <button disabled={agentRunning || needsLogin} onClick={() => void runAgent([log])}>analyze</button>
            </div>
            <time>{new Date(log.createdAt).toLocaleString()}</time>
            <strong>{log.runtime}:{log.functionName}</strong>
            <span>[{log.action}]</span>
            <pre className="log-code"><code>{formattedCode(log.message)}</code></pre>
            <div className="log-context">
              <small>
                component={log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}
                {" user="}{log.userEmail || log.actorEmail || log.userId || (log.actorType === "ui" ? log.actorId : "unknown")}
                {" source="}{log.source}
              </small>
              <pre><code>{formattedCode(log.context || {})}</code></pre>
            </div>
          </article>
        )) : <p className="empty">-- no application errors stored --</p>}
      </section>
    </main>
  );
}
