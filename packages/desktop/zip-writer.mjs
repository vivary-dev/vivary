// A small ZIP writer for the release files, so the release build needs no `zip` program and runs the same on
// Windows and Linux. It writes what `zip -q -r -X` wrote: one folder, every file deflated, a directory entry for
// each folder, and no extra fields. Entries are sorted, so the same tree gives the same archive.
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { crc32, createDeflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";

const LIMIT = 0xffffffff;

function dosTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function walk(root, relative, entries) {
  const absolute = path.join(root, ...relative.split("/"));
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Refusing to zip the symbolic link ${relative}.`);
  if (info.isDirectory()) {
    entries.push({ name: `${relative}/`, absolute, info, directory: true });
    const names = (await readdir(absolute)).sort();
    for (const name of names) await walk(root, `${relative}/${name}`, entries);
  } else if (info.isFile()) {
    entries.push({ name: relative, absolute, info, directory: false });
  } else {
    throw new Error(`Refusing to zip ${relative}, which is neither a file nor a folder.`);
  }
}

/** Writes `outputFile` with the folder `entry` inside `parent`, as `zip -q -r -X outputFile entry` run in `parent`. */
export async function zipFolder(parent, entry, outputFile) {
  if (entry.includes("\\") || entry.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`Refusing to zip the folder name ${entry}.`);
  }
  if (await lstat(outputFile).catch(() => null)) throw new Error(`Refusing to overwrite ${outputFile}.`);
  const entries = [];
  await walk(parent, entry, entries);
  // `wx` also refuses a file that appears meanwhile, as the rest of the release step does.
  const file = await open(outputFile, "wx");
  // Small headers are batched, so a tree of many small files costs few write calls.
  let offset = 0;
  let written = 0;
  let pending = [];
  let pendingSize = 0;
  const flush = async () => {
    if (!pendingSize) return;
    const batch = Buffer.concat(pending, pendingSize);
    pending = [];
    pendingSize = 0;
    await file.write(batch, 0, batch.length, written);
    written += batch.length;
  };
  const write = async buffer => {
    pending.push(buffer);
    pendingSize += buffer.length;
    offset += buffer.length;
    if (pendingSize >= 1 << 20) await flush();
  };
  const central = [];
  try {
    for (const item of entries) {
      const name = Buffer.from(item.name, "utf8");
      const { time, date } = dosTime(item.info.mtime);
      const start = offset;
      if (start >= LIMIT) throw new Error("The archive is larger than this writer supports (4 GiB).");
      // Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8.
      const flags = item.directory ? 0x0800 : 0x0808;
      const method = item.directory ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      await write(Buffer.concat([local, name]));
      let crc = 0;
      let size = 0;
      let compressed = 0;
      if (!item.directory && item.info.size <= 1 << 20) {
        // Most files are small, and a stream for each costs more than the data.
        const content = item.info.size === 0 ? Buffer.alloc(0) : await readFile(item.absolute);
        const deflated = deflateRawSync(content, { level: 6 });
        crc = crc32(content);
        size = content.length;
        compressed = deflated.length;
        await write(deflated);
      } else if (!item.directory) {
        const deflate = createDeflateRaw({ level: 6 });
        const source = createReadStream(item.absolute);
        source.on("data", chunk => {
          crc = crc32(chunk, crc);
          size += chunk.length;
        });
        source.on("error", error => deflate.destroy(error));
        source.pipe(deflate);
        for await (const chunk of deflate) {
          compressed += chunk.length;
          await write(chunk);
        }
      }
      if (!item.directory) {
        if (size >= LIMIT || compressed >= LIMIT) throw new Error(`${item.name} is larger than this writer supports (4 GiB).`);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await write(descriptor);
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      // Made by version 2.0 on Unix (3), so the mode bits below are read.
      record.writeUInt16LE((3 << 8) | 20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(flags, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(crc >>> 0, 16);
      record.writeUInt32LE(compressed, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      const mode = item.directory ? 0o40755 : (item.info.mode & 0o111 ? 0o100755 : 0o100644);
      record.writeUInt32LE(((mode << 16) | (item.directory ? 0x10 : 0)) >>> 0, 38);
      record.writeUInt32LE(start, 42);
      central.push(Buffer.concat([record, name]));
    }
    const directoryStart = offset;
    const directory = Buffer.concat(central);
    await write(directory);
    if (offset >= LIMIT) throw new Error("The archive is larger than this writer supports (4 GiB).");
    const zip64 = entries.length > 0xfffe;
    if (zip64) {
      // A ZIP64 end record carries an entry count above 65,534, which the classic record cannot hold.
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(entries.length), 24);
      end64.writeBigUInt64LE(BigInt(entries.length), 32);
      end64.writeBigUInt64LE(BigInt(directory.length), 40);
      end64.writeBigUInt64LE(BigInt(directoryStart), 48);
      const end64Start = offset;
      await write(end64);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(end64Start), 8);
      locator.writeUInt32LE(1, 16);
      await write(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(directoryStart, 16);
    await write(end);
    await flush();
  } catch (error) {
    await file.close();
    // A partial archive is not a release file. Remove it so a rerun starts clean.
    await rm(outputFile, { force: true });
    throw error;
  }
  await file.close();
  return entries.length;
}

/** Lists a ZIP's entries from its central directory, and reads each file back. For tests and the release check. */
export async function readZip(zipFile) {
  const data = await readFile(zipFile);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No ZIP end record.");
  let count = data.readUInt16LE(end + 10);
  let start = data.readUInt32LE(end + 16);
  if (count === 0xffff) {
    const locator = end - 20;
    if (data.readUInt32LE(locator) !== 0x07064b50) throw new Error("Missing ZIP64 locator.");
    const end64 = Number(data.readBigUInt64LE(locator + 8));
    count = Number(data.readBigUInt64LE(end64 + 32));
    start = Number(data.readBigUInt64LE(end64 + 48));
  }
  const files = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("Bad central directory record.");
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressed = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extra = data.readUInt16LE(at + 30);
    const comment = data.readUInt16LE(at + 32);
    const offset = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    const localName = data.readUInt16LE(offset + 26);
    const localExtra = data.readUInt16LE(offset + 28);
    const body = data.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + compressed);
    const content = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if ((crc32(content) >>> 0) !== crc) throw new Error(`CRC mismatch for ${name}.`);
    files.push({ name, content });
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
