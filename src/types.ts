/**
 * Terminal Workspaces - Type Definitions
 *
 * This extension uses its own config file (terminal-workspaces.json) to store
 * rich configuration, then generates VS Code's tasks.json from it.
 */

// ============================================================================
// PROFILES - Reusable shell/environment configurations
// ============================================================================

export type ShellType = 'wsl' | 'wsl-bash' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'default' | 'custom';

export type TmuxMode = 'none' | 'attach-or-create' | 'always-new' | 'attach-only' | 'custom';

export type ZellijMode = 'none' | 'attach-or-create' | 'always-new' | 'attach-only';

/** Type of terminal multiplexer to use */
export type MultiplexerType = 'none' | 'tmux' | 'zellij';

export interface RemoteConfig {
    /** Stable ID used by tasks */
    id: string;
    /** Display name shown in the tree */
    label: string;
    /** Local extension host or an SSH target reachable from this host */
    type: 'local' | 'ssh';
    /** SSH host/alias, for example "k1" or "user@host" */
    host?: string;
    /** Extra SSH arguments, for example ["-p", "2222"] */
    sshArgs?: string[];
    /**
     * Login shell to use on the remote host, for example "bash" or "zsh".
     * Defaults to "$SHELL" (evaluated on the remote side), which picks up the
     * user's configured login shell and its rc files (-ic mode).
     */
    shell?: string;
}

export interface TerminalColor {
    /** Terminal tab background color (hex or VS Code theme color) */
    background?: string;
    /** Terminal tab foreground/text color */
    foreground?: string;
}

export interface TmuxConfig {
    /** Whether to use tmux */
    enabled?: boolean;
    /** How to handle tmux sessions */
    mode?: TmuxMode;
    /** Session name (defaults to task name if not specified) */
    sessionName?: string;
    /** Custom tmux command (only used if mode is 'custom') */
    customCommand?: string;
}

export interface ZellijConfig {
    /** Whether to use zellij */
    enabled?: boolean;
    /** How to handle zellij sessions */
    mode?: ZellijMode;
    /** Session name (defaults to task name if not specified) */
    sessionName?: string;
}

export interface Profile {
    /** Unique identifier for the profile */
    id: string;
    /** Display name */
    name: string;
    /** Description shown in UI */
    description?: string;
    /** Shell type to use */
    shellType: ShellType;
    /** Custom shell executable (only used if shellType is 'custom') */
    customShell?: string;
    /** Custom shell arguments */
    customShellArgs?: string[];
    /** Tmux configuration */
    tmux?: TmuxConfig;
    /** Zellij configuration */
    zellij?: ZellijConfig;
    /** Terminal colors */
    colors?: TerminalColor;
    /** Terminal icon (VS Code codicon name without $()) */
    icon?: string;
    /** Environment variables to set */
    env?: Record<string, string>;
    /** Commands to run before cd'ing to directory */
    preCommands?: string[];
    /** Commands to run after cd'ing to directory */
    postCommands?: string[];
    /** Whether this is a built-in profile (cannot be deleted) */
    builtin?: boolean;
}

// ============================================================================
// TASK ITEMS - Individual terminal tasks or folders
// ============================================================================

export interface TaskItemBase {
    /** Unique identifier */
    id: string;
    /** Display name */
    name: string;
    /** Tags/labels for filtering */
    tags?: string[];
    /** Sort order within parent */
    order?: number;
}

export interface TerminalTaskItem extends TaskItemBase {
    type: 'task';
    /** Remote target ID. Missing means the local extension host. */
    remoteId?: string;
    /** Path to the directory */
    path: string;
    /** Profile ID to use (defaults to 'default') */
    profileId?: string;
    /** Override profile settings for this specific task */
    overrides?: Partial<Omit<Profile, 'id' | 'name' | 'builtin'>>;
}

export interface TaskFolder extends TaskItemBase {
    type: 'folder';
    /** Child items (tasks or nested folders) */
    children: TaskItem[];
    /** Whether folder is expanded in UI */
    expanded?: boolean;
}

export type TaskItem = TerminalTaskItem | TaskFolder;

// ============================================================================
// CONFIGURATION FILE - Stored in .vscode/terminal-workspaces.json
// ============================================================================

export interface TerminalTasksConfig {
    /** Config file version for migrations */
    version: string;
    /** User-defined profiles */
    profiles: Profile[];
    /** Default profile ID to use for new tasks */
    defaultProfileId: string;
    /** Remote targets shown as top-level tree groups */
    remotes: RemoteConfig[];
    /** Root-level task items */
    items: TaskItem[];
    /** Global settings */
    settings: {
        /** Whether to auto-generate tasks.json */
        autoGenerateTasksJson: boolean;
        /** Group task label in tasks.json */
        groupTaskLabel: string;
        /** Whether to create the group task */
        createGroupTask: boolean;
    };
}

// ============================================================================
// BUILT-IN PROFILES
// ============================================================================

export const BUILTIN_PROFILES: Profile[] = [
    {
        id: 'bash-tmux',
        name: 'Bash + tmux',
        description: 'Bash with tmux session (Linux/macOS/remote)',
        shellType: 'bash',
        tmux: {
            enabled: true,
            mode: 'attach-or-create'
        },
        builtin: true,
        icon: 'terminal-bash'
    },
    {
        id: 'bash-zellij',
        name: 'Bash + Zellij',
        description: 'Bash with Zellij session (Linux/macOS/remote)',
        shellType: 'bash',
        zellij: {
            enabled: true,
            mode: 'attach-or-create'
        },
        builtin: true,
        icon: 'terminal-bash'
    },
    {
        id: 'bash',
        name: 'Bash',
        description: 'Native bash terminal (Linux/macOS/remote)',
        shellType: 'bash',
        builtin: true,
        icon: 'terminal-bash'
    },
    {
        id: 'wsl-default',
        name: 'WSL (Default)',
        description: 'Open WSL terminal in directory',
        shellType: 'wsl',
        builtin: true,
        icon: 'terminal-linux'
    },
    {
        id: 'wsl-tmux',
        name: 'WSL + tmux',
        description: 'Open WSL with tmux session (attach or create)',
        shellType: 'wsl',
        tmux: {
            enabled: true,
            mode: 'attach-or-create'
        },
        builtin: true,
        icon: 'terminal-linux'
    },
    {
        id: 'wsl-zellij',
        name: 'WSL + Zellij',
        description: 'Open WSL with Zellij session (attach or create)',
        shellType: 'wsl',
        zellij: {
            enabled: true,
            mode: 'attach-or-create'
        },
        builtin: true,
        icon: 'terminal-linux'
    },
    {
        id: 'powershell',
        name: 'PowerShell',
        description: 'Windows PowerShell terminal',
        shellType: 'powershell',
        builtin: true,
        icon: 'terminal-powershell'
    },
    {
        id: 'cmd',
        name: 'Command Prompt',
        description: 'Windows CMD terminal',
        shellType: 'cmd',
        builtin: true,
        icon: 'terminal-cmd'
    },
    {
        id: 'default',
        name: 'VS Code Default',
        description: 'Use VS Code\'s default terminal profile',
        shellType: 'default',
        builtin: true,
        icon: 'terminal'
    }
];

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

export const DEFAULT_CONFIG: TerminalTasksConfig = {
    version: '1.0.0',
    profiles: [],
    defaultProfileId: 'bash-tmux',
    remotes: [
        {
            id: 'local',
            label: 'Host',
            type: 'local'
        }
    ],
    items: [],
    settings: {
        autoGenerateTasksJson: true,
        groupTaskLabel: 'Open All Terminals',
        createGroupTask: true
    }
};

// ============================================================================
// HELPER TYPES
// ============================================================================

export interface FlattenedTask {
    /** Full path of IDs from root to this item */
    idPath: string[];
    /** Full display path (names) */
    namePath: string[];
    /** The task item itself */
    task: TerminalTaskItem;
    /** Depth level (0 = root) */
    depth: number;
}

export interface CommandGenerationResult {
    /** The shell command to execute */
    command: string;
    /** Shell options for VS Code task */
    shellOptions?: {
        executable?: string;
        args?: string[];
    };
    /** Working directory (if applicable) */
    cwd?: string;
}
