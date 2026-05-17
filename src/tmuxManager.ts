import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { RemoteConfig } from './types';
import { buildSshCommand, normalizeRemoteId, shellQuote } from './remoteUtils';

export interface TmuxSession {
    /** Session name */
    name: string;
    /** Working directory of the active pane */
    path: string;
    /** Number of windows in session */
    windowCount: number;
    /** Whether session is attached */
    attached: boolean;
    /** Creation timestamp */
    created: Date;
    /** Remote target ID that owns this session */
    remoteId?: string;
    /** Remote display label */
    remoteLabel?: string;
}

export class TmuxManager {
    /**
     * Check if tmux is available
     */
    static isAvailable(): boolean {
        try {
            if (this.shouldUseLocalCommand()) {
                execSync('which tmux', { encoding: 'utf8', stdio: 'pipe' });
            } else if (process.platform === 'win32') {
                execSync('wsl.exe -e which tmux', { encoding: 'utf8', stdio: 'pipe' });
            } else {
                execSync('which tmux', { encoding: 'utf8', stdio: 'pipe' });
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get all tmux sessions with their working directories
     */
    static getSessions(remote?: RemoteConfig): TmuxSession[] {
        try {
            // Format: session_name:pane_current_path:window_count:session_attached:session_created
            const format = '#{session_name}\t#{pane_current_path}\t#{session_windows}\t#{session_attached}\t#{session_created}';
            let output: string;

            if (remote?.type === 'ssh') {
                output = execSync(buildSshCommand(remote, `tmux list-sessions -F ${shellQuote(format)} 2>/dev/null || true`, false), {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 5000
                });
            } else if (this.shouldUseLocalCommand()) {
                output = execSync(`tmux list-sessions -F "${format}" 2>/dev/null || true`, {
                    encoding: 'utf8',
                    stdio: 'pipe'
                });
            } else if (process.platform === 'win32') {
                // On Windows, run through WSL
                output = execSync(`wsl.exe -e bash -c "tmux list-sessions -F '${format}' 2>/dev/null || true"`, {
                    encoding: 'utf8',
                    stdio: 'pipe'
                });
            } else {
                // Native Linux/macOS
                output = execSync(`tmux list-sessions -F "${format}" 2>/dev/null || true`, {
                    encoding: 'utf8',
                    stdio: 'pipe'
                });
            }

            if (!output.trim()) {
                return [];
            }

            const remoteId = normalizeRemoteId(remote?.id);
            return output.trim().split('\n').map(line => {
                const [name, path, windowCount, attached, created] = line.split('\t');
                return {
                    name: name || 'unnamed',
                    path: path || '~',
                    windowCount: parseInt(windowCount) || 1,
                    attached: attached === '1',
                    created: new Date(parseInt(created) * 1000),
                    remoteId,
                    remoteLabel: remote?.label
                };
            });
        } catch (error) {
            console.error('Failed to get tmux sessions:', error);
            return [];
        }
    }

    /**
     * Get sessions that aren't tracked as tasks
     */
    static getUntrackedSessions(trackedSessionNames: string[]): TmuxSession[] {
        const allSessions = this.getSessions();
        const trackedSet = new Set(trackedSessionNames.map(n => n.toLowerCase()));

        return allSessions.filter(session =>
            !trackedSet.has(session.name.toLowerCase())
        );
    }

    /**
     * Attach to a tmux session (returns command string)
     */
    static getAttachCommand(sessionName: string, remote?: RemoteConfig): string {
        const command = `tmux attach-session -t ${shellQuote(sessionName)}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, true);
        }
        return command;
    }

    /**
     * Kill a tmux session (returns command string)
     */
    static getKillCommand(sessionName: string, remote?: RemoteConfig): string {
        const command = `tmux kill-session -t ${shellQuote(sessionName)}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, false);
        }
        return command;
    }

    /**
     * Get the WSL-wrapped command for attaching to a session
     * Used when running from Windows Local mode (not WSL Remote)
     */
    static getAttachCommandForWSL(sessionName: string): string {
        const escaped = this.escapeForShell(sessionName);
        return `wsl.exe -e bash -lc "tmux attach-session -t '${escaped}'"`;
    }

    /**
     * Get the WSL-wrapped command for killing a session
     * Used when running from Windows Local mode (not WSL Remote)
     */
    static getKillCommandForWSL(sessionName: string): string {
        const escaped = this.escapeForShell(sessionName);
        return `wsl.exe -e bash -lc "tmux kill-session -t '${escaped}'"`;
    }

    /**
     * Escape a session name for use in a shell command
     * Handles single quote escaping for bash single-quoted strings
     */
    private static escapeForShell(sessionName: string): string {
        // For single-quoted strings in bash, escape single quotes by ending the quote,
        // adding an escaped quote, and starting a new quote: ' -> '\''
        return sessionName.replace(/'/g, "'\\''");
    }

    /**
     * Convert WSL path to Windows path if needed
     */
    static normalizePathForDisplay(wslPath: string): string {
        // Convert /mnt/c/... to C:\... for display on Windows
        const mntMatch = wslPath.match(/^\/mnt\/([a-z])\/?(.*)/i);
        if (mntMatch) {
            const drive = mntMatch[1].toUpperCase();
            const subPath = mntMatch[2]?.replace(/\//g, '\\') || '';
            return `${drive}:\\${subPath}`;
        }
        return wslPath;
    }

    private static shouldUseLocalCommand(): boolean {
        return vscode.env.remoteName !== undefined || process.platform !== 'win32';
    }
}
