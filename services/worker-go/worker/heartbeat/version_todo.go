package heartbeat

// WorkerVersion is reported in every heartbeat.
//
// TODO: Set this variable at build time from an immutable release tag or Git
// SHA, for example with -ldflags "-X
// docker-panel-lite-worker-go/worker/heartbeat.WorkerVersion=v1.2.3". Local
// development builds intentionally keep the value "dev".
var WorkerVersion = "dev"
