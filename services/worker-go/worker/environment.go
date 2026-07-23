package main

// CompiledEnvironment is the Go worker configuration baked into the binary.
//
// Edit the values below before building the Go worker. Unlike the Python
// worker, the Go worker intentionally does not read configuration from process
// environment variables or .env files at runtime.
//
// Never commit production credentials to a public repository. Build production
// binaries from a private copy of this file and publish the resulting image to
// a private registry.
type CompiledEnvironment struct {
	FirebaseDatabaseURL string
	ServiceAccountJSON  string
	WorkspaceID         string
	PoolID              string
	WorkerID            string
	WorkerMachineID     string
	WorkerToken         string
	WorkerLabel         string
	WorkerLocation      string
	WorkerShards        []string
	QueueShardCount     int
	MaxConcurrency      int
	LeaseSeconds        int
	PollSeconds         int
	CloneDir            string
	DataDir             string
	EncryptionKey       string
	NgrokEnabled        bool
	NgrokAuthtoken      string
	NgrokBin            string
	NgrokRegion         string
}

var Environment = CompiledEnvironment{
	FirebaseDatabaseURL: "",
	ServiceAccountJSON:  "",
	WorkspaceID:         "default",
	PoolID:              "default",
	WorkerID:            "",
	WorkerMachineID:     "",
	WorkerToken:         "",
	WorkerLabel:         "",
	WorkerLocation:      "",
	WorkerShards:        nil,
	QueueShardCount:     16,
	MaxConcurrency:      2,
	LeaseSeconds:        90,
	PollSeconds:         5,
	CloneDir:            "/app/clones",
	DataDir:             "/app/data",
	EncryptionKey:       "",
	NgrokEnabled:        false,
	NgrokAuthtoken:      "",
	NgrokBin:            "ngrok",
	NgrokRegion:         "",
}
