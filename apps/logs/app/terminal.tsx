"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppLog } from "@/lib/logs";

function formattedCode(value: unknown) {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return value; }
  }
  return value;
}

export function LogsTerminal() {
  const [logs, setLogs] = useState<AppLog[]>([]), [error, setError] = useState("");
  const [actor, setActor] = useState("all"), [worker, setWorker] = useState(""), [container, setContainer] = useState("");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const query = useCallback(() => { const p = new URLSearchParams({ actor, from: String(from ? new Date(from).getTime() : 0), to: String(to ? new Date(to).getTime() : Number.MAX_SAFE_INTEGER) }); if (worker) p.set("worker", worker); if (container) p.set("container", container); return p; }, [actor, worker, container, from, to]);
  const refresh = useCallback(async () => { try { const response = await fetch(`/api/logs?${query()}`, { cache: "no-store" }); const text = await response.text(); let body: { error?: string; logs?: AppLog[] } = {}; try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Logs API returned HTTP ${response.status} with a non-JSON response`); } if (!response.ok) throw new Error(body.error || `Logs API returned HTTP ${response.status}`); setLogs(body.logs || []); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }, [query]);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  const workers = useMemo(() => [...new Set(logs.filter((log) => log.actorType === "worker").map((log) => log.actorId))].sort(), [logs]);
  const containers = useMemo(() => [...new Set(logs.map((log) => log.context?.containerId || "").filter(Boolean))].sort(), [logs]);
  const download = async () => { const response = await fetch(`/api/logs/drain?${query()}`, { method: "POST" }); if (!response.ok) { setError(await response.text()); return; } const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "app-logs.logs"; link.click(); URL.revokeObjectURL(url); await refresh(); };
  const resetFilters = () => { setActor("all"); setWorker(""); setContainer(""); setFrom(""); setTo(""); };
  return <main><header><div><span className="prompt">root@docker-panel:~$</span><h1>error-log console</h1></div><div><b>{logs.length}</b> errors</div></header><section className="filters"><label>from (empty = all)<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>to (empty = live)<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label><label>source<select value={actor} onChange={(e) => setActor(e.target.value)}><option value="all">all</option><option value="worker">workers</option><option value="ui">ui/users</option></select></label><label>worker<select value={worker} onChange={(e) => setWorker(e.target.value)}><option value="">all workers</option>{workers.map((id) => <option key={id}>{id}</option>)}</select></label><label>container<select value={container} onChange={(e) => setContainer(e.target.value)}><option value="">all containers</option>{containers.map((id) => <option key={id}>{id}</option>)}</select></label><button onClick={() => void refresh()}>refresh</button><button onClick={resetFilters}>reset filters</button><button className="download" onClick={() => void download()}>download + clear</button></section>{error ? <p className="error">ERROR {error}</p> : null}<section className="terminal">{logs.length ? logs.map((log) => <article key={log.id}><time>{new Date(log.createdAt).toLocaleString()}</time><strong>{log.runtime}:{log.functionName}</strong><span>[{log.action}]</span><pre className="log-code"><code>{formattedCode(log.message)}</code></pre><div className="log-context"><small>{log.actorType}={log.actorLabel || log.actorEmail || log.actorId} source={log.source}</small><pre><code>{formattedCode(log.context || {})}</code></pre></div></article>) : <p className="empty">-- no application errors stored --</p>}</section></main>;
}
