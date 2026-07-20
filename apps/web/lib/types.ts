export type Repository = {
  id: string;
  alias: string;
  url: string;
  branch: string;
  mode: "compose" | "dockerfile";
  composeFile: string;
  dockerfile: string;
  credentialId: string;
  environment: Record<string, string>;
  domain: string;
  service: string;
  internalPort: number;
  ports?: string;
  poolId: string;
  availableBranches?: string[];
  composeContent?: string;
  createdAt: number;
  updatedAt: number;
};

export type CredentialSummary = {
  id: string;
  alias: string;
  username: string;
  tokenMask: string;
  updatedAt: number;
};

export type CommandPreset = {
  id: string;
  name: string;
  description?: string;
  command: string;
  createdAt: number;
  updatedAt: number;
};

export type Deployment = {
  id: string;
  repositoryId: string;
  containerId?: string;
  containerRef?: string;
  action: string;
  status: string;
  progress: number;
  workerId?: string;
  targetWorkerId?: string;
  message?: string;
  command?: string;
  commandOutput?: string;
  commandExitCode?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  leaseExpiresAt?: number;
};

export type Agent = {
  id: string;
  identitySource?: string;
  status: "online" | "offline" | "draining" | "stopping";
  label?: string;
  hostname: string;
  location?: string;
  poolId?: string;
  activeJobs: number;
  maxConcurrency: number;
  shards?: string[];
  lastHeartbeat: number;
  startedAt?: number;
  stoppingAt?: number;
  pid?: number;
  pythonVersion?: string;
  platform?: string;
  system?: string;
  machine?: string;
  executable?: string;
  cloneDir?: string;
  dataDir?: string;
  traefikEnabled?: boolean;
  traefikNetwork?: string;
  leaseSeconds?: number;
  pollSeconds?: number;
  docker?: {
    available?: boolean;
    serverVersion?: string;
    apiVersion?: string;
    os?: string;
    architecture?: string;
    containers?: number;
    containersRunning?: number;
    images?: number;
    error?: string;
  };
};

export type ManagedContainer = {
  id: string;
  dockerId?: string;
  name: string;
  image: string;
  status: string;
  project: string;
  ports: string[];
  workerId?: string;
  workerLabel?: string;
  workerHostname?: string;
  poolId?: string;
  logTail?: string;
  createdAt?: number;
  lastSeenAt?: number;
  missingSince?: number;
  updatedAt: number;
};
