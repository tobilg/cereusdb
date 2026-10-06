/**
 * Storage backends for persistent databases (`CREATE DATABASE 'opfs://mydb'`).
 *
 * A backend stores the files of persistent databases. Paths are relative to
 * the backend root and use `/` as separator, for example
 * `mydb/manifest.json` or `mydb/segments/1.arrow`.
 */
export interface StorageBackend {
  /** Read a file. Resolves to `null` if it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Create or replace a file. Should replace the file atomically. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Remove a file or directory (recursively). Missing entries are ignored. */
  remove(path: string): Promise<void>;
  /** List entry names of a directory; directory names end with `/`. Missing directories list as empty. */
  list(path: string): Promise<string[]>;
  /** Acquire an exclusive lock (for example across browser tabs). Rejects if it is held elsewhere. */
  lock?(name: string): Promise<void>;
  /** Release a lock acquired with `lock()`. */
  unlock?(name: string): Promise<void>;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

/**
 * Keeps files in memory. Useful for tests, Node.js, and environments without
 * OPFS. Share one instance between CereusDB instances to simulate a reload.
 */
export class MemoryStorageBackend implements StorageBackend {
  private readonly files = new Map<string, Uint8Array>();
  private readonly locks = new Set<string>();

  async readFile(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(splitPath(path).join('/'));
    return data ? data.slice() : null;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(splitPath(path).join('/'), data.slice());
  }

  async remove(path: string): Promise<void> {
    const key = splitPath(path).join('/');
    for (const existing of [...this.files.keys()]) {
      if (key === '' || existing === key || existing.startsWith(`${key}/`)) {
        this.files.delete(existing);
      }
    }
  }

  async list(path: string): Promise<string[]> {
    const prefix = splitPath(path).join('/');
    const entries = new Set<string>();
    for (const key of this.files.keys()) {
      if (prefix !== '' && !key.startsWith(`${prefix}/`)) {
        continue;
      }
      const rest = prefix === '' ? key : key.slice(prefix.length + 1);
      const [head, ...tail] = rest.split('/');
      entries.add(tail.length > 0 ? `${head}/` : head);
    }
    return [...entries].sort();
  }

  async lock(name: string): Promise<void> {
    if (this.locks.has(name)) {
      throw new Error('it is already open in another CereusDB instance');
    }
    this.locks.add(name);
  }

  async unlock(name: string): Promise<void> {
    this.locks.delete(name);
  }

  /** All stored file paths (for inspection and tests). */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

export interface OPFSStorageBackendOptions {
  /** Directory inside the origin private file system. Defaults to `cereusdb`. */
  directory?: string;
}

type SyncAccessHandle = {
  truncate(size: number): void;
  write(data: Uint8Array, options?: { at?: number }): number;
  flush(): void;
  close(): void;
};

/**
 * Stores databases in the Origin Private File System (OPFS). Used for
 * `opfs://` locations by default when the browser supports OPFS.
 *
 * Opening a database takes a Web Lock, so a database can be open in only one
 * tab or worker at a time.
 */
export class OPFSStorageBackend implements StorageBackend {
  private readonly directory: string;
  private rootPromise?: Promise<FileSystemDirectoryHandle>;
  private readonly releases = new Map<string, () => void>();

  constructor(options: OPFSStorageBackendOptions = {}) {
    this.directory = options.directory ?? 'cereusdb';
  }

  /** Whether OPFS is available in the current environment. */
  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function'
    );
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(this.directory, { create: true }));
    return this.rootPromise;
  }

  private async directoryHandle(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    let directory = await this.root();
    for (const segment of segments) {
      try {
        directory = await directory.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    }
    return directory;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const segments = splitPath(path);
    const name = segments.pop();
    if (name === undefined) {
      return null;
    }
    const directory = await this.directoryHandle(segments, false);
    if (directory === null) {
      return null;
    }
    try {
      const file = await (await directory.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const segments = splitPath(path);
    const name = segments.pop();
    if (name === undefined) {
      throw new Error('writeFile requires a file path');
    }
    const directory = await this.directoryHandle(segments, true);
    if (directory === null) {
      throw new Error(`cannot create directory for ${path}`);
    }
    const handle = await directory.getFileHandle(name, { create: true });

    if (typeof handle.createWritable === 'function') {
      // Writes go to a swap file that replaces the original on close().
      const writable = await handle.createWritable();
      try {
        await writable.write(data as Uint8Array<ArrayBuffer>);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      return;
    }

    // Older Safari only supports synchronous access handles (in workers).
    const createSyncAccessHandle = (
      handle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }
    ).createSyncAccessHandle;
    if (typeof createSyncAccessHandle !== 'function') {
      throw new Error('this browser cannot write OPFS files outside a worker');
    }
    const access = await createSyncAccessHandle.call(handle);
    try {
      access.truncate(0);
      access.write(data, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  }

  async remove(path: string): Promise<void> {
    const segments = splitPath(path);
    const name = segments.pop();
    if (name === undefined) {
      throw new Error('remove requires a path');
    }
    const directory = await this.directoryHandle(segments, false);
    if (directory === null) {
      return;
    }
    try {
      await directory.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  async list(path: string): Promise<string[]> {
    const directory = await this.directoryHandle(splitPath(path), false);
    if (directory === null) {
      return [];
    }
    const entries: string[] = [];
    const iterable = directory as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    };
    for await (const [name, handle] of iterable.entries()) {
      entries.push(handle.kind === 'directory' ? `${name}/` : name);
    }
    return entries.sort();
  }

  async lock(name: string): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.locks === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            reject(new Error('it is open in another tab or worker'));
            return undefined;
          }
          resolve();
          // Hold the lock until unlock() resolves this promise.
          return new Promise<void>((release) => this.releases.set(name, release));
        })
        .catch(reject);
    });
  }

  async unlock(name: string): Promise<void> {
    const release = this.releases.get(name);
    this.releases.delete(name);
    release?.();
  }
}
