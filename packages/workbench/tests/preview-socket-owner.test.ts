import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { capturePreviewProcess, connectOwnedPreview, verifyWindowsPreviewPeer } from '../server/preview-socket-owner';

const script = `const net=require('node:net');let bytes=0;const sockets=new Set();const server=net.createServer(s=>{sockets.add(s);s.on('data',b=>{bytes+=b.length;s.end('owned response')});s.on('close',()=>sockets.delete(s));});server.listen(Number(process.argv[1]||0),'127.0.0.1',()=>process.send(server.address().port));process.on('message',m=>{if(m==='bytes')process.send(bytes);if(m==='unbind'){for(const s of sockets)s.destroy();server.close(()=>process.send('unbound'));}if(m==='close'){for(const s of sockets)s.destroy();server.close(()=>process.exit(0));}});`;
async function launch(port = 0) {
  const child = spawn(process.execPath, ['-e', script, String(port)], { detached: process.platform !== 'win32', stdio: ['ignore','ignore','ignore','ipc'] });
  const [boundPort] = await once(child, 'message');
  assert.equal(typeof boundPort, 'number');
  return { child, port: boundPort };
}
async function close(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.send('close');
  await once(child, 'exit');
}
test('actual established socket admits its launch and sends zero bytes to another live responder', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch(), other = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    await assert.rejects(connectOwnedPreview({ port: other.port, identity, signal: new AbortController().signal }), /ownership/);
    other.child.send('bytes');
    assert.equal((await once(other.child, 'message'))[0], 0);
    const socket = await connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal });
    const reply = once(socket, 'data');
    socket.write('GET / HTTP/1.0\r\n\r\n');
    assert.equal(String((await reply)[0]), 'owned response');
    socket.destroy();
    await assert.rejects(connectOwnedPreview({ port: owned.port, identity: { ...identity, start: identity.start + 1 }, signal: new AbortController().signal }), /ownership/);
  } finally { await close(owned.child); await close(other.child); }
});

test('live launcher cannot authorize another process that rebinds its former port', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  let rebound;
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    owned.child.send('unbind'); await once(owned.child, 'message');
    rebound = await launch(owned.port);
    assert.equal(owned.child.exitCode, null);
    await assert.rejects(connectOwnedPreview({ port: rebound.port, identity, signal: new AbortController().signal }), /ownership/);
    rebound.child.send('bytes'); assert.equal((await once(rebound.child, 'message'))[0], 0);
  } finally { await close(owned.child); if (rebound) await close(rebound.child); }
});

test('abort during ownership verification settles and prevents subsequent platform lookups', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<never>();
  let scans = 0, tcpQueries = 0;
  const result = verifyWindowsPreviewPeer({ localPort: 42000, remotePort: 42001 }, { pid: 10, start: 1, platform: 'win32' }, controller.signal, {
    processes: async () => { scans++; entered.resolve(); return release.promise; },
    owner: async () => { tcpQueries++; return 10; },
  });
  await entered.promise; controller.abort();
  await assert.rejects(Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error('Did not cancel')), 100))]), /ownership/);
  release.reject(new Error('Canceled scan')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 1); assert.equal(tcpQueries, 0);
});

// Linux lists a connection still in the listener's accept queue with socket inode 0.
function tcpTableWithUnacceptedReads(unacceptedReads: number) {
  const reads = { count: 0 };
  const read = async () => {
    reads.count++;
    const table = await readFile('/proc/net/tcp', 'utf8');
    if (reads.count > unacceptedReads) return table;
    const [header, ...rows] = table.trim().split('\n');
    return [header, ...rows.map(row => { const parts = row.trim().split(/\s+/); parts[9] = '0'; return parts.join(' '); })].join('\n');
  };
  return { reads, read };
}
test('ownership waits for the preview server to accept a connection before checking its socket', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    const table = tcpTableWithUnacceptedReads(2);
    const socket = await connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: table.read });
    assert.ok(table.reads.count >= 3, `read the table ${table.reads.count} times`);
    socket.destroy();
  } finally { await close(owned.child); }
});
test('ownership refuses a connection that is never accepted once the deadline ends', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    const table = tcpTableWithUnacceptedReads(Infinity);
    const started = Date.now();
    await assert.rejects(connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: table.read }), /ownership/);
    assert.ok(table.reads.count > 2, `retried ${table.reads.count} times`);
    assert.ok(Date.now() - started >= 2500, 'refused at the ownership deadline, not at once');
    owned.child.send('bytes'); assert.equal((await once(owned.child, 'message'))[0], 0);
  } finally { await close(owned.child); }
});

// Rewrites the server-side row of the preview connection for the first `early` reads.
function tcpTableRewritingServerRow(port: number, early: number, rewrite: (parts: string[]) => string[][]) {
  const reads = { count: 0 };
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const read = async () => {
    reads.count++;
    const table = await readFile('/proc/net/tcp', 'utf8');
    if (reads.count > early) return table;
    const [header, ...rows] = table.trim().split('\n');
    return [header, ...rows.flatMap(row => {
      const parts = row.trim().split(/\s+/);
      return parts[1] === local && parts[3] === '01' ? rewrite(parts).map(item => item.join(' ')) : [parts.join(' ')];
    })].join('\n');
  };
  return { reads, read };
}
const missingRow = () => [];
const handshakeRow = (parts: string[]) => [Object.assign([...parts], { 3: '03' })];
const repeatedRow = (parts: string[]) => [parts, parts];
test('ownership waits while the server row is missing, still in handshake, or listed twice by a torn table read', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    for (const [name, rewrite] of [['missing', missingRow], ['handshake', handshakeRow], ['repeated', repeatedRow]] as const) {
      const table = tcpTableRewritingServerRow(owned.port, 2, rewrite);
      const socket = await connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: table.read });
      // A repeated row never refuses. The read count depends on when the server accepts.
      if (name !== 'repeated') assert.ok(table.reads.count >= 3, name);
      socket.destroy();
    }
  } finally { await close(owned.child); }
});
test('ownership refuses at the deadline when the server row never appears, and at once for conflicting rows', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    const missing = tcpTableRewritingServerRow(owned.port, Infinity, missingRow);
    let started = Date.now();
    await assert.rejects(connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: missing.read }), /ownership/);
    assert.ok(missing.reads.count > 2 && Date.now() - started >= 2500, 'a row that never appears is refused at the deadline');
    const conflicting = tcpTableRewritingServerRow(owned.port, Infinity,
      parts => [Object.assign([...parts], { 9: '900000001' }), Object.assign([...parts], { 9: '900000002' })]);
    await assert.rejects(connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: conflicting.read }), /ownership/);
    assert.equal(conflicting.reads.count, 1, 'two rows naming different sockets are refused at once');
    owned.child.send('bytes'); assert.equal((await once(owned.child, 'message'))[0], 0);
  } finally { await close(owned.child); }
});
test('ownership treats a row listed with inode 0 beside its accepted inode as one connection', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    // A torn read that crosses the accept can list the connection once before and once after it.
    const table = tcpTableRewritingServerRow(owned.port, Infinity, parts => [Object.assign([...parts], { 9: '0' }), parts]);
    const socket = await connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: table.read });
    socket.destroy();
  } finally { await close(owned.child); }
});
test('ownership stops waiting when the preview closes the connection before its row is visible', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const owned = await launch();
  try {
    const identity = await capturePreviewProcess(owned.child);
    assert.ok(identity);
    const reads = { count: 0 };
    const serverEndpoint = `0100007F:${owned.port.toString(16).toUpperCase().padStart(4, '0')}`;
    // The first read returns only after the preview has closed the accepted connection and the client
    // side has left ESTABLISHED, so its close is pending on this event loop when the check next waits.
    const read = async () => {
      if (++reads.count === 1) {
        owned.child.send('unbind'); await once(owned.child, 'message');
        for (;;) {
          const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
          if (!rows.some(row => row[2] === serverEndpoint && row[3] === '01')) break;
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      return readFile('/proc/net/tcp', 'utf8');
    };
    await assert.rejects(connectOwnedPreview({ port: owned.port, identity, signal: new AbortController().signal, readTcpTable: read }), /ownership/);
    // Waiting for the deadline would keep rereading the table until it fired. The close stops it at once.
    assert.ok(reads.count <= 2, `the check stopped when the connection closed, after ${reads.count} reads`);
  } finally { await close(owned.child); }
});
