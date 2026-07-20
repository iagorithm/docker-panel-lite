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

export type Deployment = {
  id: string;
  repositoryId: string;
  containerId?: string;
  action: string;
  status: string;
  progress: number;
  workerId?: string;
  message?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
};

export type Agent = {
  id: string;
  status: "online" | "offline" | "draining";
  hostname: string;
  activeJobs: number;
  maxConcurrency: number;
  lastHeartbeat: number;
};

export type ManagedContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  project: string;
  ports: string[];
  logTail?: string;
  updatedAt: number;
};
