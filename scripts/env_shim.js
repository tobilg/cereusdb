// Emscripten runtime shim for wasm32-unknown-unknown builds with C/C++ deps.

let _memory = null;
const _caughtCxaExceptions = [];
const UNSUPPORTED_ERRNO = -38;

export function setMemory(mem) {
  _memory = mem;
}

function getDataView() {
  return _memory ? new DataView(_memory.buffer) : null;
}

function writeU32(ptr, value) {
  const view = getDataView();
  if (view && ptr) {
    view.setUint32(ptr, value >>> 0, true);
  }
}

function writeU64(ptr, value) {
  const view = getDataView();
  if (view && ptr) {
    view.setBigUint64(ptr, BigInt(value), true);
  }
}

function createCppException(ptr, type, destructor, message = "C++ exception") {
  const error = new WebAssembly.RuntimeError(message);
  error.__cxa_exception_ptr = ptr >>> 0;
  error.__cxa_type = type >>> 0;
  error.__cxa_destructor = destructor >>> 0;
  return error;
}

export function createEnvImports() {
  const longjmpTag = typeof WebAssembly.Tag === "function"
    ? new WebAssembly.Tag({ parameters: ["i32"] })
    : null;

  return {
    emscripten_resize_heap: (requestedSize) => {
      if (!_memory) {
        console.error("[env_shim] emscripten_resize_heap called but no memory set");
        return 0;
      }
      try {
        const oldBytes = _memory.buffer.byteLength;
        if (requestedSize <= oldBytes) return 1;
        const pagesToGrow = Math.ceil((requestedSize - oldBytes) / 65536);
        _memory.grow(pagesToGrow);
        return 1;
      } catch(e) {
        console.error("[env_shim] memory.grow failed:", e);
        return 0;
      }
    },
    emscripten_get_heap_max: () => 2147483648,

    // Minimal C++ EH shims. These are enough to satisfy instantiation and
    // propagate exceptions back to JS on paths that actually throw.
    _Unwind_CallPersonality: () => 0,
    __cxa_begin_catch: (ptr) => {
      const value = ptr >>> 0;
      _caughtCxaExceptions.push(value);
      return value;
    },
    __cxa_end_catch: () => {
      _caughtCxaExceptions.pop();
    },
    __cxa_throw: (ptr, type, destructor) => {
      throw createCppException(ptr, type, destructor);
    },
    __cxa_rethrow: () => {
      const ptr = _caughtCxaExceptions.length
        ? _caughtCxaExceptions[_caughtCxaExceptions.length - 1]
        : 0;
      throw createCppException(ptr, 0, 0, "C++ exception rethrown");
    },
    __c_longjmp: longjmpTag,

    emscripten_date_now: () => Date.now(),
    emscripten_get_now: () => performance.now(),
    _localtime_js: () => {},
    _tzset_js: () => {},

    __syscall_openat: () => UNSUPPORTED_ERRNO,
    __syscall_fcntl64: () => UNSUPPORTED_ERRNO,
    __syscall_ioctl: () => UNSUPPORTED_ERRNO,
    __syscall_fstat64: () => UNSUPPORTED_ERRNO,
    __syscall_stat64: () => UNSUPPORTED_ERRNO,
    __syscall_lstat64: () => UNSUPPORTED_ERRNO,
    __syscall_newfstatat: () => UNSUPPORTED_ERRNO,
    __syscall_getcwd: () => UNSUPPORTED_ERRNO,
    __syscall_mkdirat: () => UNSUPPORTED_ERRNO,
    __syscall_rmdir: () => UNSUPPORTED_ERRNO,
    __syscall_unlinkat: () => UNSUPPORTED_ERRNO,
    __syscall_renameat: () => UNSUPPORTED_ERRNO,
    __syscall_readlinkat: () => UNSUPPORTED_ERRNO,
    __syscall_getdents64: () => UNSUPPORTED_ERRNO,
    __syscall_statfs64: () => UNSUPPORTED_ERRNO,
    __syscall_faccessat: () => UNSUPPORTED_ERRNO,
    __syscall_chmod: () => UNSUPPORTED_ERRNO,
    __syscall_fchmod: () => UNSUPPORTED_ERRNO,
    __syscall_fchown32: () => UNSUPPORTED_ERRNO,
    __syscall_fdatasync: () => 0,
    __syscall_ftruncate64: () => UNSUPPORTED_ERRNO,
    __syscall_prlimit64: () => UNSUPPORTED_ERRNO,
    __syscall_dup3: () => UNSUPPORTED_ERRNO,
    __syscall_pipe: () => UNSUPPORTED_ERRNO,
    __syscall_wait4: () => UNSUPPORTED_ERRNO,
    __syscall_getuid32: () => 0,
    __syscall_geteuid32: () => 0,
    __syscall_getgid32: () => 0,
    __syscall_getegid32: () => 0,
    __syscall_utimensat: () => UNSUPPORTED_ERRNO,

    emscripten_errn: () => 0,
    emscripten_stack_snapshot: () => 0,
    emscripten_stack_unwind_buffer: () => 0,
    emscripten_asm_const_int: () => 0,
    HaveOffsetConverter: () => 0,
    emscripten_pc_get_function: () => 0,

    malloc_usable_size: () => 0,
    _mmap_js: () => -1,
    _munmap_js: () => -1,
    __wasm_longjmp: () => {
      throw new WebAssembly.RuntimeError("longjmp is not supported in the browser runtime");
    },
    dlopen: () => 0,
    __dlsym: () => 0,
    vfork: () => -1,
    fork: () => -1,
    execve: () => -1,

    _abort_js: () => { console.warn("[env_shim] abort called (ignored)"); },
    exit: (code) => { console.warn(`exit(${code})`); },
  };
}

export function createWasiImports() {
  return {
    fd_close: () => 0,
    fd_write: (_fd, _iovs, _iovcnt, pnum) => {
      writeU32(pnum, 0);
      return 0;
    },
    fd_read: (_fd, _iovs, _iovcnt, pnum) => {
      writeU32(pnum, 0);
      return 0;
    },
    fd_pwrite: (_fd, _iovs, _iovcnt, _offset, pnum) => {
      writeU32(pnum, 0);
      return 0;
    },
    fd_pread: (_fd, _iovs, _iovcnt, _offset, pnum) => {
      writeU32(pnum, 0);
      return 0;
    },
    fd_seek: (_fd, _offset, _whence, newOffset) => {
      writeU64(newOffset, 0);
      return 0;
    },
    fd_sync: () => 0,
    fd_fdstat_get: () => 0,
    clock_res_get: (_clockId, resolutionPtr) => {
      writeU64(resolutionPtr, 1_000_000);
      return 0;
    },
    clock_time_get: (clockId, _precision, timePtr) => {
      const nowNs = clockId === 1
        ? Math.floor(performance.now() * 1_000_000)
        : Date.now() * 1_000_000;
      writeU64(timePtr, nowNs);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (countPtr, sizePtr) => {
      writeU32(countPtr, 0);
      writeU32(sizePtr, 0);
      return 0;
    },
    proc_exit: (code) => {
      throw new WebAssembly.RuntimeError(`proc_exit(${code})`);
    },
    random_get: (buf, len) => {
      if (!_memory) return -1;
      const bytes = new Uint8Array(_memory.buffer, buf, len);
      crypto.getRandomValues(bytes);
      return 0;
    },
  };
}
