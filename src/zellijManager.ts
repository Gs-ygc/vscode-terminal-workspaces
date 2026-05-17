import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { RemoteConfig } from './types';
import { buildSshCommand, normalizeRemoteId, shellQuote } from './remoteUtils';

export interface ZellijSession {
    /** Session name */
    name: string;
    /**
     * Working directory (if available)
     * Note: Zellij's list-sessions doesn't provide working directory info.
     * Unlike tmux which has #{pane_current_path}, zellij sessions are
     * imported with a fallback to the workspace folder.
     */
    path?: string;
    /** Whether the session is in EXITED state (processes terminated, can be resurrected or deleted) */
    exited: boolean;
    /** Remote target ID that owns this session */
    remoteId?: string;
    /** Remote display label */
    remoteLabel?: string;
}

export class ZellijManager {
    /**
     * Check if zellij is available
     */
    static isAvailable(): boolean {
        try {
            if (this.shouldUseLocalCommand()) {
                execSync('which zellij', { encoding: 'utf8', stdio: 'pipe' });
            } else if (process.platform === 'win32') {
                execSync('wsl.exe -e which zellij', { encoding: 'utf8', stdio: 'pipe' });
            } else {
                execSync('which zellij', { encoding: 'utf8', stdio: 'pipe' });
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get all zellij sessions
     * Note: Zellij's list-sessions output is simpler than tmux - just session names with ANSI colors
     */
    static getSessions(remote?: RemoteConfig): ZellijSession[] {
        try {
            let output: string;

            if (remote?.type === 'ssh') {
                output = execSync(buildSshCommand(remote, 'zellij list-sessions 2>/dev/null || true', false), {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 5000
                });
            } else if (this.shouldUseLocalCommand()) {
                output = execSync('zellij list-sessions 2>/dev/null || true', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 5000
                });
            } else if (process.platform === 'win32') {
                // On Windows, run through WSL
                output = execSync('wsl.exe -e bash -c "zellij list-sessions 2>/dev/null || true"', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 5000
                });
            } else {
                // Native Linux/macOS
                output = execSync('zellij list-sessions 2>/dev/null || true', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 5000
                });
            }

            if (!output.trim()) {
                return [];
            }

            // Strip ANSI color codes and parse session names
            // Zellij output format is typically: session_name (with optional ANSI colors)
            const remoteId = normalizeRemoteId(remote?.id);
            return output.trim().split('\n')
                .map((line): ZellijSession | null => {
                    // Strip ANSI escape codes
                    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    // Zellij may show status info after session name, extract just the name
                    // Format can be: "session_name" or "session_name (EXITED - ...)"
                    const match = cleanLine.match(/^([^\s(]+)/);
                    const name = match ? match[1] : cleanLine;
                    if (!name) return null;
                    const exited = cleanLine.includes('EXITED');
                    return {
                        name,
                        exited,
                        remoteId,
                        remoteLabel: remote?.label
                    };
                })
                .filter((s): s is ZellijSession => s !== null && s.name.length > 0);
        } catch (error) {
            console.error('Failed to get zellij sessions:', error);
            return [];
        }
    }

    /**
     * Get sessions that aren't tracked as tasks
     */
    static getUntrackedSessions(trackedSessionNames: string[]): ZellijSession[] {
        const allSessions = this.getSessions();
        const trackedSet = new Set(trackedSessionNames.map(n => n.toLowerCase()));

        return allSessions.filter(session =>
            !trackedSet.has(session.name.toLowerCase())
        );
    }

    /**
     * Get command to attach to a zellij session
     */
    static getAttachCommand(sessionName: string, remote?: RemoteConfig): string {
        const command = `zellij attach ${shellQuote(sessionName)}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, true);
        }
        return command;
    }

    /**
     * Get command to create a new zellij session
     */
    static getNewSessionCommand(sessionName: string, remote?: RemoteConfig): string {
        const command = `zellij -s ${shellQuote(sessionName)}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, true);
        }
        return command;
    }

    /**
     * Get command to attach or create a zellij session
     * Zellij doesn't have a direct equivalent to tmux's -A flag,
     * so we use a shell conditional
     */
    static getAttachOrCreateCommand(sessionName: string, remote?: RemoteConfig): string {
        const quoted = shellQuote(sessionName);
        const command = `zellij attach ${quoted} 2>/dev/null || zellij -s ${quoted}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, true);
        }
        return command;
    }

    /**
     * Get command to kill a zellij session
     * Note: kill-session terminates processes but leaves session in EXITED state
     * (can be resurrected by attaching)
     */
    static getKillCommand(sessionName: string, remote?: RemoteConfig): string {
        const command = `zellij kill-session ${shellQuote(sessionName)}`;
        if (remote?.type === 'ssh') {
            return buildSshCommand(remote, command, false);
        }
        return command;
    }

    /**
     * Get command to delete a zellij session
     * Note: delete-session fully removes the session (cannot be resurrected)
     */
    static getDeleteCommand(sessionName: string, remote?: RemoteConfig): string {
        const quoted = shellQuote(sessionName);
        // Kill first (in case session is still running), then delete
        const command = `zellij kill-session ${quoted} 2>/dev/null; zellij delete-session ${quoted}`;
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
        return `wsl.exe -e bash -lc "zellij attach '${escaped}'"`;
    }

    /**
     * Get the WSL-wrapped command for creating a new session
     * Used when running from Windows Local mode (not WSL Remote)
     */
    static getNewSessionCommandForWSL(sessionName: string): string {
        const escaped = this.escapeForShell(sessionName);
        return `wsl.exe -e bash -lc "zellij -s '${escaped}'"`;
    }

    /**
     * Get the WSL-wrapped command for killing a session
     * Used when running from Windows Local mode (not WSL Remote)
     */
    static getKillCommandForWSL(sessionName: string): string {
        const escaped = this.escapeForShell(sessionName);
        return `wsl.exe -e bash -lc "zellij kill-session '${escaped}'"`;
    }

    /**
     * Get the WSL-wrapped command for deleting a session
     * Used when running from Windows Local mode (not WSL Remote)
     */
    static getDeleteCommandForWSL(sessionName: string): string {
        const escaped = this.escapeForShell(sessionName);
        // Kill first (in case session is still running), then delete
        return `wsl.exe -e bash -lc "zellij kill-session '${escaped}' 2>/dev/null; zellij delete-session '${escaped}'"`;
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
     * Check if a specific session is in EXITED state
     */
    static isSessionExited(sessionName: string, remote?: RemoteConfig): boolean {
        const sessions = this.getSessions(remote);
        const session = sessions.find(s => s.name === sessionName);
        return session?.exited ?? false;
    }

    /**
     * Synchronously kill+delete a session (for cleaning up EXITED sessions before task launch)
     */
    static deleteSessionSync(sessionName: string, remote?: RemoteConfig): void {
        const quoted = shellQuote(sessionName);
        const localCommand = `zellij kill-session ${quoted} 2>/dev/null; zellij delete-session ${quoted} 2>/dev/null`;
        const cmd = remote?.type === 'ssh'
            ? buildSshCommand(remote, localCommand, false)
            : this.shouldUseLocalCommand()
                ? localCommand
                : `wsl.exe -e bash -lc "zellij kill-session '${this.escapeForShell(sessionName)}' 2>/dev/null; zellij delete-session '${this.escapeForShell(sessionName)}' 2>/dev/null"`;

        try {
            execSync(cmd, { stdio: 'pipe', timeout: 5000 });
        } catch {
            // Ignore errors - session may already be gone
        }
    }

    private static shouldUseLocalCommand(): boolean {
        return vscode.env.remoteName !== undefined || process.platform !== 'win32';
    }
}
