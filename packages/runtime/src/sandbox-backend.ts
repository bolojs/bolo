export interface SandboxRunResult {
  result?: string;
  error?: string;
}

export interface SandboxBackend {
  run(code: string): Promise<SandboxRunResult>;
  dispose(): void;
}
