export interface QuickAction {
  label: string;
  command: string;
  args: string[];
  reason?: string;
}

export interface Scenario {
  id: string;
  label: string;
  description?: string;
  files: {
    "package.json": string;
    "index.ts": string;
  };
  quickActions: QuickAction[];
  servesHttp: boolean;
}
