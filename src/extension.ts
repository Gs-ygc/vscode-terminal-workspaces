import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigManager, ConfigScope } from './configManager';
import { TerminalTasksProvider, TaskTreeItem, TaskConfigDialog, FolderQuickPick, TmuxSessionData, ZellijSessionData, TerminalTasksDragAndDropController } from './terminalWorkspacesProvider';
import { RemoteConfig, TerminalTaskItem, TaskFolder } from './types';
import { TmuxManager, TmuxSession } from './tmuxManager';
import { ZellijManager, ZellijSession } from './zellijManager';
import { LOCAL_REMOTE_ID, normalizeRemoteId } from './remoteUtils';

let treeDataProvider: TerminalTasksProvider;
let configManager: ConfigManager;

function shouldUseLocalMultiplexerCommand(): boolean {
    return vscode.env.remoteName !== undefined || process.platform !== 'win32';
}

/**
 * Check if a path exists (works with both Windows and WSL paths)
 */
async function pathExists(taskPath: string): Promise<boolean> {
    try {
        // Handle WSL paths when running on Windows
        if (process.platform === 'win32' && taskPath.startsWith('/mnt/')) {
            // Convert /mnt/c/... to C:\...
            const match = taskPath.match(/^\/mnt\/([a-z])\/(.*)/i);
            if (match) {
                const windowsPath = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
                await fs.promises.access(windowsPath);
                return true;
            }
        }
        await fs.promises.access(taskPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate task path and prompt user if invalid (when experimental setting is enabled)
 * Returns the task to run (possibly with updated path), or undefined to cancel
 */
async function validateTaskPath(task: TerminalTaskItem): Promise<TerminalTaskItem | undefined> {
    const config = vscode.workspace.getConfiguration('terminalWorkspaces');
    const experimentalValidation = config.get<boolean>('experimentalPathValidation', false);

    if (!experimentalValidation) {
        return task; // Skip validation
    }

    const exists = await pathExists(task.path);
    if (exists) {
        return task;
    }

    // Path doesn't exist - prompt user
    const action = await vscode.window.showWarningMessage(
        `Path not found: ${task.path}`,
        { modal: false },
        'Browse for New Path',
        'Run Anyway',
        'Cancel'
    );

    if (action === 'Cancel' || !action) {
        return undefined;
    }

    if (action === 'Run Anyway') {
        return task;
    }

    if (action === 'Browse for New Path') {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select New Folder for Task'
        });

        if (!folderUri || !folderUri[0]) {
            return undefined;
        }

        const newPath = folderUri[0].fsPath;

        // Ask if they want to save this change
        const save = await vscode.window.showQuickPick(
            [
                { label: 'Yes, update the task', description: 'Save this path for future use', save: true },
                { label: 'No, just run once', description: 'Use this path only for this run', save: false }
            ],
            { placeHolder: 'Save this new path to the task?' }
        );

        if (!save) {
            return undefined;
        }

        if (save.save) {
            // Update the task in config
            try {
                await configManager.updateTask(task.id, { path: newPath });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Updated "${task.name}" path to: ${newPath}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to update task: ${error}`);
            }
        }

        // Return task with updated path for this run
        return { ...task, path: newPath };
    }

    return undefined;
}

interface SshConfigHost {
    alias: string;
    hostName?: string;
    user?: string;
    source: string;
}

function parseSshConfig(content: string, source: string): SshConfigHost[] {
    const hosts: SshConfigHost[] = [];
    let current: SshConfigHost[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const [keywordRaw, ...valueParts] = line.split(/\s+/);
        const keyword = keywordRaw.toLowerCase();
        const value = valueParts.join(' ').trim();

        if (keyword === 'host') {
            current = value
                .split(/\s+/)
                .filter(alias => alias && !alias.includes('*') && !alias.includes('?') && !alias.startsWith('!'))
                .map(alias => ({ alias, source }));
            hosts.push(...current);
            continue;
        }

        if (keyword === 'hostname') {
            for (const host of current) {
                host.hostName = value;
            }
        } else if (keyword === 'user') {
            for (const host of current) {
                host.user = value;
            }
        }
    }

    return hosts;
}

function getSshConfigHosts(): SshConfigHost[] {
    const configPaths = [
        path.join(os.homedir(), '.ssh', 'config')
    ];
    const seen = new Set<string>();
    const hosts: SshConfigHost[] = [];

    for (const configPath of configPaths) {
        try {
            if (!fs.existsSync(configPath)) {
                continue;
            }

            for (const host of parseSshConfig(fs.readFileSync(configPath, 'utf8'), configPath)) {
                const key = host.alias.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    hosts.push(host);
                }
            }
        } catch (error) {
            console.error(`Failed to read SSH config ${configPath}:`, error);
        }
    }

    return hosts;
}

function findDuplicateRemote(remotes: RemoteConfig[], host: string, label: string): RemoteConfig | undefined {
    const normalizedHost = host.trim().toLowerCase();
    const normalizedLabel = label.trim().toLowerCase();
    return remotes.find(remote =>
        remote.type === 'ssh' && (
            remote.host?.toLowerCase() === normalizedHost ||
            remote.id.toLowerCase() === normalizedHost ||
            remote.label.toLowerCase() === normalizedLabel
        )
    );
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Terminal Workspaces is now active');

    configManager = new ConfigManager(context);
    treeDataProvider = new TerminalTasksProvider(configManager);

    // Initialize config
    configManager.loadConfig();

    // Re-load config when workspace folders open/close (global ↔ workspace switch)
    const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await configManager.loadConfig();
        treeDataProvider.refresh();
        // Update context key so the title bar can show current scope
        vscode.commands.executeCommand(
            'setContext',
            'terminalWorkspaces.configScope',
            configManager.getConfigScope()
        );
    });
    context.subscriptions.push(workspaceFolderListener);

    // Set initial scope context key
    configManager.getConfig().then(() => {
        vscode.commands.executeCommand(
            'setContext',
            'terminalWorkspaces.configScope',
            configManager.getConfigScope()
        );
    });

    // Create and register the tree view
    const dragAndDropController = new TerminalTasksDragAndDropController(configManager, treeDataProvider);

    const treeView = vscode.window.createTreeView('terminalWorkspacesView', {
        treeDataProvider: treeDataProvider,
        showCollapseAll: true,
        canSelectMany: false,
        dragAndDropController: dragAndDropController
    });

    let allowSelectionOpen = false;
    const selectionOpenReadyTimer = setTimeout(() => {
        allowSelectionOpen = true;
    }, 750);
    context.subscriptions.push({ dispose: () => clearTimeout(selectionOpenReadyTimer) });

    const selectionOpenListener = treeView.onDidChangeSelection(async event => {
        if (!allowSelectionOpen) {
            return;
        }

        const item = event.selection[0];
        if (!item?.itemData) {
            return;
        }

        if (item.itemData.type === 'task') {
            await vscode.commands.executeCommand('terminalWorkspaces.runTaskById', item.itemData.id);
        } else if (item.itemData.type === 'tmuxSession') {
            await vscode.commands.executeCommand('terminalWorkspaces.attachTmuxSession', item);
        } else if (item.itemData.type === 'zellijSession') {
            await vscode.commands.executeCommand('terminalWorkspaces.attachZellijSession', item);
        }
    });

    let terminalRefreshTimer: NodeJS.Timeout | undefined;
    const scheduleTerminalRefresh = () => {
        if (terminalRefreshTimer) {
            clearTimeout(terminalRefreshTimer);
        }
        terminalRefreshTimer = setTimeout(() => {
            terminalRefreshTimer = undefined;
            treeDataProvider.refresh();
        }, 250);
    };

    // Listen for terminal open/close events to update active status indicators
    const terminalOpenListener = vscode.window.onDidOpenTerminal(() => {
        scheduleTerminalRefresh();
    });
    const terminalCloseListener = vscode.window.onDidCloseTerminal(() => {
        scheduleTerminalRefresh();
    });
    context.subscriptions.push(selectionOpenListener, terminalOpenListener, terminalCloseListener);

    // =========================================================================
    // REFRESH
    // =========================================================================

    const refreshCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.refresh',
        async () => {
            await configManager.loadConfig();
            treeDataProvider.refresh();
        }
    );

    const pickFolderForTask = async (): Promise<{ folderPath: string; folderName: string } | undefined> => {
        const options: (vscode.QuickPickItem & { action: string; path?: string })[] = [];
        const activeEditor = vscode.window.activeTextEditor;
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (activeEditor && !activeEditor.document.isUntitled) {
            const filePath = activeEditor.document.uri.fsPath;
            const folderPath = path.dirname(filePath);
            options.push({
                label: `$(file) Current File's Folder`,
                description: path.basename(folderPath),
                detail: folderPath,
                action: 'file',
                path: folderPath
            });
        }

        if (workspaceFolders) {
            for (const wsFolder of workspaceFolders) {
                options.push({
                    label: `$(root-folder) Workspace: ${wsFolder.name}`,
                    detail: wsFolder.uri.fsPath,
                    action: 'workspace',
                    path: wsFolder.uri.fsPath
                });
            }
        }

        options.push({
            label: '$(folder-opened) Browse for Folder...',
            description: 'Choose any folder',
            action: 'browse'
        });

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select folder to add as terminal task',
            matchOnDetail: true
        });

        if (!selected) {
            return undefined;
        }

        if (selected.action === 'browse') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder for Terminal Task'
            });

            if (!folderUri?.[0]) {
                return undefined;
            }

            return {
                folderPath: folderUri[0].fsPath,
                folderName: path.basename(folderUri[0].fsPath)
            };
        }

        return {
            folderPath: selected.path!,
            folderName: path.basename(selected.path!)
        };
    };

    const addTaskFromPath = async (folderPath: string, folderName: string, remoteId?: string) => {
        const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName, remoteId);
        if (!result) {
            return;
        }

        try {
            await configManager.addTask({
                name: result.name,
                path: result.path,
                remoteId: result.remoteId,
                profileId: result.profileId,
                tags: result.tags,
                overrides: result.overrides as any
            });
            treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add task: ${error}`);
        }
    };

    // =========================================================================
    // ADD REMOTE
    // =========================================================================

    const addRemoteCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addRemote',
        async () => {
            const config = await configManager.getConfig();
            const sshConfigHosts = getSshConfigHosts();
            const items: (vscode.QuickPickItem & {
                action: 'manual' | 'sshConfig';
                sshHost?: SshConfigHost;
                existing?: RemoteConfig;
            })[] = [
                {
                    label: '$(edit) Enter SSH Host...',
                    description: 'Manual',
                    action: 'manual'
                }
            ];

            if (sshConfigHosts.length > 0) {
                items.push({
                    label: '',
                    kind: vscode.QuickPickItemKind.Separator,
                    action: 'manual'
                });

                for (const sshHost of sshConfigHosts) {
                    const existing = findDuplicateRemote(config.remotes, sshHost.alias, sshHost.alias);
                    items.push({
                        label: `$(server-environment) ${sshHost.alias}`,
                        description: existing ? 'Already added' : sshHost.hostName || 'SSH config',
                        detail: sshHost.user ? `User ${sshHost.user}` : sshHost.source,
                        action: 'sshConfig',
                        sshHost,
                        existing
                    });
                }
            }

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Add SSH remote',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selected) {
                return;
            }

            let host: string;
            let label: string;
            let sshArgs: string[] | undefined;

            if (selected.existing) {
                const action = await vscode.window.showInformationMessage(
                    `Remote "${selected.existing.label}" already exists.`,
                    'Open Config'
                );
                if (action === 'Open Config') {
                    await vscode.commands.executeCommand('terminalWorkspaces.openConfig');
                }
                return;
            }

            if (selected.action === 'sshConfig' && selected.sshHost) {
                host = selected.sshHost.alias;
                label = selected.sshHost.alias;
            } else {
                const hostInput = await vscode.window.showInputBox({
                    prompt: 'SSH host or alias',
                    placeHolder: 'k1, llama-test, user@example.com',
                    validateInput: value => value.trim() ? null : 'Host cannot be empty'
                });

                if (!hostInput) {
                    return;
                }
                host = hostInput.trim();

                const labelInput = await vscode.window.showInputBox({
                    prompt: 'Display name',
                    value: host,
                    validateInput: value => value.trim() ? null : 'Display name cannot be empty'
                });

                if (!labelInput) {
                    return;
                }
                label = labelInput.trim();

                const sshArgsInput = await vscode.window.showInputBox({
                    prompt: 'Extra SSH arguments (optional)',
                    placeHolder: '-p 2222 -J jump-host'
                });

                if (sshArgsInput === undefined) {
                    return;
                }
                sshArgs = sshArgsInput.trim()
                    ? sshArgsInput.trim().split(/\s+/)
                    : undefined;
            }

            const duplicate = findDuplicateRemote(config.remotes, host, label);
            if (duplicate) {
                const action = await vscode.window.showInformationMessage(
                    `Remote "${duplicate.label}" already exists.`,
                    'Open Config'
                );
                if (action === 'Open Config') {
                    await vscode.commands.executeCommand('terminalWorkspaces.openConfig');
                }
                return;
            }

            try {
                const remote = await configManager.addRemote({
                    label,
                    type: 'ssh',
                    host,
                    sshArgs
                });

                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added remote "${remote.label}"`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add remote: ${error}`);
            }
        }
    );

    const deleteRemoteCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.deleteRemote',
        async (item?: TaskTreeItem) => {
            const remote = item?.itemData?.type === 'remoteHeader'
                ? item.itemData.remote
                : undefined;

            if (!remote) {
                return;
            }

            // Show QuickPick immediately — do NOT pre-fetch sessions (SSH round-trip = high latency)
            type DeleteAction = 'deleteOnly' | 'deleteWithSessions';
            const actions: (vscode.QuickPickItem & { action: DeleteAction })[] = [
                {
                    label: '$(trash) Delete remote config only',
                    description: 'Existing sessions keep running, tasks move to local',
                    action: 'deleteOnly'
                },
                {
                    label: '$(debug-stop) Delete remote config and kill all sessions',
                    description: 'Kill all tmux/zellij sessions on this remote before removing',
                    action: 'deleteWithSessions'
                }
            ];

            const pick = await vscode.window.showQuickPick(actions, {
                placeHolder: `Delete remote "${remote.label}" — choose action`,
                ignoreFocusOut: true
            });

            if (!pick) {
                return;
            }

            try {
                if (pick.action === 'deleteWithSessions' && remote.type === 'ssh') {
                    // Fetch session counts now (user already confirmed intent via QuickPick)
                    let tmuxCount = 0;
                    let zellijCount = 0;
                    try { tmuxCount = TmuxManager.getSessions(remote).length; } catch { /* ignore */ }
                    try { zellijCount = ZellijManager.getSessions(remote).length; } catch { /* ignore */ }
                    const sessionTotal = tmuxCount + zellijCount;

                    if (sessionTotal > 0) {
                        const confirm = await vscode.window.showWarningMessage(
                            `Kill all ${sessionTotal} session(s) on remote "${remote.label}"? This cannot be undone.`,
                            { modal: true },
                            'Kill & Delete'
                        );
                        if (confirm !== 'Kill & Delete') {
                            return;
                        }
                    }

                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `Killing sessions on ${remote.label}...`, cancellable: false },
                        async () => {
                            TmuxManager.deleteAllSessionsSync(remote);
                            ZellijManager.deleteAllSessionsSync(remote);
                        }
                    );
                }
                await configManager.deleteRemote(remote.id);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Deleted remote "${remote.label}"`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete remote: ${error}`);
            }
        }
    );

    const addTaskToRemoteCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addTaskToRemote',
        async (item?: TaskTreeItem) => {
            const remote = item?.itemData?.type === 'remoteHeader'
                ? item.itemData.remote
                : await vscode.window.showQuickPick(
                    configManager.getRemotes().map(r => ({
                        label: r.label,
                        description: r.type === 'ssh' ? r.host : 'local',
                        remote: r
                    })),
                    { placeHolder: 'Select remote host' }
                ).then(selected => selected?.remote);

            if (!remote) {
                return;
            }

            const folder = await pickFolderForTask();
            if (!folder) {
                return;
            }

            await addTaskFromPath(folder.folderPath, folder.folderName, remote.id);
        }
    );

    // =========================================================================
    // ADD TASK - From Explorer Context Menu
    // =========================================================================

    const addFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addFolderToTasks',
        async (uri: vscode.Uri) => {
            if (!uri) {
                vscode.window.showErrorMessage('No folder selected');
                return;
            }

            const folderPath = uri.fsPath;
            const folderName = path.basename(folderPath);

            const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName);
            if (!result) {
                return;
            }

            try {
                await configManager.addTask({
                    name: result.name,
                    path: result.path,
                    remoteId: result.remoteId,
                    profileId: result.profileId,
                    tags: result.tags,
                    overrides: result.overrides as any
                });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add task: ${error}`);
            }
        }
    );

    // =========================================================================
    // ADD TASK - Smart Add with Options
    // =========================================================================

    const addCurrentFileFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addCurrentFileFolder',
        async () => {
            // Build options based on what's available
            const options: (vscode.QuickPickItem & { action: string; path?: string })[] = [];

            const activeEditor = vscode.window.activeTextEditor;
            const workspaceFolders = vscode.workspace.workspaceFolders;

            // Option 1: Current file's parent folder
            if (activeEditor && !activeEditor.document.isUntitled) {
                const filePath = activeEditor.document.uri.fsPath;
                const folderPath = path.dirname(filePath);
                const folderName = path.basename(folderPath);
                options.push({
                    label: `$(file) Current File's Folder`,
                    description: folderName,
                    detail: folderPath,
                    action: 'file',
                    path: folderPath
                });
            }

            // Option 2: Workspace folder(s)
            if (workspaceFolders) {
                for (const wsFolder of workspaceFolders) {
                    options.push({
                        label: `$(root-folder) Workspace: ${wsFolder.name}`,
                        description: '',
                        detail: wsFolder.uri.fsPath,
                        action: 'workspace',
                        path: wsFolder.uri.fsPath
                    });
                }
            }

            // Option 3: Browse
            options.push({
                label: '$(folder-opened) Browse for Folder...',
                description: 'Choose any folder',
                action: 'browse'
            });

            // If only browse is available, go straight to browse
            if (options.length === 1) {
                await vscode.commands.executeCommand('terminalWorkspaces.addBrowseFolder');
                return;
            }

            const selected = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select folder to add as terminal task',
                matchOnDetail: true
            });

            if (!selected) {
                return;
            }

            let folderPath: string;
            let folderName: string;

            if (selected.action === 'browse') {
                await vscode.commands.executeCommand('terminalWorkspaces.addBrowseFolder');
                return;
            } else {
                folderPath = selected.path!;
                folderName = path.basename(folderPath);
            }

            const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName);
            if (!result) {
                return;
            }

            try {
                await configManager.addTask({
                    name: result.name,
                    path: result.path,
                    remoteId: result.remoteId,
                    profileId: result.profileId,
                    tags: result.tags,
                    overrides: result.overrides as any
                });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add task: ${error}`);
            }
        }
    );

    // =========================================================================
    // ADD TASK - File's Parent Folder (from explorer context menu on files)
    // =========================================================================

    const addFileParentFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addFileParentFolder',
        async (uri: vscode.Uri) => {
            if (!uri) {
                // Fallback to active editor
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor || activeEditor.document.isUntitled) {
                    vscode.window.showErrorMessage('No file selected');
                    return;
                }
                uri = activeEditor.document.uri;
            }

            const folderPath = path.dirname(uri.fsPath);
            const folderName = path.basename(folderPath);

            const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName);
            if (!result) {
                return;
            }

            try {
                await configManager.addTask({
                    name: result.name,
                    path: result.path,
                    remoteId: result.remoteId,
                    profileId: result.profileId,
                    tags: result.tags,
                    overrides: result.overrides as any
                });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add task: ${error}`);
            }
        }
    );

    // =========================================================================
    // ADD TASK - From Terminal (context menu)
    // =========================================================================

    const addFromTerminalCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addFromTerminal',
        async () => {
            // VS Code doesn't expose terminal CWD directly, so we'll prompt user
            // to choose from available options or browse
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const options: (vscode.QuickPickItem & { action: string; path?: string })[] = [];

            // Add workspace folders as options
            if (workspaceFolders) {
                for (const wsFolder of workspaceFolders) {
                    options.push({
                        label: `$(root-folder) ${wsFolder.name}`,
                        description: 'Workspace folder',
                        detail: wsFolder.uri.fsPath,
                        action: 'workspace',
                        path: wsFolder.uri.fsPath
                    });
                }
            }

            // Add browse option
            options.push({
                label: '$(folder-opened) Browse for Folder...',
                description: 'Choose the folder for this terminal task',
                action: 'browse'
            });

            const selected = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select or browse for the folder to add as a terminal task',
                matchOnDetail: true
            });

            if (!selected) {
                return;
            }

            if (selected.action === 'browse') {
                await vscode.commands.executeCommand('terminalWorkspaces.addBrowseFolder');
                return;
            }

            const folderPath = selected.path!;
            const folderName = path.basename(folderPath);

            const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName);
            if (!result) {
                return;
            }

            try {
                await configManager.addTask({
                    name: result.name,
                    path: result.path,
                    remoteId: result.remoteId,
                    profileId: result.profileId,
                    tags: result.tags,
                    overrides: result.overrides as any
                });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add task: ${error}`);
            }
        }
    );

    // =========================================================================
    // ADD TASK - Browse for Folder
    // =========================================================================

    const addBrowseFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addBrowseFolder',
        async () => {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder for Terminal Task'
            });

            if (!folderUri || !folderUri[0]) {
                return;
            }

            const folderPath = folderUri[0].fsPath;
            const folderName = path.basename(folderPath);

            const result = await TaskConfigDialog.showCreate(configManager, folderPath, folderName);
            if (!result) {
                return;
            }

            try {
                await configManager.addTask({
                    name: result.name,
                    path: result.path,
                    remoteId: result.remoteId,
                    profileId: result.profileId,
                    tags: result.tags,
                    overrides: result.overrides as any
                });
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Added "${result.name}" to terminal tasks`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add task: ${error}`);
            }
        }
    );

    // =========================================================================
    // ADD FOLDER (for organizing tasks)
    // =========================================================================

    const addTaskFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.addTaskFolder',
        async (item?: TaskTreeItem) => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter folder name',
                validateInput: value => value.trim() ? null : 'Name cannot be empty'
            });

            if (!name) {
                return;
            }

            try {
                const parentId = item?.itemData?.type === 'folder' ? item.itemData.id : undefined;
                await configManager.addFolder(name, parentId);
                treeDataProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create folder: ${error}`);
            }
        }
    );

    // =========================================================================
    // RUN TASK
    // =========================================================================

    // Helper to find existing terminal by name
    const findTerminalByName = (name: string): vscode.Terminal | undefined => {
        return vscode.window.terminals.find(t => t.name === name);
    };

    const managedTerminals = new WeakSet<vscode.Terminal>();

    const createManagedTerminal = (options: vscode.TerminalOptions): vscode.Terminal => {
        const terminal = vscode.window.createTerminal(options);
        managedTerminals.add(terminal);
        return terminal;
    };

    const findManagedTerminalByName = (name: string): vscode.Terminal | undefined => {
        return vscode.window.terminals.find(t => t.name === name && managedTerminals.has(t));
    };

    const disposeRestoredTerminalByName = (name: string): void => {
        const restoredTerminal = vscode.window.terminals.find(t => t.name === name && !managedTerminals.has(t));
        if (restoredTerminal) {
            restoredTerminal.dispose();
        }
    };

    const getTaskRemoteId = (task: TerminalTaskItem): string => normalizeRemoteId(task.remoteId);

    const getSessionTerminalName = (kind: 'tmux' | 'zellij', sessionName: string, remoteId?: string): string => {
        const normalizedRemoteId = normalizeRemoteId(remoteId);
        return normalizedRemoteId === LOCAL_REMOTE_ID
            ? `${kind}: ${sessionName}`
            : `${kind}@${normalizedRemoteId}: ${sessionName}`;
    };

    const getLegacySanitizedSessionName = (sessionName: string): string =>
        sessionName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);

    const getTaskTerminalName = (task: TerminalTaskItem): string => {
        const remoteId = getTaskRemoteId(task);
        const profile = configManager.getProfile(task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');
        if (profile?.tmux?.enabled || task.overrides?.tmux?.enabled) {
            const sessionName = task.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || task.name;
            return getSessionTerminalName('tmux', sessionName, remoteId);
        }
        if (profile?.zellij?.enabled || task.overrides?.zellij?.enabled) {
            const sessionName = task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || task.name;
            return getSessionTerminalName('zellij', sessionName, remoteId);
        }
        return remoteId === LOCAL_REMOTE_ID ? task.name : `${remoteId}: ${task.name}`;
    };

    const getLegacyTaskTerminalName = (task: TerminalTaskItem): string | undefined => {
        const remoteId = getTaskRemoteId(task);
        const profile = configManager.getProfile(task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');
        if (profile?.tmux?.enabled || task.overrides?.tmux?.enabled) {
            const sessionName = task.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || task.name;
            const legacySessionName = getLegacySanitizedSessionName(sessionName);
            return legacySessionName === sessionName ? undefined : getSessionTerminalName('tmux', legacySessionName, remoteId);
        }
        if (profile?.zellij?.enabled || task.overrides?.zellij?.enabled) {
            const sessionName = task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || task.name;
            const legacySessionName = getLegacySanitizedSessionName(sessionName);
            return legacySessionName === sessionName ? undefined : getSessionTerminalName('zellij', legacySessionName, remoteId);
        }
        return undefined;
    };

    // Helper to run a task, respecting terminal location setting
    const runTaskDirectly = async (task: TerminalTaskItem) => {
        const terminalName = getTaskTerminalName(task);
        const legacyTerminalName = getLegacyTaskTerminalName(task);
        const taskProfile = configManager.getProfile(task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');
        const taskUsesTmux = taskProfile?.tmux?.enabled || task.overrides?.tmux?.enabled;
        const taskUsesZellij = !taskUsesTmux && (taskProfile?.zellij?.enabled || task.overrides?.zellij?.enabled);
        const taskUsesMultiplexer = taskUsesTmux || taskUsesZellij;
        const candidateNames = [
            terminalName,
            legacyTerminalName,
            getTaskRemoteId(task) === LOCAL_REMOTE_ID ? task.name : undefined
        ].filter((name): name is string => Boolean(name));
        const existingTerminal = taskUsesMultiplexer
            ? candidateNames.map(findManagedTerminalByName).find((terminal): terminal is vscode.Terminal => Boolean(terminal))
            : candidateNames.map(findTerminalByName).find((terminal): terminal is vscode.Terminal => Boolean(terminal));

        if (existingTerminal) {
            try {
                existingTerminal.show();
                return;
            } catch {
                // Terminal was disposed, fall through to create a new one.
            }
        }

        if (taskUsesMultiplexer) {
            for (const candidateName of candidateNames) {
                disposeRestoredTerminalByName(candidateName);
            }
        }

        // Auto-delete EXITED zellij sessions before launching to avoid resurrection issues
        if (taskUsesZellij) {
            const sessionName = task.overrides?.zellij?.sessionName || taskProfile?.zellij?.sessionName || task.name;
            const remote = configManager.getTaskRemote(task);
            if (ZellijManager.isSessionExited(sessionName, remote)) {
                ZellijManager.deleteSessionSync(sessionName, remote);
            }
        }

        const terminalLocation = vscode.workspace.getConfiguration('terminalWorkspaces').get<string>('terminalLocation', 'panel');
        const generated = configManager.generateTaskCommand(task);
        const terminal = createManagedTerminal({
            name: terminalName,
            location: terminalLocation === 'editor'
                ? vscode.TerminalLocation.Editor
                : vscode.TerminalLocation.Panel
        });

        terminal.show();
        terminal.sendText(generated.command);
    };

    const runTaskByIdCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.runTaskById',
        async (taskId: string) => {
            const found = configManager.findItemById(taskId);
            if (!found || found.item.type !== 'task') {
                vscode.window.showErrorMessage('Task not found');
                return;
            }

            const task = found.item as TerminalTaskItem;

            // Validate path if experimental setting is enabled
            const validatedTask = await validateTaskPath(task);
            if (!validatedTask) {
                return; // User cancelled
            }

            // If path was updated, regenerate tasks.json before running
            if (validatedTask.path !== task.path) {
                await configManager.generateTasksJson();
            }

            await runTaskDirectly(validatedTask);
        }
    );

    const runTaskCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.runTask',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            if (item.itemData.type === 'folder') {
                // Run all tasks in this folder
                const folder = item.itemData as TaskFolder;
                const allTasks = getAllTasks(folder.children);
                for (const task of allTasks) {
                    const validatedTask = await validateTaskPath(task);
                    if (validatedTask) {
                        if (validatedTask.path !== task.path) {
                            await configManager.generateTasksJson();
                        }
                        await runTaskDirectly(validatedTask);
                    }
                }
            } else if (item.itemData.type === 'task') {
                const task = item.itemData as TerminalTaskItem;

                // Validate path if experimental setting is enabled
                const validatedTask = await validateTaskPath(task);
                if (!validatedTask) {
                    return; // User cancelled
                }

                // If path was updated, regenerate tasks.json before running
                if (validatedTask.path !== task.path) {
                    await configManager.generateTasksJson();
                }

                await runTaskDirectly(validatedTask);
            }
        }
    );

    const runAllTasksCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.runAllTasks',
        async () => {
            const config = await configManager.getConfig();

            const allTasks = getAllTasks(config.items);
            for (const task of allTasks) {
                const validatedTask = await validateTaskPath(task);
                if (validatedTask) {
                    if (validatedTask.path !== task.path) {
                        await configManager.generateTasksJson();
                    }
                    await runTaskDirectly(validatedTask);
                }
            }
        }
    );

    const runFolderTasksCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.runFolderTasks',
        async (item: TaskTreeItem) => {
            if (!item?.itemData || item.itemData.type !== 'folder') {
                return;
            }

            const folder = item.itemData as TaskFolder;
            const allTasks = getAllTasks(folder.children);

            if (allTasks.length === 0) {
                vscode.window.showInformationMessage('No tasks in this folder');
                return;
            }

            for (const task of allTasks) {
                const validatedTask = await validateTaskPath(task);
                if (validatedTask) {
                    if (validatedTask.path !== task.path) {
                        await configManager.generateTasksJson();
                    }
                    await runTaskDirectly(validatedTask);
                }
            }
        }
    );

    // =========================================================================
    // EDIT TASK
    // =========================================================================

    const editTaskCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.editTask',
        async (item: TaskTreeItem) => {
            if (!item?.itemData || item.itemData.type !== 'task') {
                return;
            }

            const task = item.itemData as TerminalTaskItem;
            const updates = await TaskConfigDialog.showEdit(configManager, task);

            if (!updates) {
                return;
            }

            try {
                await configManager.updateTask(task.id, updates);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage('Task updated');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to update task: ${error}`);
            }
        }
    );

    // =========================================================================
    // RENAME (for both tasks and folders)
    // =========================================================================

    const renameCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.rename',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            // Only allow renaming tasks and folders
            if (item.itemData.type !== 'task' && item.itemData.type !== 'folder') {
                return;
            }

            const newName = await vscode.window.showInputBox({
                prompt: 'Enter new name',
                value: item.itemData.name,
                validateInput: value => value.trim() ? null : 'Name cannot be empty'
            });

            if (!newName || newName === item.itemData.name) {
                return;
            }

            try {
                if (item.itemData.type === 'task') {
                    await configManager.updateTask(item.itemData.id, { name: newName });
                } else {
                    await configManager.updateFolder(item.itemData.id, { name: newName });
                }
                treeDataProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to rename: ${error}`);
            }
        }
    );

    // =========================================================================
    // DELETE
    // =========================================================================

    const deleteCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.delete',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            // Only allow deleting tasks and folders
            if (item.itemData.type !== 'task' && item.itemData.type !== 'folder') {
                return;
            }

            const itemType = item.itemData.type === 'folder' ? 'folder' : 'task';
            let message = `Delete "${item.itemData.name}"?`;

            if (item.itemData.type === 'folder') {
                const folder = item.itemData as TaskFolder;
                if (folder.children.length > 0) {
                    message = `Delete folder "${folder.name}" and all ${folder.children.length} item(s) inside?`;
                }
            }

            const confirm = await vscode.window.showWarningMessage(
                message,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') {
                return;
            }

            try {
                await configManager.deleteItem(item.itemData.id);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Deleted "${item.itemData.name}"`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete: ${error}`);
            }
        }
    );

    // =========================================================================
    // MOVE TO FOLDER
    // =========================================================================

    const moveToFolderCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.moveToFolder',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            // Only allow moving tasks and folders
            if (item.itemData.type !== 'task' && item.itemData.type !== 'folder') {
                return;
            }

            const destination = await FolderQuickPick.show(configManager, item.itemData.id);

            if (destination === undefined) {
                return; // Cancelled
            }

            try {
                await configManager.moveItem(item.itemData.id, destination?.id || null);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(
                    `Moved "${item.itemData.name}" to ${destination?.path || 'root'}`
                );
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to move: ${error}`);
            }
        }
    );

    // =========================================================================
    // OPEN CONFIG FILE
    // =========================================================================

    const openConfigCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.openConfig',
        async () => {
            const uri = configManager.getConfigFileUri();
            if (!uri) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            // Ensure config exists
            await configManager.getConfig();
            await configManager.saveConfig();

            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        }
    );

    // =========================================================================
    // OPEN TASKS.JSON
    // =========================================================================

    const openTasksJsonCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.openTasksJson',
        async () => {
            const uri = configManager.getTasksJsonUri();
            if (!uri) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch {
                vscode.window.showErrorMessage('tasks.json not found. Add a task first.');
            }
        }
    );

    // =========================================================================
    // REGENERATE TASKS.JSON
    // =========================================================================

    const regenerateTasksJsonCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.regenerateTasksJson',
        async () => {
            try {
                await configManager.generateTasksJson();
                vscode.window.showInformationMessage('tasks.json regenerated');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to regenerate: ${error}`);
            }
        }
    );

    // =========================================================================
    // QUICK OPEN (Command Palette manager)
    // =========================================================================

    const openManagerCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.openTasksManager',
        async () => {
            const config = await configManager.getConfig();
            const flatTasks = configManager.flattenTasks();

            if (flatTasks.length === 0) {
                const action = await vscode.window.showInformationMessage(
                    'No terminal tasks configured.',
                    'Add Task',
                    'Browse for Folder'
                );

                if (action === 'Add Task') {
                    vscode.commands.executeCommand('terminalWorkspaces.addCurrentFileFolder');
                } else if (action === 'Browse for Folder') {
                    vscode.commands.executeCommand('terminalWorkspaces.addBrowseFolder');
                }
                return;
            }

            const items: vscode.QuickPickItem[] = [
                { label: '$(add) Add new task...', description: '' },
                { label: '$(folder-opened) Browse for folder...', description: '' },
                { label: '$(new-folder) Create task folder...', description: '' },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                ...flatTasks.map(ft => ({
                    label: `$(terminal) ${ft.task.name}`,
                    description: ft.namePath.slice(0, -1).join(' / ') || '',
                    detail: ft.task.path
                }))
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a task to run or add a new one',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selected) {
                return;
            }

            if (selected.label === '$(add) Add new task...') {
                vscode.commands.executeCommand('terminalWorkspaces.addCurrentFileFolder');
            } else if (selected.label === '$(folder-opened) Browse for folder...') {
                vscode.commands.executeCommand('terminalWorkspaces.addBrowseFolder');
            } else if (selected.label === '$(new-folder) Create task folder...') {
                vscode.commands.executeCommand('terminalWorkspaces.addTaskFolder');
            } else {
                // Run the selected task
                const taskName = selected.label.replace(/^\$\([^)]+\)\s*/, '');
                await vscode.commands.executeCommand('workbench.action.tasks.runTask', taskName);
            }
        }
    );

    // =========================================================================
    // TMUX SESSION DISCOVERY
    // =========================================================================

    const refreshTmuxSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.refreshTmuxSessions',
        async () => {
            if (!TmuxManager.isAvailable()) {
                vscode.window.showWarningMessage('tmux is not available in this environment');
                return;
            }
            treeDataProvider.refreshTmuxSessions();
            vscode.window.showInformationMessage('tmux sessions refreshed');
        }
    );

    const importTmuxSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.importTmuxSessions',
        async () => {
            if (!TmuxManager.isAvailable()) {
                vscode.window.showWarningMessage('tmux is not available in this environment');
                return;
            }

            const sessions = TmuxManager.getSessions();
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No tmux sessions found');
                return;
            }

            // Get existing task names to mark which are already tracked
            const flatTasks = configManager.flattenTasks();
            const trackedNames = new Set<string>();
            for (const ft of flatTasks) {
                const profile = configManager.getProfile(ft.task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');
                if (profile?.tmux?.enabled === true || ft.task.overrides?.tmux?.enabled === true) {
                    const sessionName = ft.task.overrides?.tmux?.sessionName || ft.task.name;
                    trackedNames.add(sessionName.toLowerCase());
                }
            }

            // Build quick pick items
            const items = sessions.map(session => ({
                label: session.name,
                description: TmuxManager.normalizePathForDisplay(session.path),
                detail: trackedNames.has(session.name.toLowerCase())
                    ? '$(check) Already tracked'
                    : `$(circle-outline) ${session.attached ? 'Attached' : 'Detached'} • ${session.windowCount} window(s)`,
                picked: !trackedNames.has(session.name.toLowerCase()),
                session
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select tmux sessions to import as tasks',
                canPickMany: true
            });

            if (!selected || selected.length === 0) {
                return;
            }

            // Filter out already tracked sessions
            const toImport = selected.filter(s => !trackedNames.has(s.session.name.toLowerCase()));

            if (toImport.length === 0) {
                vscode.window.showInformationMessage('All selected sessions are already tracked');
                return;
            }

            // Import selected sessions
            let imported = 0;
            for (const item of toImport) {
                try {
                    await configManager.addTask({
                        name: item.session.name,
                        path: item.session.path,
                        profileId: 'wsl-tmux', // Use WSL+tmux profile
                        overrides: {
                            tmux: {
                                enabled: true,
                                mode: 'attach-or-create',
                                sessionName: item.session.name
                            }
                        }
                    });
                    imported++;
                } catch (error) {
                    console.error(`Failed to import session ${item.session.name}:`, error);
                }
            }

            treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Imported ${imported} tmux session(s) as tasks`);
        }
    );

    const attachTmuxSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.attachTmuxSession',
        async (sessionOrItem: TmuxSession | TaskTreeItem) => {
            let session: TmuxSession | undefined;

            // Handle both direct session object and TaskTreeItem
            if (sessionOrItem && 'itemData' in sessionOrItem) {
                // It's a TaskTreeItem from the tree view
                const item = sessionOrItem as TaskTreeItem;
                if (item.itemData?.type === 'tmuxSession') {
                    session = (item.itemData as TmuxSessionData).session;
                }
            } else if (sessionOrItem && 'name' in sessionOrItem && 'path' in sessionOrItem) {
                // It's a direct TmuxSession object
                session = sessionOrItem as TmuxSession;
            }

            if (!session) {
                vscode.window.showErrorMessage('No tmux session selected');
                return;
            }

            // Check if terminal with this name already exists
            const remote = configManager.getRemote(session.remoteId);
            const terminalName = getSessionTerminalName('tmux', session.name, remote.id);
            const existingTerminal = findManagedTerminalByName(terminalName);
            if (existingTerminal) {
                // Reuse existing terminal - just show it
                existingTerminal.show();
                return;
            }
            disposeRestoredTerminalByName(terminalName);

            // Create terminal - don't set cwd since tmux will handle the working directory
            // The session's path might not exist on the Windows side or could be invalid
            const terminalLocation = vscode.workspace.getConfiguration('terminalWorkspaces').get<string>('terminalLocation', 'panel');
            const terminal = createManagedTerminal({
                name: terminalName,
                // Intentionally not setting cwd - tmux attach will restore the session's directory
                location: terminalLocation === 'editor'
                    ? vscode.TerminalLocation.Editor
                    : vscode.TerminalLocation.Panel
            });

            terminal.show();

            // Send the attach command - tmux will restore the session's working directory
            if (remote.type === 'ssh') {
                terminal.sendText(TmuxManager.getAttachCommand(session.name, remote));
            } else if (shouldUseLocalMultiplexerCommand()) {
                terminal.sendText(TmuxManager.getAttachCommand(session.name));
            } else {
                // On Windows, need to go through WSL with proper escaping
                terminal.sendText(TmuxManager.getAttachCommandForWSL(session.name));
            }
        }
    );

    const importTmuxSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.importTmuxSession',
        async (item: TaskTreeItem) => {
            if (!item?.itemData || item.itemData.type !== 'tmuxSession') {
                return;
            }

            const sessionData = item.itemData as TmuxSessionData;
            const session = sessionData.session;

            // Ask for task name
            const name = await vscode.window.showInputBox({
                prompt: 'Task name for this session',
                value: session.name,
                validateInput: value => value.trim() ? null : 'Name cannot be empty'
            });

            if (!name) {
                return;
            }

            try {
                await configManager.addTask({
                    name,
                    path: session.path,
                    remoteId: normalizeRemoteId(session.remoteId),
                    profileId: 'wsl-tmux',
                    overrides: {
                        tmux: {
                            enabled: true,
                            mode: 'attach-or-create',
                            sessionName: session.name
                        }
                    }
                });

                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Imported "${session.name}" as task "${name}"`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to import session: ${error}`);
            }
        }
    );

    const killTmuxSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.killTmuxSession',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            let sessionName: string;
            let remoteId = LOCAL_REMOTE_ID;

            if (item.itemData.type === 'tmuxSession') {
                // Untracked tmux session
                const sessionData = item.itemData as TmuxSessionData;
                sessionName = sessionData.session.name;
                remoteId = normalizeRemoteId(sessionData.session.remoteId);
            } else if (item.itemData.type === 'task') {
                // Task - check if it uses tmux mode
                const task = item.itemData as TerminalTaskItem;
                remoteId = getTaskRemoteId(task);

                // Get the profile to check if it's tmux
                const profile = task.profileId ? configManager.getProfile(task.profileId) : undefined;
                const isTmux = profile?.tmux?.enabled || task.overrides?.tmux?.enabled;

                if (!isTmux) {
                    vscode.window.showWarningMessage('This task does not use tmux mode');
                    return;
                }

                // Get the tmux session name (custom or task name)
                sessionName = task.overrides?.tmux?.sessionName || profile?.tmux?.sessionName || task.name;
            } else {
                return;
            }

            // Confirm before killing
            const confirm = await vscode.window.showWarningMessage(
                `Kill tmux session "${sessionName}"?`,
                { modal: true },
                'Kill Session'
            );

            if (confirm !== 'Kill Session') {
                return;
            }

            try {
                // Close any VS Code terminal attached to this session
                // Check both naming conventions: "tmux: sessionName" and raw task name
                const remote = configManager.getRemote(remoteId);
                const tmuxTerminalName = getSessionTerminalName('tmux', sessionName, remoteId);
                let existingTerminal = findTerminalByName(tmuxTerminalName);
                if (existingTerminal) {
                    existingTerminal.dispose();
                }

                // Also try to find terminal by the original task name (for tasks run via runTaskDirectly)
                if (item.itemData?.type === 'task') {
                    const task = item.itemData as TerminalTaskItem;
                    const taskTerminal = findTerminalByName(task.name);
                    if (taskTerminal) {
                        taskTerminal.dispose();
                    }
                }

                // Kill the tmux session using centralized command building
                const { exec } = require('child_process');

                let command: string;
                if (remote.type === 'ssh') {
                    command = TmuxManager.getKillCommand(sessionName, remote);
                } else if (shouldUseLocalMultiplexerCommand()) {
                    // In WSL or native Linux/macOS - run tmux directly
                    command = TmuxManager.getKillCommand(sessionName);
                } else {
                    // On Windows (not in WSL) - go through wsl.exe
                    command = TmuxManager.getKillCommandForWSL(sessionName);
                }

                exec(command, (error: Error | null) => {
                    // Handle "can't find session" as success - session is already gone
                    const isSessionNotFound = error?.message?.includes("can't find session") ||
                                              error?.message?.includes("no server running");

                    if (error && !isSessionNotFound) {
                        vscode.window.showErrorMessage(`Failed to kill session: ${error.message}`);
                    } else {
                        if (isSessionNotFound) {
                            vscode.window.showInformationMessage(`Session "${sessionName}" already ended, terminal closed`);
                        } else {
                            vscode.window.showInformationMessage(`Killed tmux session "${sessionName}"`);
                        }
                    }
                    // Always refresh to update indicators
                    setTimeout(() => {
                        treeDataProvider.refresh();
                    }, 200);
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to kill session: ${error}`);
            }
        }
    );

    const killTmuxSessionFromTerminalCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.killTmuxSessionFromTerminal',
        async (terminal?: vscode.Terminal) => {
            // Get the terminal - either passed from context menu or use active terminal
            const targetTerminal = terminal || vscode.window.activeTerminal;
            if (!targetTerminal) {
                vscode.window.showErrorMessage('No terminal selected');
                return;
            }

            // Check if it's a tmux terminal (name starts with "tmux: ")
            const terminalName = targetTerminal.name;
            if (!terminalName.startsWith('tmux: ')) {
                vscode.window.showWarningMessage('This terminal is not a tmux session. Use this command on terminals named "tmux: <session>"');
                return;
            }

            const sessionName = terminalName.replace('tmux: ', '');

            // Confirm before killing
            const confirm = await vscode.window.showWarningMessage(
                `Kill tmux session "${sessionName}"?`,
                { modal: true },
                'Kill Session'
            );

            if (confirm !== 'Kill Session') {
                return;
            }

            try {
                // Close the VS Code terminal
                targetTerminal.dispose();

                // Kill the tmux session using centralized command building
                const { exec } = require('child_process');

                let command: string;
                if (shouldUseLocalMultiplexerCommand()) {
                    // In WSL or native Linux/macOS - run tmux directly
                    command = TmuxManager.getKillCommand(sessionName);
                } else {
                    // On Windows (not in WSL) - go through wsl.exe
                    command = TmuxManager.getKillCommandForWSL(sessionName);
                }

                exec(command, (error: Error | null) => {
                    // Handle "can't find session" as success - session is already gone
                    const isSessionNotFound = error?.message?.includes("can't find session") ||
                                              error?.message?.includes("no server running");

                    if (error && !isSessionNotFound) {
                        vscode.window.showErrorMessage(`Failed to kill session: ${error.message}`);
                    } else {
                        if (isSessionNotFound) {
                            vscode.window.showInformationMessage(`Session "${sessionName}" already ended, terminal closed`);
                        } else {
                            vscode.window.showInformationMessage(`Killed tmux session "${sessionName}"`);
                        }
                    }
                    // Always refresh to update indicators
                    setTimeout(() => {
                        treeDataProvider.refresh();
                    }, 200);
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to kill session: ${error}`);
            }
        }
    );

    // =========================================================================
    // ZELLIJ SESSION MANAGEMENT
    // =========================================================================

    const killZellijSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.killZellijSession',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            let sessionName: string;
            let remoteId = LOCAL_REMOTE_ID;

            if (item.itemData.type === 'zellijSession') {
                // Untracked zellij session
                const sessionData = item.itemData as ZellijSessionData;
                sessionName = sessionData.session.name;
                remoteId = normalizeRemoteId(sessionData.session.remoteId);
            } else if (item.itemData.type === 'task') {
                // Task - check if it uses zellij mode
                const task = item.itemData as TerminalTaskItem;
                remoteId = getTaskRemoteId(task);

                // Get the profile to check if it's zellij
                const profile = task.profileId ? configManager.getProfile(task.profileId) : undefined;
                const isZellij = profile?.zellij?.enabled || task.overrides?.zellij?.enabled;

                if (!isZellij) {
                    vscode.window.showWarningMessage('This task does not use zellij mode');
                    return;
                }

                // Get the zellij session name (custom or task name)
                sessionName = task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || task.name;
            } else {
                return;
            }

            // Confirm before killing
            const confirm = await vscode.window.showWarningMessage(
                `Kill zellij session "${sessionName}"?`,
                { modal: true },
                'Kill Session'
            );

            if (confirm !== 'Kill Session') {
                return;
            }

            try {
                // Close any VS Code terminal attached to this session
                // Check both naming conventions: "zellij: sessionName" and raw task name
                const remote = configManager.getRemote(remoteId);
                const zellijTerminalName = getSessionTerminalName('zellij', sessionName, remoteId);
                let existingTerminal = findTerminalByName(zellijTerminalName);
                if (existingTerminal) {
                    existingTerminal.dispose();
                }

                // Also try to find terminal by the original task name (for tasks run via runTaskDirectly)
                if (item.itemData?.type === 'task') {
                    const task = item.itemData as TerminalTaskItem;
                    const taskTerminal = findTerminalByName(task.name);
                    if (taskTerminal) {
                        taskTerminal.dispose();
                    }
                }

                // Kill the zellij session using centralized command building
                const { exec } = require('child_process');

                let command: string;
                if (remote.type === 'ssh') {
                    command = ZellijManager.getKillCommand(sessionName, remote);
                } else if (shouldUseLocalMultiplexerCommand()) {
                    // In WSL or native Linux/macOS - run zellij directly
                    command = ZellijManager.getKillCommand(sessionName);
                } else {
                    // On Windows (not in WSL) - go through wsl.exe
                    command = ZellijManager.getKillCommandForWSL(sessionName);
                }

                exec(command, (error: Error | null) => {
                    // Handle "session not found" as success - session is already gone
                    // Zellij error messages: "session not found", "No zellij server listening"
                    const isSessionNotFound = error?.message?.includes('session not found') ||
                                              error?.message?.includes('No zellij server listening') ||
                                              error?.message?.includes("doesn't exist");

                    if (error && !isSessionNotFound) {
                        vscode.window.showErrorMessage(`Failed to kill session: ${error.message}`);
                    } else {
                        if (isSessionNotFound) {
                            vscode.window.showInformationMessage(`Session "${sessionName}" already ended, terminal closed`);
                        } else {
                            vscode.window.showInformationMessage(`Killed zellij session "${sessionName}"`);
                        }
                    }
                    // Always refresh to update indicators
                    setTimeout(() => {
                        treeDataProvider.refresh();
                    }, 200);
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to kill session: ${error}`);
            }
        }
    );

    const deleteZellijSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.deleteZellijSession',
        async (item: TaskTreeItem) => {
            if (!item?.itemData) {
                return;
            }

            let sessionName: string;
            let remoteId = LOCAL_REMOTE_ID;

            if (item.itemData.type === 'zellijSession') {
                // Untracked zellij session
                const sessionData = item.itemData as ZellijSessionData;
                sessionName = sessionData.session.name;
                remoteId = normalizeRemoteId(sessionData.session.remoteId);
            } else if (item.itemData.type === 'task') {
                // Task - check if it uses zellij mode
                const task = item.itemData as TerminalTaskItem;
                remoteId = getTaskRemoteId(task);

                // Get the profile to check if it's zellij
                const profile = task.profileId ? configManager.getProfile(task.profileId) : undefined;
                const isZellij = profile?.zellij?.enabled || task.overrides?.zellij?.enabled;

                if (!isZellij) {
                    vscode.window.showWarningMessage('This task does not use zellij mode');
                    return;
                }

                // Get the zellij session name (custom or task name)
                sessionName = task.overrides?.zellij?.sessionName || profile?.zellij?.sessionName || task.name;
            } else {
                return;
            }

            // Confirm before deleting (more serious than kill)
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete zellij session "${sessionName}"? This cannot be undone.`,
                { modal: true },
                'Delete Session'
            );

            if (confirm !== 'Delete Session') {
                return;
            }

            try {
                // Close any VS Code terminal attached to this session
                const remote = configManager.getRemote(remoteId);
                const zellijTerminalName = getSessionTerminalName('zellij', sessionName, remoteId);
                let existingTerminal = findTerminalByName(zellijTerminalName);
                if (existingTerminal) {
                    existingTerminal.dispose();
                }

                // Also try to find terminal by the original task name
                if (item.itemData?.type === 'task') {
                    const task = item.itemData as TerminalTaskItem;
                    const taskTerminal = findTerminalByName(task.name);
                    if (taskTerminal) {
                        taskTerminal.dispose();
                    }
                }

                // Delete the zellij session using centralized command building
                const { exec } = require('child_process');

                let command: string;
                if (remote.type === 'ssh') {
                    command = ZellijManager.getDeleteCommand(sessionName, remote);
                } else if (shouldUseLocalMultiplexerCommand()) {
                    command = ZellijManager.getDeleteCommand(sessionName);
                } else {
                    command = ZellijManager.getDeleteCommandForWSL(sessionName);
                }

                exec(command, (error: Error | null) => {
                    // Handle "session not found" as success - session is already gone
                    const isSessionNotFound = error?.message?.includes('session not found') ||
                                              error?.message?.includes('No zellij server listening') ||
                                              error?.message?.includes("doesn't exist");

                    if (error && !isSessionNotFound) {
                        vscode.window.showErrorMessage(`Failed to delete session: ${error.message}`);
                    } else {
                        if (isSessionNotFound) {
                            vscode.window.showInformationMessage(`Session "${sessionName}" already deleted`);
                        } else {
                            vscode.window.showInformationMessage(`Deleted zellij session "${sessionName}"`);
                        }
                    }
                    setTimeout(() => {
                        treeDataProvider.refresh();
                    }, 200);
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete session: ${error}`);
            }
        }
    );

    const attachZellijSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.attachZellijSession',
        async (sessionOrItem: ZellijSession | TaskTreeItem) => {
            let session: ZellijSession | undefined;

            // Handle both direct session object and TaskTreeItem
            if (sessionOrItem && 'itemData' in sessionOrItem) {
                // It's a TaskTreeItem from the tree view
                const item = sessionOrItem as TaskTreeItem;
                if (item.itemData?.type === 'zellijSession') {
                    session = (item.itemData as ZellijSessionData).session;
                }
            } else if (sessionOrItem && 'name' in sessionOrItem) {
                // It's a direct ZellijSession object
                session = sessionOrItem as ZellijSession;
            }

            if (!session) {
                vscode.window.showErrorMessage('No zellij session selected');
                return;
            }

            const remote = configManager.getRemote(session.remoteId);

            // Warn if session is EXITED — resurrection will re-run the last command which may fail
            let createFresh = false;
            if (session.exited) {
                const choice = await vscode.window.showWarningMessage(
                    `Session "${session.name}" is EXITED. Attaching will try to re-run its last command (which may fail).`,
                    'Delete & Fresh Shell',
                    'Attach Anyway'
                );
                if (choice === 'Delete & Fresh Shell') {
                    ZellijManager.deleteSessionSync(session.name, remote);
                    createFresh = true;
                } else if (choice !== 'Attach Anyway') {
                    return; // Cancelled
                }
            }

            // Check if terminal with this name already exists
            const terminalName = getSessionTerminalName('zellij', session.name, remote.id);
            const existingTerminal = findManagedTerminalByName(terminalName);
            if (existingTerminal && !createFresh) {
                // Reuse existing terminal - just show it
                try {
                    existingTerminal.show();
                    return;
                } catch {
                    // Terminal was disposed, fall through to create a new one
                }
            }
            disposeRestoredTerminalByName(terminalName);

            // Create terminal - don't set cwd since zellij will handle the working directory
            const terminalLocation = vscode.workspace.getConfiguration('terminalWorkspaces').get<string>('terminalLocation', 'panel');
            const terminal = createManagedTerminal({
                name: terminalName,
                location: terminalLocation === 'editor'
                    ? vscode.TerminalLocation.Editor
                    : vscode.TerminalLocation.Panel
            });

            terminal.show();

            // Send the appropriate command
            if (createFresh) {
                // Create a fresh session (old one was deleted)
                if (remote.type === 'ssh') {
                    terminal.sendText(ZellijManager.getNewSessionCommand(session.name, remote));
                } else if (shouldUseLocalMultiplexerCommand()) {
                    terminal.sendText(ZellijManager.getNewSessionCommand(session.name));
                } else {
                    terminal.sendText(ZellijManager.getNewSessionCommandForWSL(session.name));
                }
            } else if (remote.type === 'ssh') {
                terminal.sendText(ZellijManager.getAttachCommand(session.name, remote));
            } else if (shouldUseLocalMultiplexerCommand()) {
                terminal.sendText(ZellijManager.getAttachCommand(session.name));
            } else {
                // On Windows, need to go through WSL with proper escaping
                terminal.sendText(ZellijManager.getAttachCommandForWSL(session.name));
            }
        }
    );

    const importZellijSessionCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.importZellijSession',
        async (item: TaskTreeItem) => {
            if (!item?.itemData || item.itemData.type !== 'zellijSession') {
                return;
            }

            // Check for workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('Please open a folder first before importing sessions');
                return;
            }

            const sessionData = item.itemData as ZellijSessionData;
            const session = sessionData.session;

            // Ask for task name
            const name = await vscode.window.showInputBox({
                prompt: 'Task name for this session',
                value: session.name,
                validateInput: value => value.trim() ? null : 'Name cannot be empty'
            });

            if (!name) {
                return;
            }

            // Use session path if available, otherwise use workspace folder
            // Convert Windows path to WSL path if needed
            let taskPath = session.path;
            if (!taskPath) {
                const wsPath = workspaceFolders[0].uri.fsPath;
                // Convert Windows path to WSL path if needed
                if (process.platform === 'win32' || vscode.env.remoteName === 'wsl') {
                    const match = wsPath.match(/^([A-Za-z]):\\(.*)$/);
                    if (match) {
                        taskPath = `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
                    } else {
                        taskPath = wsPath;
                    }
                } else {
                    taskPath = wsPath;
                }
            }

            try {
                await configManager.addTask({
                    name,
                    path: taskPath,
                    remoteId: normalizeRemoteId(session.remoteId),
                    profileId: 'wsl-zellij',
                    overrides: {
                        zellij: {
                            enabled: true,
                            mode: 'attach-or-create',
                            sessionName: session.name
                        }
                    }
                });

                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Imported "${session.name}" as task "${name}"`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to import session: ${error}`);
            }
        }
    );

    const importZellijSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.importZellijSessions',
        async () => {
            // Check for workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('Please open a folder first before importing sessions');
                return;
            }

            if (!ZellijManager.isAvailable()) {
                vscode.window.showWarningMessage('zellij is not available in this environment');
                return;
            }

            const sessions = ZellijManager.getSessions();
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No zellij sessions found');
                return;
            }

            // Get existing task names to mark which are already tracked
            const flatTasks = configManager.flattenTasks();
            const trackedNames = new Set<string>();
            for (const ft of flatTasks) {
                const profile = configManager.getProfile(ft.task.profileId || configManager.getConfigSync()?.defaultProfileId || 'bash-tmux');
                if (profile?.zellij?.enabled === true || ft.task.overrides?.zellij?.enabled === true) {
                    const sessionName = ft.task.overrides?.zellij?.sessionName || ft.task.name;
                    trackedNames.add(sessionName.toLowerCase());
                }
            }

            // Build quick pick items
            const items = sessions.map(session => ({
                label: session.name,
                description: session.path || '',
                detail: trackedNames.has(session.name.toLowerCase())
                    ? '$(check) Already tracked'
                    : '$(circle-outline) Untracked',
                picked: !trackedNames.has(session.name.toLowerCase()),
                session
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select zellij sessions to import as tasks',
                canPickMany: true
            });

            if (!selected || selected.length === 0) {
                return;
            }

            // Filter out already tracked sessions
            const toImport = selected.filter(s => !trackedNames.has(s.session.name.toLowerCase()));

            if (toImport.length === 0) {
                vscode.window.showInformationMessage('All selected sessions are already tracked');
                return;
            }

            // Get default path for sessions without path info
            // Convert Windows path to WSL path if needed
            let defaultPath: string;
            const wsPath = workspaceFolders[0].uri.fsPath;
            if (process.platform === 'win32' || vscode.env.remoteName === 'wsl') {
                const match = wsPath.match(/^([A-Za-z]):\\(.*)$/);
                if (match) {
                    defaultPath = `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
                } else {
                    defaultPath = wsPath;
                }
            } else {
                defaultPath = wsPath;
            }

            // Import selected sessions
            let imported = 0;
            for (const item of toImport) {
                try {
                    await configManager.addTask({
                        name: item.session.name,
                        path: item.session.path || defaultPath,
                        profileId: 'wsl-zellij',
                        overrides: {
                            zellij: {
                                enabled: true,
                                mode: 'attach-or-create',
                                sessionName: item.session.name
                            }
                        }
                    });
                    imported++;
                } catch (error) {
                    console.error(`Failed to import session ${item.session.name}:`, error);
                }
            }

            treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Imported ${imported} zellij session(s) as tasks`);
        }
    );

    const attachAllZellijSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.attachAllZellijSessions',
        async () => {
            if (!ZellijManager.isAvailable()) {
                vscode.window.showWarningMessage('zellij is not available in this environment');
                return;
            }

            const untrackedSessions = treeDataProvider.getUntrackedZellijSessions();
            if (untrackedSessions.length === 0) {
                vscode.window.showInformationMessage('No untracked zellij sessions to attach');
                return;
            }

            const terminalLocation = vscode.workspace.getConfiguration('terminalWorkspaces').get<string>('terminalLocation', 'panel');

            for (const session of untrackedSessions) {
                const remote = configManager.getRemote(session.remoteId);
                const terminalName = getSessionTerminalName('zellij', session.name, remote.id);
                disposeRestoredTerminalByName(terminalName);
                const terminal = createManagedTerminal({
                    name: terminalName,
                    location: terminalLocation === 'editor'
                        ? vscode.TerminalLocation.Editor
                        : vscode.TerminalLocation.Panel
                });

                terminal.show();

                if (remote.type === 'ssh') {
                    terminal.sendText(ZellijManager.getAttachCommand(session.name, remote));
                } else if (shouldUseLocalMultiplexerCommand()) {
                    terminal.sendText(ZellijManager.getAttachCommand(session.name));
                } else {
                    // On Windows, need to go through WSL with proper escaping
                    terminal.sendText(ZellijManager.getAttachCommandForWSL(session.name));
                }
            }

            vscode.window.showInformationMessage(`Attached to ${untrackedSessions.length} zellij session(s)`);
        }
    );

    const refreshZellijSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.refreshZellijSessions',
        () => {
            treeDataProvider.refreshZellijSessions();
        }
    );

    const deleteAllExitedZellijSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.deleteAllExitedZellijSessions',
        async () => {
            // Get all zellij sessions and filter to EXITED ones
            const allSessions = ZellijManager.getSessions();
            const exitedSessions = allSessions.filter(s => s.exited);

            if (exitedSessions.length === 0) {
                vscode.window.showInformationMessage('No EXITED zellij sessions to delete');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete ${exitedSessions.length} EXITED zellij session(s)? This cannot be undone.`,
                { modal: true },
                'Delete All'
            );

            if (confirm !== 'Delete All') {
                return;
            }

            const { exec } = require('child_process');

            let deletedCount = 0;
            let failedCount = 0;

            for (const session of exitedSessions) {
                try {
                    const command = shouldUseLocalMultiplexerCommand()
                        ? ZellijManager.getDeleteCommand(session.name)
                        : ZellijManager.getDeleteCommandForWSL(session.name);

                    await new Promise<void>((resolve) => {
                        exec(command, (error: Error | null) => {
                            if (error) {
                                // Ignore "not found" errors - session may already be gone
                                const isNotFound = error.message?.includes('session not found') ||
                                                   error.message?.includes('No zellij server listening');
                                if (!isNotFound) {
                                    failedCount++;
                                } else {
                                    deletedCount++;
                                }
                            } else {
                                deletedCount++;
                            }
                            resolve();
                        });
                    });
                } catch {
                    failedCount++;
                }
            }

            if (failedCount > 0) {
                vscode.window.showWarningMessage(`Deleted ${deletedCount} session(s), ${failedCount} failed`);
            } else {
                vscode.window.showInformationMessage(`Deleted ${deletedCount} EXITED zellij session(s)`);
            }

            setTimeout(() => {
                treeDataProvider.refresh();
            }, 200);
        }
    );

    // =========================================================================
    // SEARCH TASKS
    // =========================================================================

    const searchTasksCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.searchTasks',
        async () => {
            const flatTasks = configManager.flattenTasks();

            if (flatTasks.length === 0) {
                vscode.window.showInformationMessage('No terminal tasks configured yet.');
                return;
            }

            // Build searchable items with tags and path info
            const items: (vscode.QuickPickItem & { taskName: string; tags?: string[] })[] = flatTasks.map(ft => {
                const tagsStr = ft.task.tags?.length ? ` [${ft.task.tags.join(', ')}]` : '';
                const folderPath = ft.namePath.slice(0, -1).join(' / ');
                return {
                    label: `$(terminal) ${ft.task.name}`,
                    description: folderPath || undefined,
                    detail: `${ft.task.path}${tagsStr}`,
                    taskName: ft.task.name,
                    tags: ft.task.tags
                };
            });

            const quickPick = vscode.window.createQuickPick();
            quickPick.items = items;
            quickPick.placeholder = 'Search tasks by name, folder, path, or tags...';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;

            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0] as typeof items[0];
                if (selected) {
                    vscode.commands.executeCommand('workbench.action.tasks.runTask', selected.taskName);
                }
                quickPick.hide();
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }
    );

    // =========================================================================
    // ATTACH ALL TMUX SESSIONS
    // =========================================================================

    const attachAllSessionsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.attachAllSessions',
        async () => {
            if (!TmuxManager.isAvailable()) {
                vscode.window.showWarningMessage('tmux is not available in this environment');
                return;
            }

            const untrackedSessions = treeDataProvider.getUntrackedTmuxSessions();
            if (untrackedSessions.length === 0) {
                vscode.window.showInformationMessage('No untracked tmux sessions to attach');
                return;
            }

            const terminalLocation = vscode.workspace.getConfiguration('terminalWorkspaces').get<string>('terminalLocation', 'panel');

            for (const session of untrackedSessions) {
                const remote = configManager.getRemote(session.remoteId);
                // Don't set cwd - tmux will restore the session's working directory
                const terminalName = getSessionTerminalName('tmux', session.name, remote.id);
                disposeRestoredTerminalByName(terminalName);
                const terminal = createManagedTerminal({
                    name: terminalName,
                    location: terminalLocation === 'editor'
                        ? vscode.TerminalLocation.Editor
                        : vscode.TerminalLocation.Panel
                });

                terminal.show(false); // Don't steal focus for subsequent terminals

                if (remote.type === 'ssh') {
                    terminal.sendText(TmuxManager.getAttachCommand(session.name, remote));
                } else if (shouldUseLocalMultiplexerCommand()) {
                    terminal.sendText(TmuxManager.getAttachCommand(session.name));
                } else {
                    // On Windows, need to go through WSL with proper escaping
                    terminal.sendText(TmuxManager.getAttachCommandForWSL(session.name));
                }
            }

            vscode.window.showInformationMessage(`Attached to ${untrackedSessions.length} tmux session(s)`);
        }
    );

    // =========================================================================
    // REVEAL IN EXPLORER
    // =========================================================================

    const revealInExplorerCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.revealInExplorer',
        async (element: any) => {
            if (!element?.itemData?.path) {
                vscode.window.showErrorMessage('No path available for this item');
                return;
            }

            const taskPath = element.itemData.path;

            // Convert WSL path to Windows path if needed
            let revealPath = taskPath;
            if (process.platform === 'win32' && taskPath.startsWith('/mnt/')) {
                const match = taskPath.match(/^\/mnt\/([a-z])\/(.*)/i);
                if (match) {
                    revealPath = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
                }
            }

            try {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(revealPath));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to reveal folder: ${error}`);
            }
        }
    );

    const revealInVSCodeExplorerCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.revealInVSCodeExplorer',
        async (element: any) => {
            if (!element?.itemData?.path) {
                vscode.window.showErrorMessage('No path available for this item');
                return;
            }

            const taskPath = element.itemData.path;

            // Convert WSL path to Windows path if needed for VS Code
            let revealPath = taskPath;
            if (process.platform === 'win32' && taskPath.startsWith('/mnt/')) {
                const match = taskPath.match(/^\/mnt\/([a-z])\/(.*)/i);
                if (match) {
                    revealPath = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
                }
            }

            try {
                // Reveal in VS Code's file explorer sidebar
                await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(revealPath));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to reveal in VS Code Explorer: ${error}`);
            }
        }
    );

    // =========================================================================
    // OPEN SETTINGS
    // =========================================================================

    const openSettingsCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.openSettings',
        async () => {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:cybersader.terminal-workspaces'
            );
        }
    );

    // =========================================================================
    // FILE WATCHER
    // =========================================================================

    const configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/terminal-workspaces.json');
    configWatcher.onDidChange(async () => {
        await configManager.loadConfig();
        treeDataProvider.refresh();
    });
    configWatcher.onDidCreate(async () => {
        await configManager.loadConfig();
        treeDataProvider.refresh();
    });
    configWatcher.onDidDelete(async () => {
        await configManager.loadConfig();
        treeDataProvider.refresh();
    });

    // =========================================================================
    // FILTER TOGGLE
    // =========================================================================

    const toggleFilter = () => {
        treeDataProvider.toggleActiveFilter();
        vscode.commands.executeCommand(
            'setContext',
            'terminalWorkspaces.showActiveOnly',
            treeDataProvider.isFilterActive
        );
    };

    const toggleActiveFilterCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.toggleActiveFilter',
        toggleFilter
    );

    const toggleActiveFilterOffCommand = vscode.commands.registerCommand(
        'terminalWorkspaces.toggleActiveFilterOff',
        toggleFilter
    );

    // =========================================================================
    // REGISTER ALL
    // =========================================================================

    context.subscriptions.push(
        treeView,
        refreshCommand,
        addRemoteCommand,
        deleteRemoteCommand,
        addTaskToRemoteCommand,
        addFolderCommand,
        addCurrentFileFolderCommand,
        addFileParentFolderCommand,
        addFromTerminalCommand,
        addBrowseFolderCommand,
        addTaskFolderCommand,
        runTaskByIdCommand,
        runTaskCommand,
        runAllTasksCommand,
        runFolderTasksCommand,
        editTaskCommand,
        renameCommand,
        deleteCommand,
        moveToFolderCommand,
        openConfigCommand,
        openTasksJsonCommand,
        regenerateTasksJsonCommand,
        openManagerCommand,
        openSettingsCommand,
        revealInExplorerCommand,
        revealInVSCodeExplorerCommand,
        searchTasksCommand,
        refreshTmuxSessionsCommand,
        importTmuxSessionsCommand,
        attachTmuxSessionCommand,
        attachAllSessionsCommand,
        importTmuxSessionCommand,
        killTmuxSessionCommand,
        killTmuxSessionFromTerminalCommand,
        killZellijSessionCommand,
        deleteZellijSessionCommand,
        attachZellijSessionCommand,
        importZellijSessionCommand,
        importZellijSessionsCommand,
        attachAllZellijSessionsCommand,
        refreshZellijSessionsCommand,
        deleteAllExitedZellijSessionsCommand,
        toggleActiveFilterCommand,
        toggleActiveFilterOffCommand,
        configWatcher
    );
}

// Helper: Get all task names from items recursively
function getAllTaskNames(items: (TerminalTaskItem | TaskFolder)[]): string[] {
    const names: string[] = [];
    for (const item of items) {
        if (item.type === 'task') {
            names.push(item.name);
        } else if (item.type === 'folder') {
            names.push(...getAllTaskNames(item.children));
        }
    }
    return names;
}

// Helper: Get all tasks from items recursively
function getAllTasks(items: (TerminalTaskItem | TaskFolder)[]): TerminalTaskItem[] {
    const tasks: TerminalTaskItem[] = [];
    for (const item of items) {
        if (item.type === 'task') {
            tasks.push(item);
        } else if (item.type === 'folder') {
            tasks.push(...getAllTasks(item.children));
        }
    }
    return tasks;
}

export function deactivate() {}
