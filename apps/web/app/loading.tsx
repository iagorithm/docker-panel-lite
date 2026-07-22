export default function AppLoading() {
  return <main className="app-initial-loading" role="status" aria-live="polite" aria-label="Opening worqer.app">
    <div className="app-initial-loading-content">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span className="app-initial-spinner" aria-hidden="true" />
      <div>
        <strong>worqer.app</strong>
        <small>Opening application…</small>
      </div>
    </div>
  </main>;
}
