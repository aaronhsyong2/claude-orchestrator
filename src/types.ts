export interface VerifyCommand {
	readonly name: string;
	readonly command: string;
}

export type IssueSourceType = 'github' | 'linear' | 'jira';

export interface IssueSource {
	readonly type: IssueSourceType;
	readonly repo: string;
}

export interface NotificationConfig {
	readonly system: boolean;
}

export interface OrchestratorConfig {
	readonly base_branch: string;
	readonly max_concurrent_agents: number;
	readonly max_retries_on_fail: number;
	readonly max_review_cycles: number;
	readonly verify: readonly VerifyCommand[];
	readonly rule_files: readonly string[];
	readonly issue_source: IssueSource;
	readonly notifications: NotificationConfig;
}

export type AgentState = 'queued' | 'in_progress' | 'done' | 'failed';

export interface StatusEntry {
	readonly slug: string;
	readonly state: AgentState;
	readonly issues_total: number;
	readonly issues_done: number;
}
