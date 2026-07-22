"use client";

import { FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useState } from "react";
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

function formattedDate(value: number) {
  return new Date(value).toLocaleString("sv-SE", { hour12: false });
}

type DiffRow = { oldNumber: number | null; newNumber: number | null; oldText: string; newText: string; oldKind?: "removed"; newKind?: "added"; hunk?: string };

function parseSplitDiff(diff: string): DiffRow[] {
  const lines = diff.split("\n");
  const rows: DiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      inHunk = true;
      rows.push({ oldNumber: null, newNumber: null, oldText: "", newText: "", hunk: line });
      index += 1;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) { index += 1; continue; }
    if (line.startsWith(" ")) {
      rows.push({ oldNumber, newNumber, oldText: line.slice(1), newText: line.slice(1) });
      oldNumber += 1;
      newNumber += 1;
      index += 1;
      continue;
    }
    if (line.startsWith("-") || line.startsWith("+")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (index < lines.length && (lines[index].startsWith("-") || lines[index].startsWith("+"))) {
        if (lines[index].startsWith("-")) removed.push(lines[index].slice(1));
        else added.push(lines[index].slice(1));
        index += 1;
      }
      const count = Math.max(removed.length, added.length);
      for (let offset = 0; offset < count; offset += 1) {
        const oldText = removed[offset] ?? "";
        const newText = added[offset] ?? "";
        rows.push({
          oldNumber: offset < removed.length ? oldNumber++ : null,
          newNumber: offset < added.length ? newNumber++ : null,
          oldText,
          newText,
          oldKind: offset < removed.length ? "removed" : undefined,
          newKind: offset < added.length ? "added" : undefined,
        });
      }
      continue;
    }
    index += 1;
  }
  return rows;
}

function SplitDiff({ diff }: { diff: string }) {
  const rows = parseSplitDiff(diff);
  return <div className="split-diff">
    <div className="diff-panel-title old-title">Previous code</div>
    <div className="diff-panel-title new-title">Proposed code</div>
    {rows.map((row, index) => row.hunk ? (
      <div className="diff-hunk" key={`hunk-${index}`}>{row.hunk}</div>
    ) : (
      <div className="diff-row" key={`line-${index}`}>
        <div className={`diff-cell ${row.oldKind || ""}`}><span className="diff-number">{row.oldNumber ?? ""}</span><code>{row.oldText}</code></div>
        <div className={`diff-cell ${row.newKind || ""}`}><span className="diff-number">{row.newNumber ?? ""}</span><code>{row.newText}</code></div>
      </div>
    ))}
  </div>;
}

type IconName = "refresh" | "reset" | "download" | "select" | "clear" | "analyze" | "save" | "solution" | "apply" | "expand" | "hotfix" | "commit";

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
    {name === "commit" ? <path {...common} d="M12 3v5m0 8v5M8 12H3m18 0h-5M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z" /> : null}
  </svg>;
}

type AgentFix = {
  id: string; runId: string; repository: string; baseBranch: string;
  targetBranch: string; commitSha: string; commitMessage: string; hotfix: boolean;
  requestedBy: string; requestedByEmail?: string; report: string;
  changes: Array<{ path: string; commit: string; reason?: string }>;
  logIds: string[]; createdAt: number; reapplicable: boolean;
};

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
  const [agentFixes, setAgentFixes] = useState<Map<string, AgentFix>>(() => new Map());
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [agentMarkdown, setAgentMarkdown] = useState(true);
  const [agentRunning, setAgentRunning] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"fix" | "hotfix" | null>(null);
  const [commitTarget, setCommitTarget] = useState<"branch" | "hotfix">("branch");
  const [analyzingLogIds, setAnalyzingLogIds] = useState<Set<string>>(() => new Set());
  const [agentResult, setAgentResult] = useState<{ runId: string; report: string; branch?: string; baseBranch?: string; plannedBranch?: string; commitMessage?: string; changes?: Array<{ path: string; commit: string }>; previews?: Array<{ path: string; reason: string; diff: string }>; hotfix?: boolean } | null>(null);
  const [agentResultKind, setAgentResultKind] = useState<"analysis" | "solution">("analysis");
  const [agentTab, setAgentTab] = useState<"problem" | "preview">("problem");
  const [agentSourceLogs, setAgentSourceLogs] = useState<AppLog[]>([]);
  const [agentNotice, setAgentNotice] = useState("");
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(() => new Set());
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(() => new Set());
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [occurrencePanelHeight, setOccurrencePanelHeight] = useState(170);
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
      try {
        const fixesResponse = await fetch("/api/agent/fixes?limit=500", { cache: "no-store" });
        const fixesBody = await responseBody(fixesResponse) as { fixes?: AgentFix[] };
        if (fixesResponse.ok) setAgentFixes(new Map((fixesBody.fixes || []).map((fix) => [fix.id, fix])));
      } catch {
        // Agent history is auxiliary; log browsing must remain available if it is offline.
      }
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
  const logGroups = useMemo(() => {
    const grouped = new Map<string, AppLog[]>();
    for (const log of logs) {
      const key = [log.actorType, log.actorId, log.runtime, log.functionName, log.action, String(log.message).trim()].join("\u001f");
      grouped.set(key, [...(grouped.get(key) || []), log]);
    }
    return [...grouped.entries()].map(([key, occurrences]) => ({ key, occurrences, log: occurrences[0] }));
  }, [logs]);
  const selectedGroup = useMemo(() => logGroups.find((group) => group.key === selectedGroupKey) || null, [logGroups, selectedGroupKey]);

  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = occurrencePanelHeight;
    const move = (moveEvent: PointerEvent) => setOccurrencePanelHeight(Math.max(90, Math.min(window.innerHeight * .65, startHeight + startY - moveEvent.clientY)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const runAgent = async (
    logsToAnalyze: AppLog[] = selectedLogs,
    options: { kind?: "analysis" | "solution"; instruction?: string; apply?: boolean; hotfix?: boolean; preview?: boolean } = {},
  ) => {
    if (!logsToAnalyze.length) {
      setError("Select at least one log to analyze");
      return;
    }
    setAgentRunning(true);
    setAnalyzingLogIds(new Set(logsToAnalyze.map((log) => log.id)));
    setError("");
    setAgentNotice("");
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "analyze-and-fix", logs: logsToAnalyze, instruction: options.instruction ?? "", format: agentMarkdown ? "markdown" : "summary", apply: options.apply ?? true, hotfix: options.hotfix ?? false, preview: options.preview ?? true }),
      });
      const body = await responseBody(response) as { error?: string; runId?: string; report?: string; branch?: string; baseBranch?: string; plannedBranch?: string; commitMessage?: string; changes?: Array<{ path: string; commit: string }>; previews?: Array<{ path: string; reason: string; diff: string }>; hotfix?: boolean };
      if (!response.ok || !body.report || !body.runId) throw new Error(body.error || `CrewAI agent returned HTTP ${response.status}`);
      setAgentResult({ runId: body.runId, report: body.report, branch: body.branch, baseBranch: body.baseBranch, plannedBranch: body.plannedBranch, commitMessage: body.commitMessage, changes: body.changes, previews: body.previews, hotfix: body.hotfix });
      setAgentTab("problem");
      setCommitTarget(body.hotfix ? "hotfix" : "branch");
      setAgentResultKind(options.kind || "analysis");
      setAgentSourceLogs(logsToAnalyze);
      setExpandedLogIds((current) => new Set(current).add(logsToAnalyze[0].id));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAgentRunning(false);
      setAnalyzingLogIds(new Set());
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
      const body = await responseBody(response) as { error?: string; branch?: string; fixId?: string; fix?: AgentFix; changes?: Array<{ path: string; commit: string }> };
      if (!response.ok || !body.branch) throw new Error(body.error || `Commit returned HTTP ${response.status}`);
      setAgentResult((current) => current ? { ...current, branch: body.branch, changes: body.changes, hotfix } : current);
      if (body.fixId && body.fix) setAgentFixes((current) => new Map(current).set(body.fixId!, body.fix!));
      setAgentNotice(`Fix committed on ${body.branch}`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAgentRunning(false);
    }
  };

  const reapplyFix = async (fix: AgentFix, sourceLogs: AppLog[]) => {
    setAgentRunning(true);
    setPreparingMode(fix.hotfix ? "hotfix" : "fix");
    setError("");
    setAgentNotice("");
    try {
      const response = await fetch("/api/agent/fixes", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixId: fix.id, hotfix: false }),
      });
      const body = await responseBody(response) as { error?: string; runId?: string; report?: string; baseBranch?: string; plannedBranch?: string; commitMessage?: string; previews?: Array<{ path: string; reason: string; diff: string }>; hotfix?: boolean };
      if (!response.ok || !body.runId || !body.previews?.length) throw new Error(body.error || `Reapply returned HTTP ${response.status}`);
      setAgentResult({ runId: body.runId, report: body.report || fix.report, baseBranch: body.baseBranch, plannedBranch: body.plannedBranch, commitMessage: body.commitMessage, previews: body.previews, hotfix: body.hotfix });
      setAgentResultKind("solution");
      setAgentSourceLogs(sourceLogs);
      setAgentTab("preview");
      setCommitTarget(body.hotfix ? "hotfix" : "branch");
      if (sourceLogs[0]) setExpandedLogIds((current) => new Set(current).add(sourceLogs[0].id));
      setAgentNotice(`Reapply prepared from ${fix.id}; review the diff before committing.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAgentRunning(false);
      setPreparingMode(null);
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
        <button className={`icon-control ${agentMarkdown ? "is-active" : ""}`} title="Generate a Markdown report" aria-label="Generate a Markdown report" onClick={() => setAgentMarkdown((value) => !value)}><span className="md-icon">MD</span></button>
        <button className="icon-control" title="Select all logs" aria-label="Select all logs" disabled={!logs.length} onClick={() => setSelectedLogIds(new Set(logs.map((log) => log.id)))}><Icon name="select" /></button>
        <button className="icon-control" title="Clear selection" aria-label="Clear selection" disabled={!selectedLogIds.size} onClick={() => setSelectedLogIds(new Set())}><Icon name="clear" /></button>
        <button className="icon-control primary-control" title="Analyze and prepare a validated fix preview; no commit" data-tooltip="Analyze · prepare preview" aria-label="Analyze and prepare fix preview" disabled={agentRunning || !selectedLogs.length || needsLogin} onClick={() => void runAgent()}><Icon name="analyze" /></button>
      </section>
      {error ? <p className="error">ERROR {error}</p> : null}
      {agentNotice ? <p className="agent-notice">{agentNotice}</p> : null}
      <div className="logs-workspace" style={{ gridTemplateRows: `minmax(180px, 1fr) 5px ${occurrencePanelHeight}px` }}>
      <section className="terminal">
        <div className="log-table-header" aria-hidden="true">
          <span>Sel.</span>
          <span>Date</span>
          <span>Component</span>
          <span>Function</span>
          <span>Action</span>
          <span>Error</span>
          <span>Count</span>
          <span>Status</span>
          <span>Rev.</span>
        </div>
        {logGroups.length ? logGroups.map(({ key, occurrences, log }) => (
          <article
            className={`${occurrences.every((item) => selectedLogIds.has(item.id)) ? "is-selected" : ""} ${expandedLogIds.has(log.id) ? "is-expanded" : ""} ${selectedGroupKey === key ? "is-group-active" : ""}`}
            key={key}
            title={expandedLogIds.has(log.id) ? "Click to hide details" : "Click to show details"}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input, a, label, .agent-report")) return;
              setSelectedGroupKey(key);
              setExpandedLogIds((current) => {
                const next = new Set(current);
                if (next.has(log.id)) next.delete(log.id); else next.add(log.id);
                return next;
              });
            }}
          >
            <div className="log-selection">
              <input
                type="checkbox"
                checked={occurrences.every((item) => selectedLogIds.has(item.id))}
                aria-label={`Select all ${occurrences.length} occurrences of ${log.action}`}
                onChange={(event) => setSelectedLogIds((current) => {
                  const next = new Set(current);
                  for (const occurrence of occurrences) {
                    if (event.target.checked) next.add(occurrence.id); else next.delete(occurrence.id);
                  }
                  return next;
                })}
              />
              <button className="icon-control" title={occurrences.some((item) => analyzingLogIds.has(item.id)) ? "Analyzing this error group" : "Analyze this error group"} aria-label={occurrences.some((item) => analyzingLogIds.has(item.id)) ? "Analyzing this error group" : "Analyze this error group"} disabled={agentRunning || needsLogin} onClick={() => { setSelectedGroupKey(key); void runAgent(occurrences); }}>{occurrences.some((item) => analyzingLogIds.has(item.id)) ? <span className="row-spinner" aria-hidden="true" /> : <Icon name="analyze" />}</button>
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
            <time title={new Date(log.createdAt).toLocaleString()}>{formattedDate(log.createdAt)}</time>
            <strong className="log-component" title={log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}>{log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}</strong>
            <code className="log-function" title={`${log.runtime}:${log.functionName}`}>{log.runtime}:{log.functionName}</code>
            <span className="log-action" title={log.action}>{log.action}</span>
            <code className="log-preview" title={String(log.message)}>{String(log.message)}</code>
            <strong className="occurrence-count" title={`${occurrences.length} occurrences`}>{occurrences.length}</strong>
            <span className={`fix-status ${occurrences.every((item) => item.fixed) ? "is-fixed" : occurrences.some((item) => item.fixed) ? "is-partial" : ""}`} title={occurrences.every((item) => item.fixed) ? `Agent fix ${log.agentFixId || log.fixRunId || "record"} on ${log.fixBranch || "Git"}` : occurrences.some((item) => item.fixed) ? "Some occurrences are fixed" : "Open error"}>{occurrences.every((item) => item.fixed) ? (log.agentFixId ? log.agentFixId.replace("fix_", "").slice(0, 6) : "fixed") : occurrences.some((item) => item.fixed) ? "mixed" : "open"}</span>
            <small className="analysis-count" title={log.lastAnalyzedAt ? `Last review ${new Date(log.lastAnalyzedAt).toLocaleString()}` : "Not reviewed"}>{log.analyzed ? `${log.analysisCount || 1}×` : "—"}</small>
            {expandedLogIds.has(log.id) ? <div className="log-details">
              <pre className="log-code"><code>{formattedCode(log.message)}</code></pre>
              <small>
                component={log.actorType === "worker" ? log.actorLabel || log.actorId : "web"}
                {" user="}{log.userEmail || log.actorEmail || log.userId || (log.actorType === "ui" ? log.actorId : "unknown")}
                {" source="}{log.source}
              </small>
              <pre><code>{formattedCode(log.context || {})}</code></pre>
              {occurrences.map((item) => item.agentFixId).filter((id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index).map((fixId) => {
                const fix = agentFixes.get(fixId);
                return <section className="agent-fix-record" key={fixId}>
                  <header><Icon name="commit" /><strong>{fixId}</strong>{fix ? <><time>{formattedDate(fix.createdAt)}</time><button className="icon-control" title={fix.reapplicable ? "Prepare this exact fix again" : "Reapply unavailable: this record has no safe source snapshot"} aria-label={`Reapply ${fixId}`} disabled={agentRunning || !fix.reapplicable} onClick={() => void reapplyFix(fix, occurrences)}><Icon name="apply" /></button></> : null}</header>
                  {fix ? <div className="agent-fix-grid">
                    <span>Commit</span><code>{fix.commitSha}</code>
                    <span>Branch</span><code>{fix.targetBranch}{fix.hotfix ? " · hotfix" : ""}</code>
                    <span>Message</span><strong>{fix.commitMessage}</strong>
                    <span>Repository</span><code>{fix.repository}</code>
                    <span>Requested by</span><code>{fix.requestedByEmail || fix.requestedBy}</code>
                    <span>Files</span><code>{fix.changes.map((change) => change.path).join(", ")}</code>
                  </div> : <small>Agent record is not available in the local database.</small>}
                </section>;
              })}
            </div> : null}
            {expandedLogIds.has(log.id) && agentResult && agentSourceLogs[0]?.id === log.id ? <section className="agent-report inline-agent-report">
              <header>
                <button className="icon-control" title="Download report" aria-label="Download report" onClick={downloadAgentReport}><Icon name="download" /></button>
                {agentResultKind === "analysis" ? <button className="icon-control" title="Save analysis" aria-label="Save analysis" onClick={() => void saveAgentResult("analysis")}><Icon name="save" /></button> : null}
                <strong>{agentResultKind} · {agentResult.runId}</strong>
                <span>{agentResult.branch ? `branch=${agentResult.branch}` : agentResult.previews?.length ? `code ready · pending commit confirmation` : "analysis-only"}</span>
              </header>
              <div className="agent-report-layout">
                <nav className="report-tabs" aria-label="Analysis result">
                  <button className={agentTab === "problem" ? "is-active" : ""} onClick={() => setAgentTab("problem")}>Problem</button>
                  <button className={agentTab === "preview" ? "is-active" : ""} onClick={() => setAgentTab("preview")}>Git preview</button>
                </nav>
                <div className="report-tab-panel">
                  {agentTab === "problem" ? <pre><code>{agentResult.report}</code></pre> : <>
                    {agentResult.previews?.length ? <div className="change-preview">
                      <div className="commit-preview-meta">
                        <label>Target
                          <select value={commitTarget} disabled={agentRunning} onChange={(event) => setCommitTarget(event.target.value as "branch" | "hotfix")}>
                            <option value="branch">{agentResult.plannedBranch} (new branch)</option>
                            <option value="hotfix" disabled={agentResult.previews.length !== 1}>{agentResult.baseBranch || "main"} (hotfix)</option>
                          </select>
                        </label>
                        <label>Commit message <input maxLength={120} value={agentResult.commitMessage || ""} onChange={(event) => setAgentResult((current) => current ? { ...current, commitMessage: event.target.value } : current)} /></label>
                        <small>Nothing is pushed until you confirm.</small>
                      </div>
                      {agentResult.previews.map((preview) => <section key={preview.path}>
                        <strong>{preview.path}</strong>
                        <small>{preview.reason}</small>
                        <SplitDiff diff={preview.diff} />
                      </section>)}
                      {!agentResult.branch ? <div className="preview-confirm-actions">
                        <button className={`result-action ${commitTarget === "hotfix" ? "hotfix-control" : "agent-apply-button"}`} title={commitTarget === "hotfix" ? `Commit the reviewed diff directly to ${agentResult.baseBranch || "main"}` : `Commit the reviewed diff to ${agentResult.plannedBranch}`} disabled={agentRunning || !agentResult.commitMessage?.trim() || (commitTarget === "hotfix" && agentResult.previews.length !== 1)} onClick={() => void commitPreview(commitTarget === "hotfix")}>{agentRunning ? <span className="row-spinner" aria-hidden="true" /> : <Icon name={commitTarget === "hotfix" ? "hotfix" : "apply"} />}<span>Confirm commit</span></button>
                      </div> : null}
                    </div> : <p className="preview-empty">Prepare a fix from the Problem tab to review its exact Git diff.</p>}
                  </>}
                </div>
              </div>
              {agentResult.changes?.length ? <small>changes: {agentResult.changes.map((change) => `${change.path}@${change.commit.slice(0, 8)}`).join(", ")}</small> : null}
            </section> : null}
          </article>
        )) : <p className="empty">-- no application errors stored --</p>}
      </section>
      <div className="panel-resizer" role="separator" aria-label="Resize error and occurrence panels" aria-orientation="horizontal" onPointerDown={startPanelResize}><span /></div>
      <section className="occurrences-panel">
        <header>
          <strong>{selectedGroup ? `${selectedGroup.occurrences.length} occurrences` : "Occurrences"}</strong>
          <span>{selectedGroup ? selectedGroup.log.action : "Select an error row"}</span>
        </header>
        <div className="occurrence-table">
          <div className="occurrence-header"><span>When</span><span>Where</span><span>Function</span><span>User</span><span>Source</span><span>Agent fix</span></div>
          {selectedGroup ? selectedGroup.occurrences.map((occurrence) => <div className="occurrence-row" key={occurrence.id}>
            <time>{formattedDate(occurrence.createdAt)}</time>
            <strong>{occurrence.actorType === "worker" ? occurrence.actorLabel || occurrence.actorId : "web"}</strong>
            <code>{occurrence.runtime}:{occurrence.functionName}</code>
            <span>{occurrence.userEmail || occurrence.actorEmail || occurrence.userId || "unknown"}</span>
            <span>{occurrence.context?.containerId || occurrence.source || "—"}</span>
            <code title={occurrence.agentFixId || "No fix record"}>{occurrence.agentFixId ? occurrence.agentFixId.replace("fix_", "").slice(0, 8) : "—"}</code>
          </div>) : <p className="empty">Select a grouped error to view its ungrouped history.</p>}
        </div>
      </section>
      </div>
    </main>
  );
}
