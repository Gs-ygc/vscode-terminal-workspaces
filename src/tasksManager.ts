import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PathConverter } from './pathConverter';

interface TaskDefinition {
    label: string;
    type?: string;
    command?: string;
    args?: string[];
    options?: {
        cwd?: string;
        shell?: {
            executable?: string;
            args?: string[];
        };
    };
    presentation?: {
        panel?: string;
        name?: string;
        reveal?: string;
    };
    isBackground?: boolean;
    problemMatcher?: string[];
    dependsOn?: string[];
    runOptions?: {
        runOn?: string;
    };
}

interface TasksJson {
    version: string;
    tasks: TaskDefinition[];
}

export interface TerminalTask {
    label: string;
    path?: string;
    isGroup?: boolean;
    dependsOn?: string[];
}

export class TasksManager {
    private pathConverter = new PathConverter();

    /**
     * Detect if VS Code is connected to WSL via Remote-WSL extension
     * or running natively on Windows/Linux
     */
    private isRemoteWSL(): boolean {
        // Check if we're in a remote WSL session
        const remoteAuthority = vscode.env.remoteName;
        return remoteAuthority === 'wsl';
    }

    /**
     * Detect if running on Windows (either native or via WSL remote)
     */
    private isWindows(): boolean {
        // Remote extension hosts execute tasks on the remote machine, even when
        // the VS Code UI is running on Windows.
        if (vscode.env.remoteName) {
            return false;
        }
        // Check the actual platform
        return process.platform === 'win32';
    }

    private getWorkspaceFolder(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }

    private getTasksJsonPath(): string | undefined {
        const workspaceFolder = this.getWorkspaceFolder();
        if (!workspaceFolder) {
            return undefined;
        }
        return path.join(workspaceFolder, '.vscode', 'tasks.json');
    }

    private async readTasksJson(): Promise<TasksJson> {
        const tasksPath = this.getTasksJsonPath();
        if (!tasksPath) {
            throw new Error('No workspace folder open');
        }

        // Ensure .vscode directory exists
        const vscodePath = path.dirname(tasksPath);
        if (!fs.existsSync(vscodePath)) {
            fs.mkdirSync(vscodePath, { recursive: true });
        }

        if (!fs.existsSync(tasksPath)) {
            return {
                version: '2.0.0',
                tasks: []
            };
        }

        const content = fs.readFileSync(tasksPath, 'utf8');

        // Remove comments (VS Code tasks.json supports // comments)
        const cleanedContent = content
            .split('\n')
            .map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//')) {
                    return ''; // Remove full-line comments
                }
                // Remove inline comments (be careful with strings)
                const commentIndex = line.indexOf('//');
                if (commentIndex > 0 && !this.isInString(line, commentIndex)) {
                    return line.substring(0, commentIndex);
                }
                return line;
            })
            .join('\n');

        try {
            return JSON.parse(cleanedContent);
        } catch (error) {
            // If parsing fails, try to preserve the file and return empty tasks
            console.error('Failed to parse tasks.json:', error);
            throw new Error('Failed to parse tasks.json. The file may have syntax errors.');
        }
    }

    private isInString(line: string, position: number): boolean {
        let inString = false;
        let stringChar = '';
        for (let i = 0; i < position; i++) {
            if ((line[i] === '"' || line[i] === "'") && (i === 0 || line[i - 1] !== '\\')) {
                if (!inString) {
                    inString = true;
                    stringChar = line[i];
                } else if (line[i] === stringChar) {
                    inString = false;
                }
            }
        }
        return inString;
    }

    private async writeTasksJson(tasksJson: TasksJson): Promise<void> {
        const tasksPath = this.getTasksJsonPath();
        if (!tasksPath) {
            throw new Error('No workspace folder open');
        }

        // Ensure .vscode directory exists
        const vscodePath = path.dirname(tasksPath);
        if (!fs.existsSync(vscodePath)) {
            fs.mkdirSync(vscodePath, { recursive: true });
        }

        const content = JSON.stringify(tasksJson, null, 2);
        fs.writeFileSync(tasksPath, content, 'utf8');
    }

    private getConfig() {
        return vscode.workspace.getConfiguration('terminalWorkspaces');
    }

    private createTaskDefinition(name: string, folderPath: string): TaskDefinition {
        const config = this.getConfig();
        let template = config.get<string>('taskTemplate', 'auto');

        // Auto-detect best template based on environment
        if (template === 'auto') {
            if (this.isRemoteWSL()) {
                template = 'wsl-connected';
            } else if (this.isWindows()) {
                template = 'wsl-from-windows';
            } else {
                template = 'bash';
            }
        }

        // Convert path based on template
        const wslPath = this.pathConverter.toWslPath(folderPath);
        const windowsPath = this.pathConverter.toWindowsPath(folderPath);

        switch (template) {
            case 'wsl-connected':
                // VS Code is connected to WSL via Remote-WSL
                // Shell commands run directly in WSL bash
                return {
                    label: name,
                    type: 'shell',
                    command: `cd '${wslPath}' && exec bash`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: []
                };

            case 'wsl-from-windows':
                // VS Code is on Windows, launching WSL terminals
                // Use wsl.exe with --cd flag (Windows path format)
                return {
                    label: name,
                    type: 'shell',
                    command: `wsl.exe --cd "${windowsPath}"`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: [],
                    options: {
                        shell: { executable: 'cmd.exe', args: ['/C'] }
                    }
                };

            case 'wsl-bash':
                // VS Code is on Windows, but we want to run bash commands in WSL
                // Use wsl.exe -e bash -c "command"
                return {
                    label: name,
                    type: 'shell',
                    command: `wsl.exe -e bash -c "cd '${wslPath}' && exec bash"`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: [],
                    options: {
                        shell: { executable: 'cmd.exe', args: ['/C'] }
                    }
                };

            case 'bash':
                // Native Linux/macOS bash
                return {
                    label: name,
                    type: 'shell',
                    command: `cd '${folderPath}' && exec bash`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: []
                };

            case 'powershell':
                // Windows PowerShell
                return {
                    label: name,
                    type: 'shell',
                    command: `Set-Location '${windowsPath}'`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: [],
                    options: {
                        shell: { executable: 'powershell.exe' }
                    }
                };

            case 'cmd':
                // Windows CMD
                return {
                    label: name,
                    type: 'shell',
                    command: `cd /d "${windowsPath}"`,
                    presentation: { panel: 'new', name: name },
                    isBackground: true,
                    problemMatcher: [],
                    options: {
                        shell: { executable: 'cmd.exe', args: ['/K'] }
                    }
                };

            case 'custom':
                const customTemplate = config.get<TaskDefinition>('customTemplate');
                if (customTemplate) {
                    const task = JSON.parse(JSON.stringify(customTemplate)) as TaskDefinition;
                    task.label = name;
                    if (task.command) {
                        task.command = task.command
                            .replace(/\$\{path\}/g, folderPath)
                            .replace(/\$\{wslPath\}/g, wslPath)
                            .replace(/\$\{windowsPath\}/g, windowsPath)
                            .replace(/\$\{name\}/g, name);
                    }
                    if (task.presentation?.name) {
                        task.presentation.name = task.presentation.name.replace(/\$\{name\}/g, name);
                    }
                    return task;
                }
                // Fallback to auto-detection
                return this.createTaskDefinition(name, folderPath);

            default:
                // Use auto-detection as fallback
                if (this.isRemoteWSL()) {
                    return {
                        label: name,
                        type: 'shell',
                        command: `cd '${wslPath}' && exec bash`,
                        presentation: { panel: 'new', name: name },
                        isBackground: true,
                        problemMatcher: []
                    };
                } else if (this.isWindows()) {
                    return {
                        label: name,
                        type: 'shell',
                        command: `wsl.exe --cd "${windowsPath}"`,
                        presentation: { panel: 'new', name: name },
                        isBackground: true,
                        problemMatcher: [],
                        options: {
                            shell: { executable: 'cmd.exe', args: ['/C'] }
                        }
                    };
                } else {
                    return {
                        label: name,
                        type: 'shell',
                        command: `cd '${folderPath}' && exec bash`,
                        presentation: { panel: 'new', name: name },
                        isBackground: true,
                        problemMatcher: []
                    };
                }
        }
    }

    async addTask(name: string, folderPath: string): Promise<void> {
        const tasksJson = await this.readTasksJson();
        const config = this.getConfig();

        // Check if task already exists
        const existingIndex = tasksJson.tasks.findIndex(t => t.label === name);
        if (existingIndex !== -1) {
            const overwrite = await vscode.window.showWarningMessage(
                `A task named "${name}" already exists. Overwrite?`,
                'Overwrite',
                'Cancel'
            );
            if (overwrite !== 'Overwrite') {
                return;
            }
            tasksJson.tasks.splice(existingIndex, 1);
        }

        // Create the task
        const task = this.createTaskDefinition(name, folderPath);
        tasksJson.tasks.push(task);

        // Handle group task
        if (config.get<boolean>('autoAddToGroup', true)) {
            const groupLabel = config.get<string>('groupTaskLabel', 'Open All Terminals');
            let groupTask = tasksJson.tasks.find(t => t.label === groupLabel && t.dependsOn);

            if (!groupTask) {
                // Create group task
                groupTask = {
                    label: groupLabel,
                    dependsOn: [name],
                    problemMatcher: []
                };
                // Insert at the beginning
                tasksJson.tasks.unshift(groupTask);
            } else {
                // Add to existing group
                if (!groupTask.dependsOn) {
                    groupTask.dependsOn = [];
                }
                if (!groupTask.dependsOn.includes(name)) {
                    groupTask.dependsOn.push(name);
                }
            }
        }

        await this.writeTasksJson(tasksJson);
    }

    async removeTask(label: string): Promise<void> {
        const tasksJson = await this.readTasksJson();
        const config = this.getConfig();

        // Remove the task
        const taskIndex = tasksJson.tasks.findIndex(t => t.label === label);
        if (taskIndex === -1) {
            throw new Error(`Task "${label}" not found`);
        }
        tasksJson.tasks.splice(taskIndex, 1);

        // Remove from group task if applicable
        const groupLabel = config.get<string>('groupTaskLabel', 'Open All Terminals');
        const groupTask = tasksJson.tasks.find(t => t.label === groupLabel && t.dependsOn);
        if (groupTask && groupTask.dependsOn) {
            groupTask.dependsOn = groupTask.dependsOn.filter(l => l !== label);
        }

        await this.writeTasksJson(tasksJson);
    }

    async renameTask(oldLabel: string, newLabel: string): Promise<void> {
        const tasksJson = await this.readTasksJson();
        const config = this.getConfig();

        // Find and rename the task
        const task = tasksJson.tasks.find(t => t.label === oldLabel);
        if (!task) {
            throw new Error(`Task "${oldLabel}" not found`);
        }
        task.label = newLabel;
        if (task.presentation?.name === oldLabel) {
            task.presentation.name = newLabel;
        }

        // Update group task if applicable
        const groupLabel = config.get<string>('groupTaskLabel', 'Open All Terminals');
        const groupTask = tasksJson.tasks.find(t => t.label === groupLabel && t.dependsOn);
        if (groupTask && groupTask.dependsOn) {
            const index = groupTask.dependsOn.indexOf(oldLabel);
            if (index !== -1) {
                groupTask.dependsOn[index] = newLabel;
            }
        }

        await this.writeTasksJson(tasksJson);
    }

    async updateTaskPath(label: string, newPath: string): Promise<void> {
        const tasksJson = await this.readTasksJson();

        // Find the task
        const taskIndex = tasksJson.tasks.findIndex(t => t.label === label);
        if (taskIndex === -1) {
            throw new Error(`Task "${label}" not found`);
        }

        // Recreate the task with the new path
        const newTask = this.createTaskDefinition(label, newPath);
        tasksJson.tasks[taskIndex] = newTask;

        await this.writeTasksJson(tasksJson);
    }

    async migrateAllTasks(): Promise<number> {
        const tasksJson = await this.readTasksJson();
        let migratedCount = 0;

        for (let i = 0; i < tasksJson.tasks.length; i++) {
            const task = tasksJson.tasks[i];

            // Skip group tasks
            if (task.dependsOn) {
                continue;
            }

            // Skip tasks that don't look like terminal tasks
            if (task.presentation?.panel !== 'new') {
                continue;
            }

            // Extract the path from the current command
            const currentPath = this.extractPathFromCommand(task.command);
            if (!currentPath) {
                continue;
            }

            // Recreate the task with the current template
            const newTask = this.createTaskDefinition(task.label, currentPath);
            tasksJson.tasks[i] = newTask;
            migratedCount++;
        }

        if (migratedCount > 0) {
            await this.writeTasksJson(tasksJson);
        }

        return migratedCount;
    }

    async getTerminalTasks(): Promise<TerminalTask[]> {
        try {
            const tasksJson = await this.readTasksJson();
            return tasksJson.tasks
                .filter(t => t.presentation?.panel === 'new' || t.dependsOn)
                .map(t => ({
                    label: t.label,
                    path: this.extractPathFromCommand(t.command),
                    isGroup: !!t.dependsOn,
                    dependsOn: t.dependsOn
                }));
        } catch {
            return [];
        }
    }

    private extractPathFromCommand(command?: string): string | undefined {
        if (!command) {
            return undefined;
        }

        // Try to extract path from "cd 'path'" or "cd \"path\""
        const cdMatch = command.match(/cd\s+['"]([^'"]+)['"]/);
        if (cdMatch) {
            return cdMatch[1];
        }

        // Try to extract from wsl.exe --cd "path"
        const wslMatch = command.match(/--cd\s+["']?([^"'\s]+)["']?/);
        if (wslMatch) {
            return wslMatch[1];
        }

        return undefined;
    }
}
