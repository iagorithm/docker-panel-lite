export default function AppLoading() {
  return <main className="app-initial-loading" role="status" aria-live="polite" aria-label="Opening Docker Panel Lite">
    <div className="app-initial-loading-content">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span className="app-initial-spinner" aria-hidden="true" />
      <div>
        <strong>Docker Panel Lite</strong>
        <small>Opening application…</small>
      </div>
    </div>
  </main>;
}
