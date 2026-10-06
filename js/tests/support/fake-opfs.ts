/**
 * Minimal in-memory implementation of the OPFS APIs used by
 * OPFSStorageBackend (navigator.storage.getDirectory and navigator.locks),
 * so the backend can be exercised in Node.
 */

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError');
}

class FakeFileHandle {
  readonly kind = 'file';
  data = new Uint8Array();

  constructor(readonly name: string) {}

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const data = this.data.slice();
    return { arrayBuffer: async () => data.buffer };
  }

  async createWritable() {
    let pending = new Uint8Array();
    return {
      write: async (data: Uint8Array) => {
        pending = new Uint8Array(data);
      },
      close: async () => {
        this.data = pending;
      },
      abort: async () => undefined,
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) {
      return existing;
    }
    if (existing) {
      throw new DOMException(`${name} is a file`, 'TypeMismatchError');
    }
    if (!options.create) {
      throw notFound(name);
    }
    const directory = new FakeDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) {
      return existing;
    }
    if (existing) {
      throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
    }
    if (!options.create) {
      throw notFound(name);
    }
    const file = new FakeFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}) {
    const existing = this.children.get(name);
    if (!existing) {
      throw notFound(name);
    }
    if (existing instanceof FakeDirectoryHandle && existing.children.size > 0 && !options.recursive) {
      throw new DOMException(`${name} is not empty`, 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.children) {
      yield entry;
    }
  }
}

export interface FakeOPFS {
  root: FakeDirectoryHandle;
  navigator: {
    storage: { getDirectory(): Promise<FakeDirectoryHandle> };
    locks: {
      request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: { name: string } | null) => unknown,
      ): Promise<unknown>;
    };
  };
  /** Paths of all files below the OPFS root. */
  paths(): string[];
}

export function createFakeOPFS(): FakeOPFS {
  const root = new FakeDirectoryHandle('');
  const held = new Set<string>();

  const navigator = {
    storage: { getDirectory: async () => root },
    locks: {
      async request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: { name: string } | null) => unknown,
      ) {
        if (held.has(name)) {
          if (options.ifAvailable) {
            return await callback(null);
          }
          throw new Error('fake locks only support ifAvailable');
        }
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  };

  const paths = (): string[] => {
    const result: string[] = [];
    const walk = (directory: FakeDirectoryHandle, prefix: string) => {
      for (const [name, child] of directory.children) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child instanceof FakeDirectoryHandle) {
          walk(child, path);
        } else {
          result.push(path);
        }
      }
    };
    walk(root, '');
    return result.sort();
  };

  return { root, navigator, paths };
}
