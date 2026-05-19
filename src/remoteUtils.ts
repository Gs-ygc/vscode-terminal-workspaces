import { RemoteConfig } from './types';

export const LOCAL_REMOTE_ID = 'local';

export function createLocalRemote(): RemoteConfig {
    return {
        id: LOCAL_REMOTE_ID,
        label: 'Host',
        type: 'local'
    };
}

export function normalizeRemoteId(remoteId?: string): string {
    return remoteId || LOCAL_REMOTE_ID;
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildRemoteShellInvocation(remote: RemoteConfig, remoteCommand: string): string {
    const escapedCommand = remoteCommand.replace(/'/g, "'\\''");
    if (remote.shell) {
        return `${shellQuote(remote.shell)} -ic '${escapedCommand}'`;
    }
    return `sh -lc 'exec "\${SHELL:-sh}" -ic '\\''${escapedCommand}'\\'''`;
}

/**
 * Quote a value for embedding inside an SSH remote command that will itself be
 * wrapped in outer single-quotes (see buildSshCommand). Uses double-quotes
 * so there is no conflict with the outer single-quote wrapper.
 * Single-quotes inside the value are safely passed through (they're inside
 * double-quotes on the remote side).
 */
export function sshValueQuote(value: string): string {
    // Escape backslashes and double-quotes for the remote shell double-quote context.
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function buildSshCommand(remote: RemoteConfig, remoteCommand: string, allocateTty: boolean): string {
    if (remote.type !== 'ssh' || !remote.host) {
        return remoteCommand;
    }

    const localArgs = [
        'ssh',
        allocateTty ? '-t' : '-T',
        ...(remote.sshArgs || []),
        remote.host
    ].map(arg => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));

    // Wrap the remote command in an interactive shell:
    //   - by default, ask the remote POSIX sh to expand "$SHELL" before exec'ing
    //     the user's login shell; quoting "$SHELL" literally would try to run a
    //     command named "$SHELL".
    //   - outer single-quotes prevent the LOCAL shell (PowerShell or bash) from
    //     expanding $HOME / $PATH / $SHELL before the command reaches SSH.
    //   - Any single-quotes inside remoteCommand are escaped with the classic
    //     POSIX workaround: end-quote + escaped-quote + start-quote ('\'')
    const wrappedCmd = buildRemoteShellInvocation(remote, remoteCommand);

    // The whole thing is an unquoted argument on the local side — no outer
    // quotes needed because localArgs already handles whitespace in host/args.
    return `${localArgs.join(' ')} ${wrappedCmd}`;
}

/**
 * Build SSH arguments array for use with execFileSync/execFile.
 * Unlike buildSshCommand, this does NOT shell-quote arguments, so it works on
 * both Windows (cmd.exe) and POSIX platforms without any shell interpretation.
 * The remoteCommand is passed as a single argument to SSH and is run by the
 * remote shell, so it may use POSIX shell features (pipes, redirections, etc.).
 * BatchMode=yes prevents interactive prompts (password/host-key) from hanging.
 */
export function buildSshArgs(remote: RemoteConfig, remoteCommand: string, allocateTty: boolean): string[] {
    if (remote.type !== 'ssh' || !remote.host) {
        // Not an SSH remote — caller should use the remoteCommand directly
        return [];
    }
    return [
        allocateTty ? '-t' : '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        ...(remote.sshArgs || []),
        remote.host,
        remoteCommand
    ];
}
