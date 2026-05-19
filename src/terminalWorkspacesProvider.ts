import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './configManager';
import { TaskItem, TerminalTaskItem, TaskFolder, Profile, RemoteConfig, TmuxMode, ZellijMode, BUILTIN_PROFILES } from './types';
import { TmuxManager, TmuxSession } from './tmuxManager';
import { ZellijManager, ZellijSession } from './zellijManager';
import { LOCAL_REMOTE_ID, normalizeRemoteId } from './remoteUtils';

// Special marker types for tree items
export interface RemoteHeader {
    type: 'remoteHeader';
    remote: RemoteConfig;
}

export interface TmuxSessionsHeader {
    type: 'tmuxSessionsHeader';
    remoteId?: string;
}

export interface TmuxSessionData {
    type: 'tmuxSession';
    session: TmuxSession;
}

export interface ZellijSessionsHeader {
    type: 'zellijSessionsHeader';
    remoteId?: string;
}

export interface ZellijSessionData {
    type: 'zellijSession';
    session: ZellijSession;
}

export type TreeItemData = TaskItem | RemoteHeader | TmuxSessionsHeader | TmuxSessionData | ZellijSessionsHeader | ZellijSessionData;

export class TerminalTasksProvider implements vscode.TreeDataProvider<TaskTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TaskTreeItem | undefined | null | void> = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TaskTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private cachedUntrackedTmuxSessions: Map<string, TmuxSession[]> = new Map();
    private cachedUntrackedZellijSessions: Map<string, ZellijSession[]> = new Map();
    private allTmuxSessions: Map<string, TmuxSession[]> = new Map();
    private allZellijSessions: Map<string, ZellijSession[]> = new Map();
    private sshSessionRefreshInFlight: Set<string> = new Set();
    private sshSessionRefreshAt: Map<string, number> = new Map();
    private static readonly SSH_SESSION_CACHE_TTL_MS = 15000;

    // Cache of active tmux session names (refreshed on each tree refresh)
    // Used to verify if a tmux session actually exists vs just a VS Code terminal
    private activeTmuxSessions: Map<string, Set<string>> = new Map();

    // Cache of active zellij session names (refreshed on each tree refresh)
    private activeZellijSessions: Map<string, Set<string>> = new Map();

    // Parent map for getParent() support (needed for drag-and-drop)
    // Maps child item ID → parent TaskTreeItem (undefined means root)
    private parentMap: Map<string, TaskTreeItem | undefined> = new Map();

    // Filter state for "show active only" toggle
    private showActiveOnly: boolean = false;

    constructor(private configManager: ConfigManager) {}

    private getDefaultProfileId(): string {
        return this.configManager.getConfigSync()?.defaultProfileId || 'bash-tmux';
    }

    private getTaskProfile(task: TerminalTaskItem): Profile | undefined {
        return this.configManager.getProfile(task.profileId || this.getDefaultProfileId());
    }

    /**
     * Toggle the active-only filter and refresh the tree
     */
    toggleActiveFilter(): void {
        this.showActiveOnly = !this.showActiveOnly;
        this.refresh();
    }

    /**
     * Whether the active-only filter is currently enabled
     */
    get isFilterActive(): boolean {
        return this.showActiveOnly;
    }

    refresh(): void {
        this.cachedUntrackedTmuxSessions.clear();
        this.cachedUntrackedZellijSessions.clear();
        this.sshSessionRefreshAt.clear();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Refresh tmux sessions specifically
     */
    refreshTmuxSessions(): void {
        this.cachedUntrackedTmuxSessions.clear(); // Clear cache to force refresh
        this.sshSessionRefreshAt.clear();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Refresh zellij sessions specifically
     */
    refreshZellijSessions(): void {
        this.cachedUntrackedZellijSessions.clear(); // Clear cache to force refresh
        this.sshSessionRefreshAt.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
        const config = await this.configManager.getConfig();

        if (!element) {
            // Root level - refresh the active multiplexer sessions cache
            // This ensures we check actual tmux/zellij session state, not just VS Code terminal existence
            const remotes = this.getVisibleRemotes(config.remotes || this.configManager.getRemotes());
            this.refreshActiveSessionsCache(remotes);

            // Clear parent map on root refresh (rebuilt as tree items are created)
            this.parentMap.clear();

            if (this.shouldGroupByRemote(config.items, remotes) || this.hasUntrackedSessions(remotes)) {
                const remoteItems = remotes.map(remote => this.createRemoteHeader(remote));
                if (remoteItems.length === 0) {
                    return [this.createPlaceholderItem()];
                }
                for (const treeItem of remoteItems) {
                    if (treeItem.id) {
                        this.parentMap.set(treeItem.id, undefined);
                    }
                }
                return remoteItems;
            }

            const items: TaskTreeItem[] = [];
            const localRemoteId = LOCAL_REMOTE_ID;

            // Check for untracked tmux sessions
            const untrackedTmuxSessions = this.getUntrackedTmuxSessions(localRemoteId);
            if (untrackedTmuxSessions.length > 0) {
                items.push(this.createTmuxSessionsHeader(untrackedTmuxSessions.length, localRemoteId));
            }

            // Check for untracked zellij sessions
            const untrackedZellijSessions = this.getUntrackedZellijSessions(localRemoteId);
            if (untrackedZellijSessions.length > 0) {
                items.push(this.createZellijSessionsHeader(untrackedZellijSessions.length, localRemoteId));
            }

            // Regular tasks
            const hasUntrackedSessions = untrackedTmuxSessions.length > 0 || untrackedZellijSessions.length > 0;
            if (config.items.length === 0 && !hasUntrackedSessions) {
                return [this.createPlaceholderItem()];
            }

            const configTreeItems = this.itemsToTreeItems(config.items, false, localRemoteId);
            // Register root-level items in parent map (undefined = root)
            for (const treeItem of configTreeItems) {
                if (treeItem.id) {
                    this.parentMap.set(treeItem.id, undefined);
                }
            }
            items.push(...configTreeItems);
            return items;
        }

        if (element.itemData && 'type' in element.itemData && element.itemData.type === 'remoteHeader') {
            const remote = (element.itemData as RemoteHeader).remote;
            const remoteId = normalizeRemoteId(remote.id);
            const items: TaskTreeItem[] = [];

            const untrackedTmuxSessions = this.getUntrackedTmuxSessions(remoteId);
            if (untrackedTmuxSessions.length > 0) {
                const header = this.createTmuxSessionsHeader(untrackedTmuxSessions.length, remoteId);
                if (header.id) {
                    this.parentMap.set(header.id, element);
                }
                items.push(header);
            }

            let untrackedZellijSessions = this.getUntrackedZellijSessions(remoteId);
            if (this.showActiveOnly) {
                untrackedZellijSessions = untrackedZellijSessions.filter(s => !s.exited);
            }
            if (untrackedZellijSessions.length > 0) {
                const header = this.createZellijSessionsHeader(untrackedZellijSessions.length, remoteId);
                if (header.id) {
                    this.parentMap.set(header.id, element);
                }
                items.push(header);
            }

            const taskItems = this.itemsToTreeItems(this.filterItemsForRemote(config.items, remoteId), false, remoteId);
            for (const child of taskItems) {
                if (child.id) {
                    this.parentMap.set(child.id, element);
                }
            }
            items.push(...taskItems);
            return items;
        }

        // Children of tmux sessions header
        if (element.itemData && 'type' in element.itemData && element.itemData.type === 'tmuxSessionsHeader') {
            const remoteId = normalizeRemoteId((element.itemData as TmuxSessionsHeader).remoteId);
            return this.getUntrackedTmuxSessions(remoteId).map(session => this.createTmuxSessionItem(session));
        }

        // Children of zellij sessions header
        if (element.itemData && 'type' in element.itemData && element.itemData.type === 'zellijSessionsHeader') {
            const remoteId = normalizeRemoteId((element.itemData as ZellijSessionsHeader).remoteId);
            let sessions = this.getUntrackedZellijSessions(remoteId);
            // When filter is active, hide EXITED sessions
            if (this.showActiveOnly) {
                sessions = sessions.filter(s => !s.exited);
            }
            return sessions.map(session => this.createZellijSessionItem(session));
        }

        // Children of a folder
        if (element.itemData?.type === 'folder') {
            const folder = element.itemData as TaskFolder;
            const remoteId = this.remoteIdFromTreeId(element.id);
            const childItems = this.itemsToTreeItems(folder.children, true, remoteId);
            // Register folder children in parent map
            for (const child of childItems) {
                if (child.id) {
                    this.parentMap.set(child.id, element);
                }
            }
            return childItems;
        }

        return [];
    }

    /**
     * Get untracked tmux sessions (sessions not mapped to tasks)
     */
    getUntrackedTmuxSessions(remoteId: string = LOCAL_REMOTE_ID): TmuxSession[] {
        remoteId = normalizeRemoteId(remoteId);
        const cached = this.cachedUntrackedTmuxSessions.get(remoteId);
        if (cached) {
            return cached;
        }

        // Get all task names that might be tmux sessions
        const flatTasks = this.configManager.flattenTasks();
        const trackedNames: string[] = [];

        for (const ft of flatTasks) {
            if (normalizeRemoteId(ft.task.remoteId) !== remoteId) {
                continue;
            }
            // Check if task uses tmux
            const profile = this.getTaskProfile(ft.task);
            if (profile?.tmux?.enabled === true || ft.task.overrides?.tmux?.enabled === true) {
                // Use custom session name if set, otherwise task name
                const rawSessionName = ft.task.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || ft.task.name;
                const sanitizedSessionName = rawSessionName
                    .replace(/[^a-zA-Z0-9_-]/g, '_')
                    .substring(0, 50);
                // Track BOTH raw and sanitized names to handle:
                // - Imported sessions (raw name matches the actual session)
                // - Sessions created by extension (sanitized name matches what we create)
                trackedNames.push(rawSessionName);
                if (rawSessionName !== sanitizedSessionName) {
                    trackedNames.push(sanitizedSessionName);
                }
            }
        }

        const trackedSet = new Set(trackedNames.map(n => n.toLowerCase()));
        const allSessions = this.allTmuxSessions.get(remoteId) || [];
        const untracked = allSessions.filter(session =>
            !trackedSet.has(session.name.toLowerCase()) &&
            this.isSessionVisibleInLayer(session, remoteId)
        );
        this.cachedUntrackedTmuxSessions.set(remoteId, untracked);
        return untracked;
    }

    /**
     * Get untracked zellij sessions (sessions not mapped to tasks)
     */
    getUntrackedZellijSessions(remoteId: string = LOCAL_REMOTE_ID): ZellijSession[] {
        remoteId = normalizeRemoteId(remoteId);
        const cached = this.cachedUntrackedZellijSessions.get(remoteId);
        if (cached) {
            return cached;
        }

        // Get all task names that might be zellij sessions
        const flatTasks = this.configManager.flattenTasks();
        const trackedNames: string[] = [];

        for (const ft of flatTasks) {
            if (normalizeRemoteId(ft.task.remoteId) !== remoteId) {
                continue;
            }
            // Check if task uses zellij
            const profile = this.getTaskProfile(ft.task);
            if (profile?.zellij?.enabled === true || ft.task.overrides?.zellij?.enabled === true) {
                // Use custom session name if set, otherwise task name
                const rawSessionName = ft.task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || ft.task.name;
                const sanitizedSessionName = rawSessionName
                    .replace(/[^a-zA-Z0-9_-]/g, '_')
                    .substring(0, 50);
                // Track BOTH raw and sanitized names to handle:
                // - Imported sessions (raw name matches the actual session)
                // - Sessions created by extension (sanitized name matches what we create)
                trackedNames.push(rawSessionName);
                if (rawSessionName !== sanitizedSessionName) {
                    trackedNames.push(sanitizedSessionName);
                }
            }
        }

        const trackedSet = new Set(trackedNames.map(n => n.toLowerCase()));
        const allSessions = this.allZellijSessions.get(remoteId) || [];
        const untracked = allSessions.filter(session =>
            !trackedSet.has(session.name.toLowerCase()) &&
            this.isZellijSessionVisibleInLayer(remoteId)
        );
        this.cachedUntrackedZellijSessions.set(remoteId, untracked);
        return untracked;
    }

    getParent(element: TaskTreeItem): vscode.ProviderResult<TaskTreeItem> {
        if (!element.id) {
            return undefined;
        }
        const parent = this.parentMap.get(element.id);
        // undefined in the map means root item; not found also returns undefined
        return parent;
    }

    /**
     * Refresh the cache of active multiplexer sessions (tmux and zellij)
     * Called at the start of each tree refresh to ensure accurate state
     */
    private refreshActiveSessionsCache(remotes: RemoteConfig[]): void {
        // Local remotes are queried synchronously (fast, no network).
        // SSH remotes are queried asynchronously so they never block tree rendering:
        // results are stored when ready and a tree refresh is triggered automatically.
        const localRemotes = remotes.filter(r => r.type !== 'ssh');
        const sshRemotes = remotes.filter(r => r.type === 'ssh');

        if (!remotes.some(remote => normalizeRemoteId(remote.id) === LOCAL_REMOTE_ID)) {
            this.clearLocalHostSessionCache();
        }

        // Synchronous pass for local remotes
        this.refreshRemotesSync(localRemotes);

        // Async pass for SSH remotes — doesn't block getChildren
        const remotesToRefresh = sshRemotes.filter(remote => this.shouldRefreshSshRemote(remote));
        if (remotesToRefresh.length > 0) {
            this.refreshRemotesAsync(remotesToRefresh);
        }
    }

    private clearLocalHostSessionCache(): void {
        this.allTmuxSessions.set(LOCAL_REMOTE_ID, []);
        this.allZellijSessions.set(LOCAL_REMOTE_ID, []);
        this.activeTmuxSessions.set(LOCAL_REMOTE_ID, new Set());
        this.activeZellijSessions.set(LOCAL_REMOTE_ID, new Set());
        this.cachedUntrackedTmuxSessions.delete(LOCAL_REMOTE_ID);
        this.cachedUntrackedZellijSessions.delete(LOCAL_REMOTE_ID);
    }

    private getVisibleRemotes(remotes: RemoteConfig[]): RemoteConfig[] {
        if (this.configManager.isRemoteLayer() || this.configManager.isWorkspaceLayer()) {
            return [this.configManager.getLayerHostRemote()];
        }
        return remotes;
    }

    private isSessionVisibleInLayer(session: TmuxSession, remoteId: string): boolean {
        if (!this.configManager.isWorkspaceLayer() || normalizeRemoteId(remoteId) !== LOCAL_REMOTE_ID) {
            return true;
        }

        return this.isPathInsideWorkspace(session.path);
    }

    private isZellijSessionVisibleInLayer(remoteId: string): boolean {
        return !(this.configManager.isWorkspaceLayer() && normalizeRemoteId(remoteId) === LOCAL_REMOTE_ID);
    }

    private isPathInsideWorkspace(sessionPath?: string): boolean {
        if (!sessionPath || sessionPath === '~') {
            return false;
        }

        const workspaceRoots = vscode.workspace.workspaceFolders
            ?.map(folder => this.normalizeComparablePath(folder.uri.fsPath))
            .filter(Boolean) || [];
        if (workspaceRoots.length === 0) {
            return false;
        }

        const normalizedSessionPath = this.normalizeComparablePath(sessionPath);
        return workspaceRoots.some(root => (
            normalizedSessionPath === root ||
            normalizedSessionPath.startsWith(root.endsWith('/') ? root : `${root}/`)
        ));
    }

    private normalizeComparablePath(inputPath: string): string {
        return path.posix.normalize(inputPath.replace(/\\/g, '/')).replace(/\/+$/, '');
    }

    private shouldRefreshSshRemote(remote: RemoteConfig): boolean {
        const remoteId = normalizeRemoteId(remote.id);
        if (this.sshSessionRefreshInFlight.has(remoteId)) {
            return false;
        }

        const lastRefresh = this.sshSessionRefreshAt.get(remoteId) || 0;
        return Date.now() - lastRefresh > TerminalTasksProvider.SSH_SESSION_CACHE_TTL_MS;
    }

    private refreshRemotesSync(remotes: RemoteConfig[]): void {
        for (const remote of remotes) {
            const remoteId = normalizeRemoteId(remote.id);
            // tmux
            const activeTmux = new Set<string>();
            try {
                const sessions = TmuxManager.getSessions(remote);
                this.allTmuxSessions.set(remoteId, sessions);
                for (const s of sessions) { activeTmux.add(s.name.toLowerCase()); }
            } catch {
                this.allTmuxSessions.set(remoteId, []);
            }
            this.activeTmuxSessions.set(remoteId, activeTmux);
            // zellij
            const activeZellij = new Set<string>();
            try {
                const sessions = ZellijManager.getSessions(remote);
                this.allZellijSessions.set(remoteId, sessions);
                for (const s of sessions) { activeZellij.add(s.name.toLowerCase()); }
            } catch {
                this.allZellijSessions.set(remoteId, []);
            }
            this.activeZellijSessions.set(remoteId, activeZellij);
        }
    }

    private refreshRemotesAsync(remotes: RemoteConfig[]): void {
        Promise.all(remotes.map(async remote => {
            const remoteId = normalizeRemoteId(remote.id);
            this.sshSessionRefreshInFlight.add(remoteId);
            try {
                await new Promise(resolve => setTimeout(resolve, 0));
                // tmux
                const activeTmux = new Set<string>();
                try {
                    const sessions = TmuxManager.getSessions(remote);
                    this.allTmuxSessions.set(remoteId, sessions);
                    for (const s of sessions) { activeTmux.add(s.name.toLowerCase()); }
                } catch {
                    this.allTmuxSessions.set(remoteId, []);
                }
                this.activeTmuxSessions.set(remoteId, activeTmux);
                // zellij
                const activeZellij = new Set<string>();
                try {
                    const sessions = ZellijManager.getSessions(remote);
                    this.allZellijSessions.set(remoteId, sessions);
                    for (const s of sessions) { activeZellij.add(s.name.toLowerCase()); }
                } catch {
                    this.allZellijSessions.set(remoteId, []);
                }
                this.activeZellijSessions.set(remoteId, activeZellij);
                // Clear untracked caches for this remote so next render picks up fresh data
                this.cachedUntrackedTmuxSessions.delete(remoteId);
                this.cachedUntrackedZellijSessions.delete(remoteId);
                this.sshSessionRefreshAt.set(remoteId, Date.now());
            } finally {
                this.sshSessionRefreshInFlight.delete(remoteId);
            }
        })).then(() => {
            // Re-render the tree now that SSH data is available
            this._onDidChangeTreeData.fire(undefined);
        }).catch(() => { /* ignore */ });
    }

    /**
     * Check if there's an active terminal matching the task name
     * @param taskName - The display name of the task
     * @param sanitizedSessionName - Optional sanitized session name (for tmux/zellij) to also check
     * @param multiplexer - Which multiplexer this task uses ('tmux', 'zellij', or undefined for none)
     */
    private isTerminalActive(taskName: string, sanitizedSessionName?: string, multiplexer?: 'tmux' | 'zellij', remoteId: string = LOCAL_REMOTE_ID): boolean {
        remoteId = normalizeRemoteId(remoteId);
        // For multiplexer tasks, we need BOTH:
        // 1. A VS Code terminal to exist (so we can show it)
        // 2. The actual session to exist (so it's not a dead/ended session)
        if (multiplexer && sanitizedSessionName) {
            const sessionExists = multiplexer === 'tmux'
                ? this.activeTmuxSessions.get(remoteId)?.has(sanitizedSessionName.toLowerCase())
                : this.activeZellijSessions.get(remoteId)?.has(sanitizedSessionName.toLowerCase());
            if (!sessionExists) {
                return false; // session is dead, don't show as active
            }
        }

        const terminals = vscode.window.terminals;
        return terminals.some(terminal => {
            // Match exact name or "Task: name" format from VS Code tasks
            const terminalName = terminal.name;
            const localNameMatches = remoteId === LOCAL_REMOTE_ID && (
                   terminalName === taskName ||
                   terminalName === `Task - ${taskName}` ||
                   terminalName.startsWith(`${taskName} `)
            );
            const matches = localNameMatches ||
                   terminalName === this.getSessionTerminalName('tmux', taskName, remoteId) ||
                   terminalName === this.getSessionTerminalName('zellij', taskName, remoteId);

            // Also check sanitized session name if provided
            if (!matches && sanitizedSessionName && sanitizedSessionName !== taskName) {
                return terminalName === this.getSessionTerminalName('tmux', sanitizedSessionName, remoteId) ||
                       terminalName === this.getSessionTerminalName('zellij', sanitizedSessionName, remoteId) ||
                       (remoteId === LOCAL_REMOTE_ID && terminalName === sanitizedSessionName);
            }

            return matches;
        });
    }

    /**
     * Check if there's an active terminal for a tmux session
     */
    private isTmuxTerminalActive(sessionName: string, remoteId: string = LOCAL_REMOTE_ID): boolean {
        const terminals = vscode.window.terminals;
        return terminals.some(terminal => {
            const terminalName = terminal.name;
            return terminalName === this.getSessionTerminalName('tmux', sessionName, remoteId);
        });
    }

    /**
     * Check if a multiplexer session exists (regardless of VS Code terminal state)
     * @param sessionName - The raw session name to check (as it appears in tmux/zellij)
     * @param multiplexer - Which multiplexer to check ('tmux' or 'zellij')
     * @returns true if the session exists in the background
     */
    private doesSessionExist(sessionName: string, multiplexer: 'tmux' | 'zellij', remoteId: string = LOCAL_REMOTE_ID): boolean {
        remoteId = normalizeRemoteId(remoteId);
        // Check against the raw session name (cache stores raw names from tmux/zellij, lowercased)
        if (multiplexer === 'tmux') {
            return this.activeTmuxSessions.get(remoteId)?.has(sessionName.toLowerCase()) || false;
        } else {
            return this.activeZellijSessions.get(remoteId)?.has(sessionName.toLowerCase()) || false;
        }
    }

    /**
     * Check if there's a VS Code terminal attached to a session (without checking session existence)
     */
    private isVSCodeTerminalAttached(taskName: string, sanitizedSessionName?: string, remoteId: string = LOCAL_REMOTE_ID): boolean {
        remoteId = normalizeRemoteId(remoteId);
        const terminals = vscode.window.terminals;
        return terminals.some(terminal => {
            const terminalName = terminal.name;
            const localNameMatches = remoteId === LOCAL_REMOTE_ID && (
                   terminalName === taskName ||
                   terminalName === `Task - ${taskName}` ||
                   terminalName.startsWith(`${taskName} `)
            );
            const matches = localNameMatches ||
                   terminalName === this.getTaskTerminalName(taskName, remoteId) ||
                   terminalName === this.getSessionTerminalName('tmux', taskName, remoteId) ||
                   terminalName === this.getSessionTerminalName('zellij', taskName, remoteId);

            if (!matches && sanitizedSessionName && sanitizedSessionName !== taskName) {
                return terminalName === this.getSessionTerminalName('tmux', sanitizedSessionName, remoteId) ||
                       terminalName === this.getSessionTerminalName('zellij', sanitizedSessionName, remoteId) ||
                       (remoteId === LOCAL_REMOTE_ID && terminalName === sanitizedSessionName);
            }

            return matches;
        });
    }

    /**
     * Check if a task or folder has any active terminals/sessions.
     * Used by the "show active only" filter.
     */
    private isItemActive(item: TaskItem, remoteId: string = LOCAL_REMOTE_ID): boolean {
        if (item.type === 'folder') {
            return item.children.some(child => this.isItemActive(child, remoteId));
        }

        remoteId = normalizeRemoteId(item.remoteId);
        // Task: check for active session or terminal
        const profile = this.getTaskProfile(item);
        const isTmux = profile?.tmux?.enabled || item.overrides?.tmux?.enabled;
        const isZellij = !isTmux && (profile?.zellij?.enabled || item.overrides?.zellij?.enabled);

        if (isTmux) {
            const rawSessionName = item.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || item.name;
            const sanitized = rawSessionName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            return this.doesSessionExist(rawSessionName, 'tmux', remoteId) || this.isVSCodeTerminalAttached(item.name, sanitized, remoteId);
        } else if (isZellij) {
            const rawSessionName = item.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || item.name;
            const sanitized = rawSessionName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            return this.doesSessionExist(rawSessionName, 'zellij', remoteId) || this.isVSCodeTerminalAttached(item.name, sanitized, remoteId);
        } else {
            return this.isVSCodeTerminalAttached(item.name, undefined, remoteId);
        }
    }

    private itemsToTreeItems(items: TaskItem[], isChild: boolean = false, remoteId: string = LOCAL_REMOTE_ID): TaskTreeItem[] {
        // Apply active-only filter if enabled
        const filteredItems = this.showActiveOnly
            ? items.filter(item => this.isItemActive(item, remoteId))
            : items;

        return filteredItems.map(item => {
            if (item.type === 'folder') {
                return this.createFolderItem(item, isChild, remoteId);
            } else {
                return this.createTaskItem(item, isChild, remoteId);
            }
        });
    }

    private createFolderItem(folder: TaskFolder, isChild: boolean = false, remoteId: string = LOCAL_REMOTE_ID): TaskTreeItem {
        const item = new TaskTreeItem(
            folder.name,
            folder.expanded !== false
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
            folder
        );

        // Set unique ID to preserve expansion state across refreshes
        item.id = `folder-${normalizeRemoteId(remoteId)}::${folder.id}`;
        // Use symbol-folder icon - narrower than 'folder' for consistent alignment
        item.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('terminal.ansiBlue'));
        // Use different context values for empty vs non-empty folders
        // This allows us to hide "Run All" on empty folders
        const hasChildren = folder.children.length > 0;
        item.contextValue = hasChildren ? 'taskFolderWithChildren' : 'taskFolderEmpty';
        item.tooltip = `Folder: ${folder.name}\n${folder.children.length} item(s)`;

        if (folder.tags?.length) {
            item.description = folder.tags.join(', ');
        }

        return item;
    }

    private createTaskItem(task: TerminalTaskItem, isChild: boolean = false, remoteId: string = LOCAL_REMOTE_ID): TaskTreeItem {
        const item = new TaskTreeItem(
            task.name,
            vscode.TreeItemCollapsibleState.None,
            task
        );

        // Set unique ID to preserve state across refreshes
        remoteId = normalizeRemoteId(task.remoteId || remoteId);
        item.id = `task-${remoteId}::${task.id}`;

        // Get the profile for this task
        const profile = this.getTaskProfile(task);

        // Check which multiplexer this task uses (if any)
        // Note: tmux and zellij are mutually exclusive
        const isTmux = profile?.tmux?.enabled || task.overrides?.tmux?.enabled;
        const isZellij = !isTmux && (profile?.zellij?.enabled || task.overrides?.zellij?.enabled);
        const multiplexer: 'tmux' | 'zellij' | undefined = isTmux ? 'tmux' : isZellij ? 'zellij' : undefined;

        // Calculate session names if this task uses a multiplexer
        // rawSessionName: the actual session name as it appears in tmux/zellij (for existence check)
        // sanitizedSessionName: sanitized version for terminal name matching
        let rawSessionName: string | undefined;
        let sanitizedSessionName: string | undefined;
        if (isTmux) {
            rawSessionName = task.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || task.name;
            sanitizedSessionName = rawSessionName
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .substring(0, 50);
        } else if (isZellij) {
            rawSessionName = task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || task.name;
            sanitizedSessionName = rawSessionName
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .substring(0, 50);
        }

        // Determine task state for icon color:
        // - Green: VS Code terminal attached AND session exists (or non-multiplexer with terminal)
        // - Yellow: Multiplexer session exists BUT no VS Code terminal attached (background session)
        // - Grey: No session exists (or non-multiplexer task with no terminal)

        let iconColor: vscode.ThemeColor;
        let hasActiveSession = false;
        let hasVSCodeTerminal = false;

        if (multiplexer && rawSessionName && sanitizedSessionName) {
            // Multiplexer task - check both session existence and terminal attachment
            // Use rawSessionName for session existence (matches cache which stores raw names)
            // Use sanitizedSessionName for terminal matching (terminals use sanitized names)
            hasActiveSession = this.doesSessionExist(rawSessionName, multiplexer, remoteId);
            hasVSCodeTerminal = this.isVSCodeTerminalAttached(task.name, sanitizedSessionName, remoteId);

            if (hasActiveSession && hasVSCodeTerminal) {
                // Green: Session exists AND terminal is attached
                iconColor = new vscode.ThemeColor('terminal.ansiGreen');
            } else if (hasActiveSession) {
                // Yellow: Session exists but no terminal attached (background session)
                iconColor = new vscode.ThemeColor('terminal.ansiYellow');
            } else {
                // Grey: No session exists
                iconColor = new vscode.ThemeColor('disabledForeground');
            }
        } else {
            // Non-multiplexer task - simple terminal check
            hasVSCodeTerminal = this.isVSCodeTerminalAttached(task.name, undefined, remoteId);
            iconColor = hasVSCodeTerminal
                ? new vscode.ThemeColor('terminal.ansiGreen')
                : new vscode.ThemeColor('disabledForeground');
        }

        // Use circle-filled for consistent alignment with tmux/zellij sessions
        item.iconPath = new vscode.ThemeIcon('circle-filled', iconColor);

        // For backward compatibility with isActive checks
        const isActive = hasActiveSession && hasVSCodeTerminal;

        // Set contextValue - ALWAYS include base 'terminalTask' to ensure inline buttons show
        // Add 'MultiplexerActive' suffix when session is active for kill option
        // Also add 'Background' context for sessions running without VS Code terminal
        if (multiplexer && hasActiveSession) {
            if (hasVSCodeTerminal) {
                // multiplexer task with active session AND terminal - show kill option
                item.contextValue = multiplexer === 'tmux' ? 'terminalTaskTmuxActive' : 'terminalTaskZellijActive';
            } else {
                // multiplexer task with background session (no terminal) - show kill option too
                item.contextValue = multiplexer === 'tmux' ? 'terminalTaskTmuxBackground' : 'terminalTaskZellijBackground';
            }
        } else {
            item.contextValue = 'terminalTask';
        }
        item.description = this.shortenPath(task.path);
        item.tooltip = this.buildTaskTooltip(task, profile);

        // Double-click to run
        item.command = {
            command: 'terminalWorkspaces.runTaskById',
            title: 'Run Terminal',
            arguments: [task.id]
        };

        return item;
    }

    private createPlaceholderItem(): TaskTreeItem {
        const item = new TaskTreeItem(
            'No terminal tasks configured',
            vscode.TreeItemCollapsibleState.None
        );

        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'placeholder';
        item.command = {
            command: 'terminalWorkspaces.addCurrentFileFolder',
            title: 'Add First Task'
        };

        return item;
    }

    private createRemoteHeader(remote: RemoteConfig): TaskTreeItem {
        const item = new TaskTreeItem(
            remote.label,
            vscode.TreeItemCollapsibleState.Expanded,
            { type: 'remoteHeader', remote } as RemoteHeader
        );

        item.id = `remote-${remote.id}`;
        item.iconPath = new vscode.ThemeIcon(remote.type === 'ssh' ? 'server-environment' : 'device-desktop');
        item.contextValue = 'remoteHeader';
        item.description = remote.type === 'ssh' ? remote.host : 'local';
        item.tooltip = remote.type === 'ssh'
            ? `SSH: ${remote.host}`
            : 'Local extension host';

        return item;
    }

    private createTmuxSessionsHeader(count: number, remoteId: string = LOCAL_REMOTE_ID): TaskTreeItem {
        remoteId = normalizeRemoteId(remoteId);
        const item = new TaskTreeItem(
            `Untracked Sessions (${count})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            { type: 'tmuxSessionsHeader', remoteId } as TmuxSessionsHeader
        );

        // Set unique ID to preserve expansion state
        item.id = `tmux-sessions-header-${remoteId}`;
        // Use a distinct icon with color to differentiate from regular folders
        item.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('terminal.ansiYellow'));
        item.contextValue = 'tmuxSessionsHeader';
        item.tooltip = `${count} tmux session(s) not linked to tasks.\nClick to expand, then import sessions as tasks.`;
        item.description = 'tmux';

        return item;
    }

    private createTmuxSessionItem(session: TmuxSession): TaskTreeItem {
        const remoteId = normalizeRemoteId(session.remoteId);
        const item = new TaskTreeItem(
            session.name,
            vscode.TreeItemCollapsibleState.None,
            { type: 'tmuxSession', session } as TmuxSessionData
        );

        // Set unique ID to preserve state across refreshes
        item.id = `tmux-session-${remoteId}-${session.name}`;

        // Check if there's an active terminal attached to this tmux session
        const isActive = this.isTerminalActive(session.name, undefined, undefined, remoteId) || this.isTmuxTerminalActive(session.name, remoteId);
        const iconColor = isActive
            ? new vscode.ThemeColor('terminal.ansiGreen')
            : new vscode.ThemeColor('disabledForeground');
        item.iconPath = new vscode.ThemeIcon('circle-filled', iconColor);
        item.contextValue = 'tmuxSession';
        item.description = TmuxManager.normalizePathForDisplay(session.path);
        item.tooltip = [
            `Session: ${session.name}`,
            session.remoteLabel ? `Host: ${session.remoteLabel}` : '',
            `Path: ${session.path}`,
            `Windows: ${session.windowCount}`,
            `Status: ${session.attached ? 'Attached' : 'Detached'}`,
            `Created: ${session.created.toLocaleString()}`,
            '',
            'Click to focus or attach. Right-click to import as task.'
        ].join('\n');

        item.command = {
            command: 'terminalWorkspaces.attachTmuxSession',
            title: 'Attach to Session',
            arguments: [session]
        };

        return item;
    }

    private createZellijSessionsHeader(count: number, remoteId: string = LOCAL_REMOTE_ID): TaskTreeItem {
        remoteId = normalizeRemoteId(remoteId);
        const item = new TaskTreeItem(
            `Untracked Sessions (${count})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            { type: 'zellijSessionsHeader', remoteId } as ZellijSessionsHeader
        );

        // Set unique ID to preserve expansion state
        item.id = `zellij-sessions-header-${remoteId}`;
        // Use a distinct icon with color to differentiate from regular folders
        item.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('terminal.ansiCyan'));
        item.contextValue = 'zellijSessionsHeader';
        item.tooltip = `${count} zellij session(s) not linked to tasks.\nClick to expand, then import sessions as tasks.`;
        item.description = 'zellij';

        return item;
    }

    private createZellijSessionItem(session: ZellijSession): TaskTreeItem {
        const remoteId = normalizeRemoteId(session.remoteId);
        const item = new TaskTreeItem(
            session.name,
            vscode.TreeItemCollapsibleState.None,
            { type: 'zellijSession', session } as ZellijSessionData
        );

        // Set unique ID to preserve state across refreshes
        item.id = `zellij-session-${remoteId}-${session.name}`;

        if (session.exited) {
            // EXITED sessions: red indicator, warn about resurrection
            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiRed'));
            item.contextValue = 'zellijSessionExited';
            item.description = '(EXITED)';
            item.tooltip = [
                `Session: ${session.name}`,
                session.remoteLabel ? `Host: ${session.remoteLabel}` : '',
                'Status: EXITED',
                '',
                'Attaching will resurrect with the last running command.',
                'Use "Delete Session" to permanently remove.'
            ].join('\n');
        } else {
            // Active/background sessions: green if terminal attached, grey otherwise
            const isActive = this.isTerminalActive(session.name, undefined, undefined, remoteId) || this.isZellijTerminalActive(session.name, remoteId);
            const iconColor = isActive
                ? new vscode.ThemeColor('terminal.ansiGreen')
                : new vscode.ThemeColor('disabledForeground');
            item.iconPath = new vscode.ThemeIcon('circle-filled', iconColor);
            item.contextValue = 'zellijSession';
            item.description = session.path || '';
            item.tooltip = [
                `Session: ${session.name}`,
                session.remoteLabel ? `Host: ${session.remoteLabel}` : '',
                session.path ? `Path: ${session.path}` : '',
                '',
                'Click to focus or attach. Right-click to import as task.'
            ].filter(l => l).join('\n');

            item.command = {
                command: 'terminalWorkspaces.attachZellijSession',
                title: 'Attach to Session',
                arguments: [session]
            };
        }

        return item;
    }

    /**
     * Check if there's an active terminal for a zellij session
     */
    private isZellijTerminalActive(sessionName: string, remoteId: string = LOCAL_REMOTE_ID): boolean {
        const terminals = vscode.window.terminals;
        return terminals.some(terminal => {
            const terminalName = terminal.name;
            return terminalName === this.getSessionTerminalName('zellij', sessionName, remoteId);
        });
    }

    private shouldGroupByRemote(items: TaskItem[], remotes: RemoteConfig[]): boolean {
        if (this.configManager.isRemoteLayer() || this.configManager.isWorkspaceLayer()) {
            return true;
        }

        if (remotes.length > 1) {
            return true;
        }

        return this.hasNonLocalTask(items);
    }

    private hasUntrackedSessions(remotes: RemoteConfig[]): boolean {
        return remotes.some(remote => {
            const remoteId = normalizeRemoteId(remote.id);
            return this.getUntrackedTmuxSessions(remoteId).length > 0 ||
                this.getUntrackedZellijSessions(remoteId).length > 0;
        });
    }

    private hasNonLocalTask(items: TaskItem[]): boolean {
        return items.some(item => {
            if (item.type === 'task') {
                return normalizeRemoteId(item.remoteId) !== LOCAL_REMOTE_ID;
            }
            return this.hasNonLocalTask(item.children);
        });
    }

    private filterItemsForRemote(items: TaskItem[], remoteId: string): TaskItem[] {
        remoteId = normalizeRemoteId(remoteId);
        const result: TaskItem[] = [];

        for (const item of items) {
            if (item.type === 'task') {
                if (normalizeRemoteId(item.remoteId) === remoteId) {
                    result.push(item);
                }
            } else {
                const children = this.filterItemsForRemote(item.children, remoteId);
                if (children.length > 0) {
                    result.push({ ...item, children });
                }
            }
        }

        return result;
    }

    private remoteIdFromTreeId(treeId?: string): string {
        if (!treeId) {
            return LOCAL_REMOTE_ID;
        }

        const match = treeId.match(/^(?:folder|task)-(.+)::/);
        return match ? match[1] : LOCAL_REMOTE_ID;
    }

    private getTaskTerminalName(taskName: string, remoteId: string = LOCAL_REMOTE_ID): string {
        remoteId = normalizeRemoteId(remoteId);
        return remoteId === LOCAL_REMOTE_ID ? taskName : `${remoteId}: ${taskName}`;
    }

    private getSessionTerminalName(kind: 'tmux' | 'zellij', sessionName: string, remoteId: string = LOCAL_REMOTE_ID): string {
        remoteId = normalizeRemoteId(remoteId);
        return remoteId === LOCAL_REMOTE_ID
            ? `${kind}: ${sessionName}`
            : `${kind}@${remoteId}: ${sessionName}`;
    }

    private shortenPath(fullPath: string): string {
        // Show last 2-3 components
        const parts = fullPath.replace(/\\/g, '/').split('/').filter(p => p);
        if (parts.length <= 3) {
            return fullPath;
        }
        return '.../' + parts.slice(-2).join('/');
    }

    private buildTaskTooltip(task: TerminalTaskItem, profile?: Profile): string {
        const lines: string[] = [
            `Task: ${task.name}`,
            `Path: ${task.path}`
        ];

        if (profile) {
            lines.push(`Profile: ${profile.name}`);
            if (profile.tmux?.enabled) {
                lines.push(`tmux: ${profile.tmux.mode}`);
            } else if (profile.zellij?.enabled) {
                lines.push(`zellij: ${profile.zellij.mode}`);
            }
        }

        if (task.tags?.length) {
            lines.push(`Tags: ${task.tags.join(', ')}`);
        }

        return lines.join('\n');
    }
}

export class TaskTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemData?: TreeItemData
    ) {
        super(label, collapsibleState);
    }
}

// ============================================================================
// DRAG AND DROP CONTROLLER
// ============================================================================

export class TerminalTasksDragAndDropController implements vscode.TreeDragAndDropController<TaskTreeItem> {
    private static readonly MIME_TYPE = 'application/vnd.code.tree.terminalworkspacesview';

    readonly dropMimeTypes: readonly string[] = [TerminalTasksDragAndDropController.MIME_TYPE];
    readonly dragMimeTypes: readonly string[] = [TerminalTasksDragAndDropController.MIME_TYPE];

    constructor(
        private configManager: ConfigManager,
        private treeDataProvider: TerminalTasksProvider
    ) {}

    handleDrag(
        source: readonly TaskTreeItem[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): void {
        // Only allow dragging config items (tasks and folders), not session items
        const draggableItems = source.filter(item => {
            const type = item.itemData?.type;
            return type === 'task' || type === 'folder';
        });

        if (draggableItems.length === 0) {
            return;
        }

        const itemIds = draggableItems
            .map(item => {
                const data = item.itemData as TaskItem;
                return data?.id;
            })
            .filter((id): id is string => !!id);

        dataTransfer.set(
            TerminalTasksDragAndDropController.MIME_TYPE,
            new vscode.DataTransferItem(itemIds)
        );
    }

    async handleDrop(
        target: TaskTreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        const transferItem = dataTransfer.get(TerminalTasksDragAndDropController.MIME_TYPE);
        if (!transferItem) {
            return;
        }

        const itemIds: string[] = transferItem.value;
        if (!itemIds || itemIds.length === 0) {
            return;
        }

        // Determine drop target context
        const targetData = target?.itemData;

        // Reject drops onto session-related items
        if (targetData && 'type' in targetData) {
            const targetType = targetData.type;
            if (targetType === 'remoteHeader' ||
                targetType === 'tmuxSessionsHeader' || targetType === 'tmuxSession' ||
                targetType === 'zellijSessionsHeader' || targetType === 'zellijSession') {
                return;
            }
        }

        for (const itemId of itemIds) {
            if (token.isCancellationRequested) {
                break;
            }

            try {
                if (!targetData) {
                    // Dropped on root (empty space) — move to end of root items
                    await this.configManager.reorderItem(itemId, null, Infinity);
                } else if (targetData.type === 'folder') {
                    // Dropped onto a folder — move into that folder at the end
                    await this.configManager.reorderItem(itemId, targetData.id, Infinity);
                } else if (targetData.type === 'task') {
                    // Dropped onto a task — insert right after that task in its parent
                    const targetItem = this.configManager.findItemById(targetData.id);
                    if (targetItem) {
                        const parentId = targetItem.parent ? targetItem.parent.id : null;
                        await this.configManager.reorderItem(itemId, parentId, targetItem.index + 1);
                    }
                }
            } catch (error) {
                console.error(`Failed to move item ${itemId}:`, error);
            }
        }

        this.treeDataProvider.refresh();
    }
}

// ============================================================================
// PROFILE PICKER PROVIDER
// ============================================================================

export class ProfileQuickPick {
    static async show(configManager: ConfigManager, currentProfileId?: string): Promise<Profile | undefined> {
        const profiles = configManager.getAllProfiles();

        const items: (vscode.QuickPickItem & { profile: Profile })[] = profiles.map(profile => ({
            label: profile.name,
            description: profile.description,
            detail: profile.builtin ? 'Built-in' : 'Custom',
            picked: profile.id === currentProfileId,
            profile
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a terminal profile',
            matchOnDescription: true
        });

        return selected?.profile;
    }
}

export class RemoteQuickPick {
    static async show(configManager: ConfigManager, currentRemoteId?: string): Promise<RemoteConfig | undefined> {
        const remotes = configManager.getRemotes();

        const items: (vscode.QuickPickItem & { remote: RemoteConfig })[] = remotes.map(remote => ({
            label: remote.label,
            description: remote.type === 'ssh' ? remote.host : 'local',
            detail: remote.id,
            picked: normalizeRemoteId(currentRemoteId) === normalizeRemoteId(remote.id),
            remote
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select remote host',
            matchOnDescription: true,
            matchOnDetail: true
        });

        return selected?.remote;
    }
}

// ============================================================================
// FOLDER PICKER PROVIDER
// ============================================================================

export class FolderQuickPick {
    static async show(configManager: ConfigManager, excludeId?: string): Promise<{ id: string; path: string } | null | undefined> {
        const folders = configManager.getFolderPaths();

        // Filter out the item being moved (can't move into itself)
        const filteredFolders = excludeId
            ? folders.filter(f => f.id !== excludeId)
            : folders;

        const items: vscode.QuickPickItem[] = [
            { label: '$(home) Root', description: 'Move to root level' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...filteredFolders.map(f => ({
                label: `$(folder) ${f.path}`,
                description: '',
                detail: f.id
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select destination folder'
        });

        if (!selected) {
            return undefined;
        }

        if (selected.label === '$(home) Root') {
            return null; // Move to root
        }

        const folder = filteredFolders.find(f => f.id === selected.detail);
        return folder;
    }
}

// ============================================================================
// TASK CONFIGURATION DIALOG
// ============================================================================

export interface TaskConfigResult {
    name: string;
    path: string;
    remoteId?: string;
    profileId: string;
    tags?: string[];
    overrides?: {
        tmux?: {
            enabled?: boolean;
            mode?: TmuxMode;
            sessionName?: string;
        };
        icon?: string;
        colors?: {
            background?: string;
        };
        env?: Record<string, string>;
        postCommands?: string[];
    };
}

export class TaskConfigDialog {
    static async showCreate(
        configManager: ConfigManager,
        defaultPath: string,
        defaultName: string,
        defaultRemoteId?: string
    ): Promise<TaskConfigResult | undefined> {
        // Step 1: Name
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for this terminal task',
            value: defaultName,
            validateInput: value => value.trim() ? null : 'Name cannot be empty'
        });

        if (!name) {
            return undefined;
        }

        const config = await configManager.getConfig();

        // Step 2: Remote selection
        const remote = defaultRemoteId
            ? configManager.getRemote(defaultRemoteId)
            : config.remotes.length > 1
            ? await RemoteQuickPick.show(configManager, 'local')
            : configManager.getRemote('local');

        if (!remote) {
            return undefined;
        }

        // Step 3: Profile selection
        const profile = await ProfileQuickPick.show(configManager, config.defaultProfileId);

        if (!profile) {
            return undefined;
        }

        // Step 4: Optional - tmux session name (if tmux enabled)
        let tmuxSessionName: string | undefined;
        if (profile.tmux?.enabled) {
            const customSession = await vscode.window.showInputBox({
                prompt: 'tmux session name (leave empty to use task name, ESC to cancel)',
                placeHolder: name.replace(/[^a-zA-Z0-9_-]/g, '_')
            });
            // undefined means ESC was pressed - cancel the whole wizard
            if (customSession === undefined) {
                return undefined;
            }
            tmuxSessionName = customSession || undefined;
        }

        // Step 5: Optional - tags
        const tagsInput = await vscode.window.showInputBox({
            prompt: 'Tags (comma-separated, optional - press Enter to skip, ESC to cancel)',
            placeHolder: 'work, frontend, important'
        });

        // undefined means ESC was pressed - cancel the whole wizard
        if (tagsInput === undefined) {
            return undefined;
        }

        const tags = tagsInput
            ? tagsInput.split(',').map(t => t.trim()).filter(t => t)
            : undefined;

        return {
            name,
            path: defaultPath,
            remoteId: remote.id,
            profileId: profile.id,
            tags,
            overrides: tmuxSessionName ? {
                tmux: {
                    sessionName: tmuxSessionName
                }
            } : undefined
        };
    }

    static async showEdit(
        configManager: ConfigManager,
        task: TerminalTaskItem
    ): Promise<Partial<TaskConfigResult> | undefined> {
        const actions = await vscode.window.showQuickPick([
            { label: '$(edit) Rename', action: 'rename' },
            { label: '$(folder-opened) Change folder', action: 'path' },
            { label: '$(server-environment) Change remote', action: 'remote' },
            { label: '$(symbol-misc) Change profile', action: 'profile' },
            { label: '$(tag) Edit tags', action: 'tags' },
            { label: '$(settings-gear) Advanced settings', action: 'advanced' }
        ], {
            placeHolder: `Edit "${task.name}"`
        });

        if (!actions) {
            return undefined;
        }

        switch (actions.action) {
            case 'rename': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter new name',
                    value: task.name,
                    validateInput: value => value.trim() ? null : 'Name cannot be empty'
                });
                return name ? { name } : undefined;
            }

            case 'path': {
                const folderUri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    defaultUri: vscode.Uri.file(task.path),
                    openLabel: 'Select Folder'
                });
                return folderUri?.[0] ? { path: folderUri[0].fsPath } : undefined;
            }

            case 'profile': {
                const profile = await ProfileQuickPick.show(configManager, task.profileId);
                return profile ? { profileId: profile.id } : undefined;
            }

            case 'remote': {
                const remote = await RemoteQuickPick.show(configManager, task.remoteId);
                return remote ? { remoteId: remote.id } : undefined;
            }

            case 'tags': {
                const tagsInput = await vscode.window.showInputBox({
                    prompt: 'Tags (comma-separated)',
                    value: task.tags?.join(', ') || ''
                });
                if (tagsInput === undefined) {
                    return undefined;
                }
                const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);
                return { tags: tags.length > 0 ? tags : undefined };
            }

            case 'advanced': {
                return this.showAdvancedSettings(configManager, task);
            }

            default:
                return undefined;
        }
    }

    private static async showAdvancedSettings(
        configManager: ConfigManager,
        task: TerminalTaskItem
    ): Promise<Partial<TaskConfigResult> | undefined> {
        const profile = configManager.getProfile(task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');

        const options = await vscode.window.showQuickPick([
            {
                label: '$(terminal) tmux settings',
                description: profile?.tmux?.enabled ? 'Enabled' : 'Disabled',
                action: 'tmux'
            },
            {
                label: '$(symbol-color) Terminal color',
                description: task.overrides?.colors?.background || 'Default',
                action: 'color'
            },
            {
                label: '$(play) Startup commands',
                description: task.overrides?.postCommands?.length ? `${task.overrides.postCommands.length} commands` : 'None',
                action: 'commands'
            },
            {
                label: '$(symbol-variable) Environment variables',
                description: task.overrides?.env ? `${Object.keys(task.overrides.env).length} vars` : 'None',
                action: 'env'
            }
        ], {
            placeHolder: 'Advanced settings'
        });

        if (!options) {
            return undefined;
        }

        switch (options.action) {
            case 'tmux': {
                const tmuxMode = await vscode.window.showQuickPick([
                    { label: 'Disabled', mode: 'none' as TmuxMode },
                    { label: 'Attach or Create', description: 'Reattach if session exists, create if not', mode: 'attach-or-create' as TmuxMode },
                    { label: 'Always New', description: 'Always create a new session', mode: 'always-new' as TmuxMode },
                    { label: 'Attach Only', description: 'Only attach, fail if session doesn\'t exist', mode: 'attach-only' as TmuxMode }
                ], {
                    placeHolder: 'tmux mode'
                });

                if (!tmuxMode) {
                    return undefined;
                }

                if (tmuxMode.mode === 'none') {
                    return {
                        overrides: {
                            ...task.overrides,
                            tmux: { enabled: false }
                        }
                    };
                }

                const sessionName = await vscode.window.showInputBox({
                    prompt: 'Session name (leave empty for task name)',
                    value: task.overrides?.tmux?.sessionName || ''
                });

                return {
                    overrides: {
                        ...task.overrides,
                        tmux: {
                            enabled: true,
                            mode: tmuxMode.mode,
                            sessionName: sessionName || undefined
                        }
                    }
                };
            }

            case 'color': {
                const color = await vscode.window.showInputBox({
                    prompt: 'Terminal tab color (hex like #ff0000, or leave empty for default)',
                    value: task.overrides?.colors?.background || '',
                    validateInput: value => {
                        if (!value) return null;
                        if (/^#[0-9A-Fa-f]{6}$/.test(value)) return null;
                        return 'Enter a valid hex color like #ff0000';
                    }
                });

                if (color === undefined) {
                    return undefined;
                }

                return {
                    overrides: {
                        ...task.overrides,
                        colors: color ? { background: color } : undefined
                    }
                };
            }

            case 'commands': {
                const commands = await vscode.window.showInputBox({
                    prompt: 'Commands to run after cd (semicolon-separated)',
                    value: task.overrides?.postCommands?.join('; ') || '',
                    placeHolder: 'npm install; npm run dev'
                });

                if (commands === undefined) {
                    return undefined;
                }

                return {
                    overrides: {
                        ...task.overrides,
                        postCommands: commands
                            ? commands.split(';').map(c => c.trim()).filter(c => c)
                            : undefined
                    }
                };
            }

            case 'env': {
                const envInput = await vscode.window.showInputBox({
                    prompt: 'Environment variables (KEY=value, comma-separated)',
                    value: task.overrides?.env
                        ? Object.entries(task.overrides.env).map(([k, v]) => `${k}=${v}`).join(', ')
                        : '',
                    placeHolder: 'NODE_ENV=development, DEBUG=true'
                });

                if (envInput === undefined) {
                    return undefined;
                }

                const env: Record<string, string> = {};
                if (envInput) {
                    envInput.split(',').forEach(pair => {
                        const [key, ...valueParts] = pair.split('=');
                        if (key && valueParts.length > 0) {
                            env[key.trim()] = valueParts.join('=').trim();
                        }
                    });
                }

                return {
                    overrides: {
                        ...task.overrides,
                        env: Object.keys(env).length > 0 ? env : undefined
                    }
                };
            }

            default:
                return undefined;
        }
    }
}
