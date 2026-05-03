export interface ActivityEvent {
	readonly id: number;
	readonly timestamp: string;
	readonly message: string;
}

export type StatusIconChar = '\u2713' | '\u2699' | '\u23F8' | '\u26A0' | '\u00B7';

export type ScreenMode = 'normal' | 'half' | 'full';
export type OverlayMode = 'none' | 'deps' | 'logs';
