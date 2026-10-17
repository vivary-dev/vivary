import type { ChildProcess } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readLinuxProcStat, scanLinuxWorkerGroup, scanWindowsProcesses, windowsTcpOwner } from './code-execution-host';

type ProcessIdentity = { pid: number; start: number; platform: 'linux' | 'win32' };
const refused = () => new Error('Preview socket ownership could not be established.');
const readLinuxTcpTable = () => readFile('/proc/net/tcp', 'utf8');
export async function capturePreviewProcess(child: ChildProcess): Promise<ProcessIdentity | null> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return null;
  try {
    if (process.platform === 'linux') {
      const info = readLinuxProcStat(await readFile(`/proc/${child.pid}/stat`, 'utf8'));
      if (info.processGroup !== child.pid) return null;
      return { pid: child.pid, start: info.start, platform: 'linux' };
    }
    if (process.platform === 'win32') {
      const info = (await scanWindowsProcesses()).find(row => row.pid === child.pid);
      return info?.created ? { pid: child.pid, start: info.created, platform: 'win32' } : null;
    }
  } catch { /* Unknown ownership remains unavailable to remote previews. */ }
  return null;
}
async function verifyLinux(socket: Socket, identity: ProcessIdentity, signal: AbortSignal, readTcpTable: () => Promise<string>) {
  signal.throwIfAborted();
  const root = readLinuxProcStat(await readFile(`/proc/${identity.pid}/stat`, 'utf8'));
  if (root.start !== identity.start || root.processGroup !== identity.pid) throw refused();
  const endpoint = (port: number) => `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const localPort = socket.localPort, remotePort = socket.remotePort;
  if (!localPort || !remotePort) throw refused();
  let inode: string | undefined;
  // The server's row proves nothing yet while it is missing, still in the handshake, or listed with
  // inode 0 because the server has not accepted the connection. A read of this table is not atomic,
  // so a busy host can also skip the row or list it twice. Wait with a bounded backoff in those cases.
  // The caller's deadline aborts `signal`, so a connection that never qualifies is still refused.
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    const rows = (await readTcpTable()).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
    const inodes = new Set(rows.filter(row => row[1] === endpoint(remotePort) && row[2] === endpoint(localPort)
      && row[3] === '01').map(row => row[9]));
    // Inode 0 means not yet accepted, not another socket. A torn read can list both states of one row.
    inodes.delete('0');
    // Two rows naming different sockets for one connection are conflicting evidence, never a timing gap.
    if (inodes.size > 1) throw refused();
    inode = [...inodes][0];
    if (inode !== undefined) break;
    await delay(wait, undefined, { signal });
  }
  if (!inode || !/^\d+$/.test(inode)) throw refused();
  signal.throwIfAborted();
  const group = await scanLinuxWorkerGroup(identity.pid, undefined, signal);
  if (group.hidden) throw refused();
  for (const member of group.members) {
    signal.throwIfAborted();
    for (const fd of await readdir(`/proc/${member.pid}/fd`)) {
      signal.throwIfAborted();
      let link;
      try { link = await readlink(`/proc/${member.pid}/fd/${fd}`); } catch { continue; }
      if (link !== `socket:[${inode}]`) continue;
      const current = readLinuxProcStat(await readFile(`/proc/${member.pid}/stat`, 'utf8'));
      const stillRoot = readLinuxProcStat(await readFile(`/proc/${identity.pid}/stat`, 'utf8'));
      if (current.start === member.start && current.processGroup === identity.pid && stillRoot.start === identity.start) return;
    }
  }
  throw refused();
}
async function readWhileActive<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(refused()); signal.addEventListener('abort', abort, { once: true }); });
  try { const result = await Promise.race([read(), stopped]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', abort); }
}
export async function verifyWindowsPreviewPeer(socket: Pick<Socket, 'localPort' | 'remotePort'>, identity: ProcessIdentity, signal: AbortSignal,
  lookup = { processes: scanWindowsProcesses, owner: windowsTcpOwner }) {
  if (!socket.localPort || !socket.remotePort) throw refused();
  const before = await readWhileActive(signal, () => lookup.processes(signal));
  const root = before.find(row => row.pid === identity.pid);
  if (root?.created !== identity.start) throw refused();
  const serverPort = socket.remotePort, clientPort = socket.localPort;
  const pid = await readWhileActive(signal, () => lookup.owner(serverPort, clientPort, signal));
  const rows = await readWhileActive(signal, () => lookup.processes(signal));
  if (rows.find(row => row.pid === identity.pid)?.created !== identity.start) throw refused();
  let member = rows.find(row => row.pid === pid);
  const visited = new Set<number>();
  while (member?.created && !visited.has(member.pid)) {
    visited.add(member.pid);
    if (before.find(row => row.pid === member?.pid)?.created !== member.created) throw refused();
    if (member.pid === identity.pid && member.created === identity.start) return;
    const parent = rows.find(row => row.pid === member?.parentPid);
    if (!parent?.created || parent.created > member.created) throw refused();
    member = parent;
  }
  throw refused();
}

// No HTTP bytes leave this socket until its established peer belongs to this live launch.
export async function connectOwnedPreview({ port, identity, signal, readTcpTable = readLinuxTcpTable }: {
  port: number; identity: ProcessIdentity; signal: AbortSignal; readTcpTable?: () => Promise<string>;
}): Promise<Socket> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || signal.aborted) throw refused();
  const deadline = new AbortController();
  // A connection the preview closes or resets can never prove ownership, so its close ends verification.
  const lost = new AbortController();
  const verificationSignal = AbortSignal.any([signal, deadline.signal, lost.signal]);
  const socket = createConnection({ host: '127.0.0.1', port });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  socket.once('close', () => { signal.removeEventListener('abort', abort); lost.abort(); });
  const timer = setTimeout(() => { deadline.abort(); abort(); }, 3000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(refused()));
    });
    if (identity.platform === 'linux') await readWhileActive(verificationSignal, () => verifyLinux(socket, identity, verificationSignal, readTcpTable));
    else await verifyWindowsPreviewPeer(socket, identity, verificationSignal);
    if (signal.aborted || socket.destroyed) throw refused();
    return socket;
  } catch { socket.destroy(); throw refused(); }
  finally { clearTimeout(timer); }
}
