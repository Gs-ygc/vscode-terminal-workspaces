import * as vscode from 'vscode';
import {
    TerminalTasksConfig,
    TaskItem,
    TerminalTaskItem,
    TaskFolder,
    Profile,
    RemoteConfig,
    FlattenedTask,
    BUILTIN_PROFILES,
    DEFAULT_CONFIG
} from './types';
import { buildSshCommand, createLocalRemote, LOCAL_REMOTE_ID, normalizeRemoteId, shellQuote } from './remoteUtils';

export type ConfigScope = 'workspace' | 'global';

export class ConfigManager {
    private config: TerminalTasksConfig | null = null;
    private configUri: vscode.Uri | null = null;
    private configScope: ConfigScope = 'global';

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Which scope is currently active ('workspace' or 'global').
     */
    getConfigScope(): ConfigScope {
        return this.configScope;
    }

    /**
     * Get the workspace-scoped config URI (only if a workspace folder is open).
     */
    private getWorkspaceConfigUri(): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'terminal-workspaces.json');
    }

    /**
     * Get the global (user-scoped) config URI stored in extension global storage.
     */
    private getGlobalConfigUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, 'terminal-workspaces.json');
    }

    /**
     * Resolve the best config URI: workspace when available, otherwise global.
     */
    private resolveConfigUri(): { uri: vscode.Uri; scope: ConfigScope } {
        const workspaceUri = this.getWorkspaceConfigUri();
        if (workspaceUri) {
            return { uri: workspaceUri, scope: 'workspace' };
        }
        return { uri: this.getGlobalConfigUri(), scope: 'global' };
    }

    private getVscodeDirUri(): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return vscode.Uri.joinPath(folders[0].uri, '.vscode');
    }

    getConfigFileUri(): vscode.Uri | undefined {
        return this.configUri ?? undefined;
    }

    getTasksJsonUri(): vscode.Uri | undefined {
        // tasks.json is only meaningful in a workspace context
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'tasks.json');
    }

    private async uriExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Load configuration from file or create default.
     * Prefers workspace config when a workspace is open; falls back to global storage.
     */
    async loadConfig(): Promise<TerminalTasksConfig> {
        const { uri, scope } = this.resolveConfigUri();
        this.configScope = scope;
        this.configUri = uri;

        // Ensure the parent directory exists
        const parentUri = vscode.Uri.joinPath(uri, '..');
        await vscode.workspace.fs.createDirectory(parentUri);

        if (!(await this.uriExists(uri))) {
            this.config = this.normalizeConfig({ ...DEFAULT_CONFIG });
            return this.config;
        }

        try {
            const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            this.config = this.normalizeConfig(JSON.parse(content));
            return this.config!;
        } catch (error) {
            console.error('Failed to load terminal-workspaces.json:', error);
            this.config = this.normalizeConfig({ ...DEFAULT_CONFIG });
            return this.config;
        }
    }

    private normalizeConfig(config: TerminalTasksConfig): TerminalTasksConfig {
        const normalized: TerminalTasksConfig = {
            ...DEFAULT_CONFIG,
            ...config,
            settings: {
                ...DEFAULT_CONFIG.settings,
                ...(config.settings || {})
            },
            profiles: config.profiles || [],
            items: config.items || [],
            remotes: config.remotes?.length ? config.remotes : [createLocalRemote()]
        };

        const hasLocal = normalized.remotes.some(remote => remote.type === 'local');
        if (!hasLocal) {
            normalized.remotes.unshift(createLocalRemote());
        }

        normalized.remotes = normalized.remotes.map(remote => ({
            ...remote,
            id: remote.type === 'local'
                ? LOCAL_REMOTE_ID
                : remote.id || remote.host || remote.label,
            label: remote.label || remote.id || remote.host || 'Remote'
        }));

        const remoteIds = new Set(normalized.remotes.map(remote => remote.id));
        const normalizeItems = (items: TaskItem[]) => {
            for (const item of items) {
                if (item.type === 'task') {
                    const remoteId = normalizeRemoteId(item.remoteId);
                    item.remoteId = remoteIds.has(remoteId) ? remoteId : LOCAL_REMOTE_ID;
                } else {
                    normalizeItems(item.children);
                }
            }
        };
        normalizeItems(normalized.items);

        return normalized;
    }

    /**
     * Save configuration to file (workspace or global storage, whichever is active).
     */
    async saveConfig(): Promise<void> {
        if (!this.config) {
            throw new Error('No configuration loaded');
        }

        // If configUri is not set yet (first save before any loadConfig), resolve it now
        if (!this.configUri) {
            const { uri, scope } = this.resolveConfigUri();
            this.configUri = uri;
            this.configScope = scope;
        }

        const parentUri = vscode.Uri.joinPath(this.configUri, '..');
        await vscode.workspace.fs.createDirectory(parentUri);

        // Also ensure .vscode dir exists when writing workspace config
        if (this.configScope === 'workspace') {
            const vscodeDirUri = this.getVscodeDirUri();
            if (vscodeDirUri) {
                await vscode.workspace.fs.createDirectory(vscodeDirUri);
            }
        }

        const content = JSON.stringify(this.config, null, 2);
        await vscode.workspace.fs.writeFile(this.configUri, Buffer.from(content, 'utf8'));

        // tasks.json is only generated for workspace configs
        if (this.configScope === 'workspace' && this.config.settings.autoGenerateTasksJson) {
            await this.generateTasksJson();
        }
    }

    /**
     * Get current config (loads if necessary)
     */
    async getConfig(): Promise<TerminalTasksConfig> {
        if (!this.config) {
            return this.loadConfig();
        }
        return this.config;
    }

    getConfigSync(): TerminalTasksConfig | undefined {
        return this.config || undefined;
    }

    // =========================================================================
    // PROFILE MANAGEMENT
    // =========================================================================

    /**
     * Get all profiles (built-in + user-defined)
     */
    getAllProfiles(): Profile[] {
        return [...BUILTIN_PROFILES, ...(this.config?.profiles || [])];
    }

    /**
     * Get a profile by ID
     */
    getProfile(id: string): Profile | undefined {
        return this.getAllProfiles().find(p => p.id === id);
    }

    getRemotes(): RemoteConfig[] {
        return this.config?.remotes || [createLocalRemote()];
    }

    getRemote(id?: string): RemoteConfig {
        const remoteId = normalizeRemoteId(id);
        return this.getRemotes().find(remote => remote.id === remoteId) || createLocalRemote();
    }

    getTaskRemote(task: TerminalTaskItem): RemoteConfig {
        return this.getRemote(task.remoteId);
    }

    async addRemote(remote: Omit<RemoteConfig, 'id'> & { id?: string }): Promise<RemoteConfig> {
        const config = await this.getConfig();
        const baseId = this.sanitizeRemoteId(remote.id || remote.host || remote.label);
        let id = baseId || `remote_${Date.now()}`;
        let suffix = 2;

        const duplicate = config.remotes.find(existing =>
            existing.type === remote.type && (
                existing.host?.toLowerCase() === remote.host?.toLowerCase() ||
                existing.id.toLowerCase() === id.toLowerCase() ||
                existing.label.toLowerCase() === remote.label.toLowerCase()
            )
        );
        if (duplicate) {
            throw new Error(`Remote "${duplicate.label}" already exists`);
        }

        while (config.remotes.some(existing => existing.id === id)) {
            id = `${baseId}_${suffix++}`;
        }

        const newRemote: RemoteConfig = {
            ...remote,
            id,
            label: remote.label || remote.host || id
        };

        config.remotes.push(newRemote);
        await this.saveConfig();
        return newRemote;
    }

    async deleteRemote(remoteId: string): Promise<void> {
        const config = await this.getConfig();
        const index = config.remotes.findIndex(r => r.id === remoteId);
        if (index === -1) {
            throw new Error(`Remote "${remoteId}" not found`);
        }
        if (config.remotes[index].type === 'local') {
            throw new Error('Cannot delete the local host entry');
        }
        config.remotes.splice(index, 1);
        // Clear remoteId from tasks that pointed at this remote
        const clearRemote = (items: import('./types').TaskItem[]) => {
            for (const item of items) {
                if (item.type === 'task' && item.remoteId === remoteId) {
                    delete item.remoteId;
                } else if (item.type === 'folder') {
                    clearRemote(item.children);
                }
            }
        };
        clearRemote(config.items);
        await this.saveConfig();
    }

    private sanitizeRemoteId(value: string): string {
        return value
            .trim()
            .replace(/^[^a-zA-Z0-9]+/, '')
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 50);
    }

    /**
     * Add a custom profile
     */
    async addProfile(profile: Profile): Promise<void> {
        const config = await this.getConfig();
        config.profiles.push(profile);
        await this.saveConfig();
    }

    /**
     * Update a custom profile
     */
    async updateProfile(id: string, updates: Partial<Profile>): Promise<void> {
        const config = await this.getConfig();
        const index = config.profiles.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Profile "${id}" not found or is built-in`);
        }
        config.profiles[index] = { ...config.profiles[index], ...updates };
        await this.saveConfig();
    }

    /**
     * Delete a custom profile
     */
    async deleteProfile(id: string): Promise<void> {
        const config = await this.getConfig();
        const index = config.profiles.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Profile "${id}" not found or is built-in`);
        }
        config.profiles.splice(index, 1);
        await this.saveConfig();
    }

    // =========================================================================
    // TASK ITEM MANAGEMENT
    // =========================================================================

    /**
     * Generate a unique ID
     */
    private generateId(): string {
        return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Find an item by ID (recursive)
     */
    findItemById(id: string, items?: TaskItem[]): { item: TaskItem; parent: TaskFolder | null; index: number } | null {
        const searchItems = items || this.config?.items || [];

        for (let i = 0; i < searchItems.length; i++) {
            const item = searchItems[i];
            if (item.id === id) {
                return { item, parent: null, index: i };
            }
            if (item.type === 'folder') {
                const found = this.findItemById(id, item.children);
                if (found) {
                    if (found.parent === null) {
                        found.parent = item;
                    }
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * Add a task to the root or a folder
     */
    async addTask(task: Omit<TerminalTaskItem, 'id' | 'type'>, parentFolderId?: string): Promise<TerminalTaskItem> {
        const config = await this.getConfig();

        const newTask: TerminalTaskItem = {
            ...task,
            id: this.generateId(),
            type: 'task'
        };

        if (parentFolderId) {
            const found = this.findItemById(parentFolderId);
            if (!found || found.item.type !== 'folder') {
                throw new Error(`Folder "${parentFolderId}" not found`);
            }
            (found.item as TaskFolder).children.push(newTask);
        } else {
            config.items.push(newTask);
        }

        await this.saveConfig();
        return newTask;
    }

    /**
     * Add a folder to the root or another folder
     */
    async addFolder(name: string, parentFolderId?: string): Promise<TaskFolder> {
        const config = await this.getConfig();

        const newFolder: TaskFolder = {
            id: this.generateId(),
            type: 'folder',
            name,
            children: [],
            expanded: true
        };

        if (parentFolderId) {
            const found = this.findItemById(parentFolderId);
            if (!found || found.item.type !== 'folder') {
                throw new Error(`Folder "${parentFolderId}" not found`);
            }
            (found.item as TaskFolder).children.push(newFolder);
        } else {
            config.items.push(newFolder);
        }

        await this.saveConfig();
        return newFolder;
    }

    /**
     * Update a task
     */
    async updateTask(id: string, updates: Partial<Omit<TerminalTaskItem, 'id' | 'type'>>): Promise<void> {
        const found = this.findItemById(id);
        if (!found || found.item.type !== 'task') {
            throw new Error(`Task "${id}" not found`);
        }

        Object.assign(found.item, updates);
        await this.saveConfig();
    }

    /**
     * Update a folder
     */
    async updateFolder(id: string, updates: Partial<Omit<TaskFolder, 'id' | 'type' | 'children'>>): Promise<void> {
        const found = this.findItemById(id);
        if (!found || found.item.type !== 'folder') {
            throw new Error(`Folder "${id}" not found`);
        }

        Object.assign(found.item, updates);
        await this.saveConfig();
    }

    /**
     * Delete an item (task or folder)
     */
    async deleteItem(id: string): Promise<void> {
        const config = await this.getConfig();

        const deleteFromArray = (items: TaskItem[]): boolean => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].id === id) {
                    items.splice(i, 1);
                    return true;
                }
                if (items[i].type === 'folder') {
                    if (deleteFromArray((items[i] as TaskFolder).children)) {
                        return true;
                    }
                }
            }
            return false;
        };

        if (!deleteFromArray(config.items)) {
            throw new Error(`Item "${id}" not found`);
        }

        await this.saveConfig();
    }

    /**
     * Move an item to a different parent
     */
    async moveItem(id: string, newParentId: string | null): Promise<void> {
        const config = await this.getConfig();
        const found = this.findItemById(id);
        if (!found) {
            throw new Error(`Item "${id}" not found`);
        }

        // Remove from current location
        if (found.parent) {
            found.parent.children.splice(found.index, 1);
        } else {
            config.items.splice(found.index, 1);
        }

        // Add to new location
        if (newParentId) {
            const newParent = this.findItemById(newParentId);
            if (!newParent || newParent.item.type !== 'folder') {
                throw new Error(`Folder "${newParentId}" not found`);
            }
            (newParent.item as TaskFolder).children.push(found.item);
        } else {
            config.items.push(found.item);
        }

        await this.saveConfig();
    }

    /**
     * Move an item to a specific position within a target parent.
     * Used for drag-and-drop reordering.
     */
    async reorderItem(itemId: string, targetParentId: string | null, targetIndex: number): Promise<void> {
        const config = await this.getConfig();
        const found = this.findItemById(itemId);
        if (!found) {
            return; // Item not found, silently ignore
        }

        // Prevent moving a folder into itself or a descendant
        if (targetParentId && this.isDescendantOf(targetParentId, itemId)) {
            return;
        }

        // Get the source array
        const sourceArray = found.parent ? found.parent.children : config.items;

        // Get the target array
        let targetArray: TaskItem[];
        if (targetParentId) {
            const targetParent = this.findItemById(targetParentId);
            if (!targetParent || targetParent.item.type !== 'folder') {
                return; // Invalid target
            }
            targetArray = (targetParent.item as TaskFolder).children;
        } else {
            targetArray = config.items;
        }

        const sameParent = sourceArray === targetArray;

        // Remove from source
        sourceArray.splice(found.index, 1);

        // Adjust target index if same parent and item was before the target
        let adjustedIndex = targetIndex;
        if (sameParent && found.index < targetIndex) {
            adjustedIndex = targetIndex - 1;
        }

        // Clamp to valid range
        adjustedIndex = Math.max(0, Math.min(adjustedIndex, targetArray.length));

        // Insert at target position
        targetArray.splice(adjustedIndex, 0, found.item);

        await this.saveConfig();
    }

    /**
     * Check if targetId is a descendant of ancestorId (or the same item).
     * Prevents circular nesting when dragging folders.
     */
    private isDescendantOf(targetId: string, ancestorId: string): boolean {
        if (targetId === ancestorId) {
            return true;
        }

        const ancestor = this.findItemById(ancestorId);
        if (!ancestor || ancestor.item.type !== 'folder') {
            return false;
        }

        const folder = ancestor.item as TaskFolder;
        for (const child of folder.children) {
            if (child.id === targetId) {
                return true;
            }
            if (child.type === 'folder' && this.isDescendantOf(targetId, child.id)) {
                return true;
            }
        }

        return false;
    }

    // =========================================================================
    // FLATTENING & TRAVERSAL
    // =========================================================================

    /**
     * Get all tasks flattened (for generating tasks.json)
     */
    flattenTasks(items?: TaskItem[], parentPath: string[] = [], parentNames: string[] = []): FlattenedTask[] {
        const searchItems = items || this.config?.items || [];
        const result: FlattenedTask[] = [];

        for (const item of searchItems) {
            if (item.type === 'task') {
                result.push({
                    idPath: [...parentPath, item.id],
                    namePath: [...parentNames, item.name],
                    task: item,
                    depth: parentPath.length
                });
            } else if (item.type === 'folder') {
                result.push(...this.flattenTasks(
                    item.children,
                    [...parentPath, item.id],
                    [...parentNames, item.name]
                ));
            }
        }

        return result;
    }

    /**
     * Get all folder paths (for UI dropdown)
     */
    getFolderPaths(items?: TaskItem[], parentPath: string = ''): { id: string; path: string }[] {
        const searchItems = items || this.config?.items || [];
        const result: { id: string; path: string }[] = [];

        for (const item of searchItems) {
            if (item.type === 'folder') {
                const currentPath = parentPath ? `${parentPath}/${item.name}` : item.name;
                result.push({ id: item.id, path: currentPath });
                result.push(...this.getFolderPaths(item.children, currentPath));
            }
        }

        return result;
    }

    // =========================================================================
    // TASKS.JSON GENERATION
    // =========================================================================

    /**
     * Generate VS Code tasks.json from our config
     */
    async generateTasksJson(): Promise<void> {
        const config = await this.getConfig();
        const tasksJsonUri = this.getTasksJsonUri();
        if (!tasksJsonUri) {
            return;
        }

        const flatTasks = this.flattenTasks();

        interface VscodeTask {
            label: string;
            type: string;
            command: string;
            options?: {
                shell?: {
                    executable?: string;
                    args?: string[];
                };
                cwd?: string;
            };
            presentation: {
                panel: string;
                name: string;
                reveal?: string;
            };
            isBackground: boolean;
            problemMatcher: string[];
            dependsOn?: string[];
        }

        const tasks: VscodeTask[] = [];

        // Generate individual tasks
        for (const flatTask of flatTasks) {
            const task = flatTask.task;
            const generated = this.generateTaskCommand(task);

            const vscodeTask: VscodeTask = {
                label: task.name,
                type: 'shell',
                command: generated.command,
                presentation: {
                    panel: 'new',
                    name: task.name
                },
                isBackground: true,
                problemMatcher: []
            };

            if (generated.shellOptions) {
                vscodeTask.options = { shell: generated.shellOptions };
            }

            tasks.push(vscodeTask);
        }

        // Generate group task if enabled
        if (config.settings.createGroupTask && tasks.length > 0) {
            tasks.unshift({
                label: config.settings.groupTaskLabel,
                type: 'shell',
                command: 'echo "Opening all terminals..."',
                dependsOn: tasks.map(t => t.label),
                presentation: {
                    panel: 'new',
                    name: config.settings.groupTaskLabel
                },
                isBackground: true,
                problemMatcher: []
            });
        }

        const tasksJson = {
            version: '2.0.0',
            tasks
        };

        const vscodeDirUri = this.getVscodeDirUri();
        if (vscodeDirUri) {
            await vscode.workspace.fs.createDirectory(vscodeDirUri);
        }
        await vscode.workspace.fs.writeFile(tasksJsonUri, Buffer.from(JSON.stringify(tasksJson, null, 2), 'utf8'));
    }

    /**
     * Merge profile with task-specific overrides
     */
    private mergeProfileWithOverrides(profile: Profile, overrides?: Partial<Profile>): Profile {
        if (!overrides) {
            return profile;
        }
        return {
            ...profile,
            ...overrides,
            tmux: overrides.tmux ? { ...profile.tmux, ...overrides.tmux } : profile.tmux,
            zellij: overrides.zellij ? { ...profile.zellij, ...overrides.zellij } : profile.zellij,
            colors: overrides.colors ? { ...profile.colors, ...overrides.colors } : profile.colors,
            env: overrides.env ? { ...profile.env, ...overrides.env } : profile.env
        };
    }

    /**
     * Generate the shell command and options for a task
     * Made public so extension can create terminals directly for editor location
     */
    public generateTaskCommand(task: TerminalTaskItem): { command: string; shellOptions?: { executable?: string; args?: string[] } } {
        const config = this.config!;
        const profile = this.getProfile(task.profileId || config.defaultProfileId) || BUILTIN_PROFILES[0];
        const merged = this.mergeProfileWithOverrides(profile, task.overrides);
        const remote = this.getTaskRemote(task);
        if (remote.type === 'ssh') {
            const sessionName = this.getSessionName(merged, task.name);
            const remoteCommand = this.buildBashCommand(task.path, sessionName, merged);
            return { command: buildSshCommand(remote, remoteCommand, true) };
        }
        return this.generateCommand(task.path, task.name, merged);
    }

    private generateCommand(folderPath: string, taskName: string, profile: Profile): { command: string; shellOptions?: { executable?: string; args?: string[] } } {
        const wslPath = this.toWslPath(folderPath);
        const windowsPath = this.toWindowsPath(folderPath);

        const sessionName = this.getSessionName(profile, taskName);

        let command = '';
        let shellOptions: { executable?: string; args?: string[] } | undefined;

        // Build command based on shell type
        switch (profile.shellType) {
            case 'wsl':
                if (!this.isWindows()) {
                    // Remote hosts and native Unix-like systems run shell commands directly.
                    command = this.buildBashCommand(wslPath, sessionName, profile);
                } else {
                    // On Windows, use wsl.exe
                    command = `wsl.exe --cd "${windowsPath}"`;
                    if (profile.tmux?.enabled) {
                        command = `wsl.exe -e bash -lc "cd '${wslPath}' && ${this.buildTmuxCommand(sessionName, profile)}"`;
                    } else if (profile.zellij?.enabled) {
                        command = `wsl.exe -e bash -lc "cd '${wslPath}' && ${this.buildZellijCommand(sessionName, profile)}"`;
                    }
                    shellOptions = { executable: 'cmd.exe', args: ['/C'] };
                }
                break;

            case 'wsl-bash':
                if (!this.isWindows()) {
                    command = this.buildBashCommand(wslPath, sessionName, profile);
                } else {
                    command = `wsl.exe -e bash -c "${this.buildBashCommand(wslPath, sessionName, profile).replace(/"/g, '\\"')}"`;
                    shellOptions = { executable: 'cmd.exe', args: ['/C'] };
                }
                break;

            case 'powershell':
                command = `Set-Location '${windowsPath}'`;
                if (profile.postCommands?.length) {
                    command += '; ' + profile.postCommands.join('; ');
                }
                shellOptions = { executable: 'powershell.exe' };
                break;

            case 'cmd':
                command = `cd /d "${windowsPath}"`;
                if (profile.postCommands?.length) {
                    command += ' && ' + profile.postCommands.join(' && ');
                }
                shellOptions = { executable: 'cmd.exe', args: ['/K'] };
                break;

            case 'bash':
            case 'zsh':
                command = this.buildBashCommand(folderPath, sessionName, profile);
                break;

            case 'default':
                // Use VS Code's default - minimal command
                command = `cd '${this.isWindows() ? windowsPath : folderPath}'`;
                break;

            case 'custom':
                if (profile.customShell) {
                    command = this.buildBashCommand(folderPath, sessionName, profile);
                    shellOptions = {
                        executable: profile.customShell,
                        args: profile.customShellArgs
                    };
                }
                break;
        }

        return { command, shellOptions };
    }

    /**
     * Build bash/zsh command with optional tmux or zellij
     */
    private buildBashCommand(folderPath: string, sessionName: string, profile: Profile): string {
        const parts: string[] = [];

        // Pre-commands
        if (profile.preCommands?.length) {
            parts.push(...profile.preCommands);
        }

        // CD to directory
        parts.push(`cd ${shellQuote(folderPath)}`);

        // Post-commands
        if (profile.postCommands?.length) {
            parts.push(...profile.postCommands);
        }

        // Multiplexer - check tmux first, then zellij
        // Note: tmux and zellij are mutually exclusive
        if (profile.tmux?.enabled === true) {
            parts.push(this.buildTmuxCommand(sessionName, profile));
        } else if (profile.zellij?.enabled === true) {
            parts.push(this.buildZellijCommand(sessionName, profile));
        } else {
            // Keep shell open
            const shell = profile.shellType === 'zsh' ? 'zsh' : 'bash';
            parts.push(`exec ${shell}`);
        }

        return parts.join(' && ');
    }

    /**
     * Build tmux command based on mode
     */
    private buildTmuxCommand(sessionName: string, profile: Profile): string {
        if (!profile.tmux) {
            return 'exec bash';
        }

        // Default to 'attach-or-create' if mode not specified
        const mode = profile.tmux.mode || 'attach-or-create';

        switch (mode) {
            case 'attach-or-create':
                // This matches your t() function: attach if exists, create if not
                return `tmux new-session -A -s ${shellQuote(sessionName)}`;

            case 'always-new':
                return `tmux new-session -s ${shellQuote(sessionName)}`;

            case 'attach-only':
                return `tmux attach-session -t ${shellQuote(sessionName)} || echo ${shellQuote(`Session ${sessionName} not found`)}`;

            case 'custom':
                return profile.tmux.customCommand || 'tmux';

            default:
                return `tmux new-session -A -s ${shellQuote(sessionName)}`;
        }
    }

    /**
     * Build zellij command based on mode
     */
    private buildZellijCommand(sessionName: string, profile: Profile): string {
        if (!profile.zellij) {
            return 'exec bash';
        }

        // Default to 'attach-or-create' if mode not specified
        const mode = profile.zellij.mode || 'attach-or-create';

        switch (mode) {
            case 'attach-or-create':
                // Zellij doesn't have a single command like tmux -A,
                // so we use attach with fallback to new session
                return `zellij attach ${shellQuote(sessionName)} 2>/dev/null || zellij -s ${shellQuote(sessionName)}`;

            case 'always-new':
                return `zellij -s ${shellQuote(sessionName)}`;

            case 'attach-only':
                return `zellij attach ${shellQuote(sessionName)} || echo ${shellQuote(`Session ${sessionName} not found`)}`;

            default:
                return `zellij attach ${shellQuote(sessionName)} 2>/dev/null || zellij -s ${shellQuote(sessionName)}`;
        }
    }

    private getSessionName(profile: Profile, taskName: string): string {
        return profile.tmux?.sessionName || profile.zellij?.sessionName || taskName;
    }

    // =========================================================================
    // PATH UTILITIES
    // =========================================================================

    private isWindows(): boolean {
        if (vscode.env.remoteName) {
            return false;
        }
        return process.platform === 'win32';
    }

    private toWslPath(inputPath: string): string {
        if (inputPath.startsWith('/')) {
            return inputPath;
        }
        const driveMatch = inputPath.match(/^([A-Za-z]):\\?(.*)/);
        if (driveMatch) {
            const drive = driveMatch[1].toLowerCase();
            const subPath = driveMatch[2]?.replace(/\\/g, '/') || '';
            return `/mnt/${drive}/${subPath}`;
        }
        return inputPath.replace(/\\/g, '/');
    }

    private toWindowsPath(inputPath: string): string {
        if (/^[A-Za-z]:/.test(inputPath) || inputPath.startsWith('\\\\')) {
            return inputPath;
        }
        const mntMatch = inputPath.match(/^\/mnt\/([a-z])\/?(.*)/i);
        if (mntMatch) {
            const drive = mntMatch[1].toUpperCase();
            const subPath = mntMatch[2]?.replace(/\//g, '\\') || '';
            return `${drive}:\\${subPath}`;
        }
        return inputPath.replace(/\//g, '\\');
    }
}
