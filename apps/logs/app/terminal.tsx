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

type IconName = "refresh" | "reset" | "download" | "select" | "clear" | "analyze" | "save" | "solution" | "apply" | "expand" | "hotfix";

function Icon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {name === "refresh" ? <path {...common} d="M19 8a8 8 0 1 0 1 6M19 4v4h-4" /> : null}
    {name === "reset" ? <path {...common} d="M4 5h16M7 12h10M10 19h4" /> : null}
    {name === "download" ? <path {...common} d="M12 3v12m-4-4 4 4 4-4M5 20h14" /> : null}
    {name === "select" ? <path {...common} d="M5 12 9 16 19 6M4 3h16v18H4z" /> : null}
    {name === "clear" ? <path {...common} d="m6 6 12 12M18 6 6 18" /> : null}
    {name === "analyze" ? <path {...common} d="M4 19V9m6 10V5m6 14v-7m4 7H2" /> : null}
    {name === "save" ? <path {...common} d="M5 3h12l2 2v16H5zM8 3v6h8V3m-8 18v-7h8v7" /> : null}
    {name === "solution" ? <path {...common} d="M9 18h6m-5 3h4m3-10a5 5 0 1 0-8 4c1 .8 1 1.5 1 3h4c0-1.5 0-2.2 1-3a5 5 0 0 0 2-4Z" /> : null}
    {name === "apply" ? <path {...common} d="m5 12 4 4L19 6" /> : null}
    {name === "expand" ? <path {...common} d="m7 9 5 5 5-5" /> : null}
    {name === "hotfix" ? <path {...common} d="m13 2-8 12h7l-1 8 8-12h-7z" /> : null}
  </svg>;
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
  const [agentMarkdown, setAgentMarkdown] = useState(true);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<{ runId: string; report: string; branch?: string; plannedBranch?: string; commitMessage?: string; changes?: Array<{ path: string; commit: string }>; previews?: Array<{ path: string; reason: string; diff: string }>; hotfix?: boolean } | null>(null);
  const [agentResultKind, setAgentResultKind] = useState<"analysis" | "solution">("analysis");
  const [agentSourceLogs, setAgentSourceLogs] = useState<AppLog[]>([]);
  const [agentNotice, setAgentNotice] = useState("");
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(() => new Set());
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(() => new Set());
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

  const runAgent = async (
    logsToAnalyze: AppLog[] = selectedLogs,
    options: { kind?: "analysis" | "solution"; instruction?: string; apply?: boolean; hotfix?: boolean; preview?: boolean } = {},
  ) => {
    if (!logsToAnalyze.length) {
      setError("Select at least one log to analyze");
      return;
    }
    setAgentRunning(true);
    setError("");
    setAgentNotice("");
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: logsToAnalyze, instruction: options.instruction ?? "", format: agentMarkdown ? "markdown" : "summary", apply: options.apply ?? false, hotfix: options.hotfix ?? false, preview: options.preview ?? false }),
      });
      const body = await responseBody(response) as { error?: string; runId?: string; report?: string; branch?: string; plannedBranch?: string; commitMessage?: string; changes?: Array<{ path: string; commit: string }>; previews?: Array<{ path: string; reason: string; diff: string }>; hotfix?: boolean };
      if (!response.ok || !body.report || !body.runId) throw new Error(body.error || `CrewAI agent returned HTTP ${response.status}`);
      setAgentResult({ runId: body.runId, report: body.report, branch: body.branch, plannedBranch: body.plannedBranch, commitMessage: body.commitMessage, changes: body.changes, previews: body.previews, hotfix: body.hotfix });
      setAgentResultKind(options.kind || "analysis");
      setAgentSourceLogs(logsToAnalyze);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAgentRunning(false);
    }
  };

  const saveAgentResult = async (kind: "analysis" | "solution") => {
    if (!agentResult) return;
    setError("");
    setAgentNotice("");
    try {
      const response = await fetch("/api/agent/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: agentResult.runId, report: agentResult.report, kind }),
      });
      const body = await responseBody(response) as { error?: string; branch?: string; saved?: string };
      if (!response.ok) throw new Error(body.error || `Save returned HTTP ${response.status}`);
      setAgentNotice(kind === "solution" ? `Solution registered in CHANGELOGS.md${body.branch ? ` on ${body.branch}` : ""}` : "Analysis saved to internal history");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applySolution = (hotfix: boolean) => runAgent(agentSourceLogs, {
    kind: "solution",
    apply: true,
    hotfix,
    preview: true,
    instruction: `Apply the diagnosed correction exactly when supported by the code. The tool reason and Git commit message must be concise English describing what the fix resolves. Keep the final report brief. Diagnosis: ${agentResult?.report || ""}`,
  });

  const commitPreview = async (hotfix: boolean) => {
    if (!agentResult?.previews?.length) return;
    setAgentRunning(true);
    setError("");
    try {
      const response = await fetch("/api/agent/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: agentResult.runId, hotfix, commitMessage: agentResult.commitMessage }),
      });
      const body = await responseBody(response) as { error?: string; branch?: string; changes?: Array<{ path: string; commit: string }> };
      if (!response.ok || !body.branch) throw new Error(body.error || `Commit returned HTTP ${response.status}`);
      setAgentResult((current) => current ? { ...current, branch: body.branch, changes: body.changes, hotfix } : current);
      setAgentNotice(`Fix committed on ${body.branch}`);
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
      {needsLogin ? (
        <form className="login" onSubmit={login}>
          <strong>admin authentication required</strong>
          <input type="email" placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <input type="password" placeholder="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button type="submit" disabled={loggingIn}>{loggingIn ? "authenticating..." : "sign in"}</button>
        </form>
      ) : null}
      <section className="filters">
        <b className="log-total" title="Visible errors">{logs.length}</b>
        <button className="icon-control" title="Refresh" aria-label="Refresh" onClick={() => void refresh()}><Icon name="refresh" /></button>
        <button className="icon-control" title="Reset filters" aria-label="Reset filters" onClick={resetFilters}><Icon name="reset" /></button>
        <button className="icon-control download" title="Download and clear visible logs" aria-label="Download and clear visible logs" onClick={() => void download()}><Icon name="download" /></button>
        <span className="filter-spacer" aria-hidden="true" />
        <input aria-label="From date" title="From date" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
        <input aria-label="To date" title="To date" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
        <select aria-label="Source" title="Source" value={actor} onChange={(event) => setActor(event.target.value)}><option value="all">all sources</option><option value="worker">workers</option><option value="ui">ui/users</option></select>
        <select aria-label="Worker" title="Worker" value={worker} onChange={(event) => setWorker(event.target.value)}><option value="">all workers</option>{workers.map((id) => <option key={id}>{id}</option>)}</select>
        <select aria-label="Container" title="Container" value={container} onChange={(event) => setContainer(event.target.value)}><option value="">all containers</option>{containers.map((id) => <option key={id}>{id}</option>)}</select>
      </section>
      <section className="agent-controls">
        <span className="selection-total" title="Selected logs">{selectedLogs.length}/{logs.length}</span>
        <button className={`icon-control ${agentMarkdown ? "is-active" : ""}`} title="Generar reporte en formato Markdown" aria-label="Generar reporte en formato Markdown" onClick={() => setAgentMarkdown((value) => !value)}><span className="md-icon">MD</span></button>
        <button className="icon-control" title="Seleccionar todos los logs" aria-label="Seleccionar todos los logs" disabled={!logs.length} onClick={() => setSelectedLogIds(new Set(logs.map((log) => log.id)))}><Icon name="select" /></button>
        <button className="icon-control" title="Quitar la selección" aria-label="Quitar la selección" disabled={!selectedLogIds.size} onClick={() => setSelectedLogIds(new Set())}><Icon name="clear" /></button>
        <button className="icon-control primary-control" title="Analizar los logs seleccionados sin modificar código" data-tooltip="Analizar · no hace commit" aria-label="Analizar sin modificar código" disabled={agentRunning || !selectedLogs.length || needsLogin} onClick={() => void runAgent()}><Icon name="analyze" /></button>
      </section>
      {error ? <p className="error">ERROR {error}</p> : null}
      {agentNotice ? <p className="agent-notice">{agentNotice}</p> : null}
      {agentResult ? (
        <section className="agent-report">
          <header>
            <button className="icon-control" title="Download report" aria-label="Download report" onClick={downloadAgentReport}><Icon name="download" /></button>
            {agentResultKind === "analysis" ? <button className="icon-control" title="Save analysis" aria-label="Save analysis" onClick={() => void saveAgentResult("analysis")}><Icon name="save" /></button> : null}
            {!agentResult.branch && !agentResult.previews?.length ? <button className="result-action agent-apply-button" title="Prepara el cambio exacto para revisarlo antes del commit" aria-label="Preparar el fix para revisión" disabled={agentRunning} onClick={() => void applySolution(false)}><Icon name="apply" /><span>Preparar fix</span></button> : null}
            {!agentResult.branch && !agentResult.previews?.length ? <button className="result-action hotfix-control" title="Prepara un hotfix de un archivo para revisarlo antes del commit" aria-label="Preparar el hotfix para revisión" disabled={agentRunning} onClick={() => void applySolution(true)}><Icon name="hotfix" /><span>Preparar hotfix</span></button> : null}
            {!agentResult.branch && agentResult.previews?.length && !agentResult.hotfix ? <button className="result-action agent-apply-button" title={`Confirma exactamente el diff mostrado en ${agentResult.plannedBranch}`} aria-label="Confirmar el fix mostrado en la rama indicada" disabled={agentRunning || !agentResult.commitMessage?.trim()} onClick={() => void commitPreview(false)}><Icon name="apply" /><span>Confirmar commit</span></button> : null}
            {!agentResult.branch && agentResult.previews?.length === 1 && agentResult.hotfix ? <button className="result-action hotfix-control" title={`Confirma exactamente el diff mostrado directamente en ${agentResult.plannedBranch}`} aria-label="Confirmar el hotfix mostrado en main" disabled={agentRunning || !agentResult.commitMessage?.trim()} onClick={() => void commitPreview(true)}><Icon name="hotfix" /><span>Confirmar hotfix</span></button> : null}
            <strong>{agentResultKind} · {agentResult.runId}</strong>
            <span>{agentResult.branch ? `branch=${agentResult.branch}` : agentResult.previews?.length ? `target=${agentResult.plannedBranch} · pending confirmation` : "analysis-only"}</span>
          </header>
          <pre><code>{agentResult.report}</code></pre>
          {agentResult.previews?.length ? <div className="change-preview">
            <div className="commit-preview-meta">
              <label>Rama destino <code>{agentResult.plannedBranch}</code></label>
              <label>Mensaje del commit <input maxLength={120} value={agentResult.commitMessage || ""} onChange={(event) => setAgentResult((current) => current ? { ...current, commitMessage: event.target.value } : current)} /></label>
              <small>No se enviará nada hasta confirmar.</small>
            </div>
            {agentResult.previews.map((preview) => <section key={preview.path}>
              <strong>{preview.path}</strong>
              <small>{preview.reason}</small>
              <pre><code>{preview.diff}</code></pre>
            </section>)}
          </div> : null}
          {agentResult.changes?.length ? <small>changes: {agentResult.changes.map((change) => `${change.path}@${change.commit.slice(0, 8)}`).join(", ")}</small> : null}
        </section>
      ) : null}
      <section className="terminal">
        <div className="log-table-header" aria-hidden="true">
          <span />
          <span>Fecha</span>
          <span>Componente · función</span>
          <span>Acción</span>
          <span>Error</span>
          <span>Rev.</span>
        </div>
        {logs.length ? logs.map((log) => (
          <article className={`${selectedLogIds.has(log.id) ? "is-selected" : ""} ${expandedLogIds.has(log.id) ? "is-expanded" : ""}`} key={log.id}>
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
              <button className="icon-control" title="Analyze this log" aria-label="Analyze this log" disabled={agentRunning || needsLogin} onClick={() => void runAgent([log])}><Icon name="analyze" /></button>
              <button
                className="icon-control expand-control"
                title={expandedLogIds.has(log.id) ? "Hide details" : "Show details"}
                aria-label={expandedLogIds.has(log.id) ? "Hide log details" : "Show log details"}
                aria-expanded={expandedLogIds.has(log.id)}
                onClick={() => setExpandedLogIds((current) => {
                  const next = new Set(current);
                  if (next.has(log.id)) next.delete(log.id); else next.add(log.id);
                  return next;
                })}
              ><Icon name="expand" /></button>
            </div>
            <time title={new Date(log.createdAt).toISOString()}>{new Date(log.createdAt).toLocaleString()}</time>
            <strong className="log-source" title={`${log.actorType === "worker" ? log.actorLabel || log.actorId : "web"} · ${log.runtime}:${log.functionName}`}>
              <span>{log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}</span>
              <small>{log.runtime}:{log.functionName}</small>
            </strong>
            <span className="log-action" title={log.action}>{log.action}</span>
            <code className="log-preview" title={String(log.message)}>{String(log.message)}</code>
            <small className="analysis-count" title={log.lastAnalyzedAt ? `Última revisión ${new Date(log.lastAnalyzedAt).toLocaleString()}` : "Sin revisar"}>{log.analyzed ? `${log.analysisCount || 1}×` : "—"}</small>
            {expandedLogIds.has(log.id) ? <div className="log-details">
              <pre className="log-code"><code>{formattedCode(log.message)}</code></pre>
              <small>
                component={log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}
                {" user="}{log.userEmail || log.actorEmail || log.userId || (log.actorType === "ui" ? log.actorId : "unknown")}
                {" source="}{log.source}
              </small>
              <pre><code>{formattedCode(log.context || {})}</code></pre>
            </div> : null}
          </article>
        )) : <p className="empty">-- no application errors stored --</p>}
      </section>
    </main>
  );
}
