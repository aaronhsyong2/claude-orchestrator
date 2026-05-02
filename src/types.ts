export interface VerifyCommand {
	readonly name: string;
	readonly command: string;
}

export interface StepResult {
	readonly name: string;
	readonly command: string;
	readonly exitCode: number;
	readonly duration: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface VerifyResult {
	readonly success: boolean;
	readonly failedStep?: string;
	readonly error?: string;
	readonly steps: readonly StepResult[];
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

export type PRGroupStatus = 'pending' | 'in-progress' | 'done' | 'merged';

export interface IssueRef {
	readonly number: number;
	readonly title: string;
	readonly status: string;
	readonly blocked_by: readonly number[];
}

export type IssueFetcher = (issueNumber: number) => Promise<string>;

export interface PRGroup {
	readonly pr_number: number;
	readonly title: string;
	readonly branch: string;
	readonly status: PRGroupStatus;
	readonly issues: readonly IssueRef[];
	readonly depends_on: readonly number[];
}

export interface PlanData {
	readonly title: string;
	readonly groups: readonly PRGroup[];
}

export interface DependencyGraph {
	readonly adjacency: ReadonlyMap<number, readonly number[]>;
	readonly order: readonly number[];
}

export interface StatusEntry {
	readonly slug: string;
	readonly state: AgentState;
	readonly issues_total: number;
	readonly issues_done: number;
}

export type GroupStep = 'idle' | 'cloning' | 'coding' | 'verifying' | 'reviewing' | 'merging';

export interface GroupStatus {
	readonly pr_group: string;
	readonly branch: string;
	readonly current_issue: number | null;
	readonly step: GroupStep;
	readonly step_result: string;
	readonly issues_completed: readonly number[];
	readonly issues_remaining: readonly number[];
	readonly blocked: boolean;
	readonly needs_input: boolean;
	readonly last_updated: string;
}

export interface GitBranchState {
	readonly branches: readonly string[];
	readonly branchHasCommits: ReadonlyMap<string, boolean>;
}

export interface ReconcileCorrection {
	readonly slug: string;
	readonly reason: string;
}

export interface WorktreeInfo {
	readonly branch: string;
	readonly worktreePath: string;
}

// --- Scheduler types ---

export interface SchedulerDeps {
	readonly createWorktree: (branch: string, baseBranch?: string) => WorktreeInfo;
	readonly removeWorktree: (branch: string) => void;
	readonly spawnWorker: (
		issue: string,
		groupSlug: string,
		worktreePath: string,
		onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
		contextContent?: string,
	) => WorkerHandle;
	readonly killWorker: (pid: number) => Promise<void>;
	readonly verify: (cwd: string, commands: readonly VerifyCommand[]) => Promise<VerifyResult>;
	readonly readGroupStatus: (groupSlug: string) => GroupStatus | null;
	readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
	readonly readContext: (groupSlug: string, issue: string) => string | null;
	readonly deleteContext: (groupSlug: string, issue: string) => void;
}

export interface GroupResult {
	readonly pr_number: number;
	readonly branch: string;
	readonly completed: boolean;
	readonly failedIssue?: number;
	readonly error?: string;
}

export interface AssignWorkResult {
	readonly assigned: number;
	readonly results: readonly GroupResult[];
}

// --- Worker Manager types ---

export interface NdjsonSystemMessage {
	readonly type: 'system';
	readonly subtype: string;
	readonly session_id: string;
}

export interface NdjsonAssistantMessage {
	readonly type: 'assistant';
	readonly message: unknown;
}

export interface NdjsonResultMessage {
	readonly type: 'result';
	readonly result: string;
	readonly is_error: boolean;
}

export type NdjsonMessage = NdjsonSystemMessage | NdjsonAssistantMessage | NdjsonResultMessage;

export type WorkerEventType = 'spawned' | 'message' | 'error' | 'exited';

export interface WorkerHandle {
	readonly id: string;
	readonly issue: string;
	readonly groupSlug: string;
	readonly pid: number;
}
