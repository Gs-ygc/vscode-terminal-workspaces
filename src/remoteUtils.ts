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

export function buildSshCommand(remote: RemoteConfig, remoteCommand: string, allocateTty: boolean): string {
    if (remote.type !== 'ssh' || !remote.host) {
        return remoteCommand;
    }

    const args = [
        'ssh',
        allocateTty ? '-t' : '-T',
        ...(remote.sshArgs || []),
        remote.host,
        remoteCommand
    ];

    return args.map(shellQuote).join(' ');
}
