/*
 * tinjs — a JavaScript interpreter with nothing in it that can write.
 *
 * The engine is quickjs-ng, built from the vendored copy in ../quickjs with its
 * libc module left out of the build entirely. That module — quickjs-libc.c, the
 * `std` and `os` bindings — is where quickjs keeps open(), write(), exec(),
 * getenv() and the rest; it is an optional file, it is not compiled here, and
 * nothing in the engine proper reaches the machine without it. ECMAScript itself
 * has no I/O, so what is left after leaving it out is a language and no way down.
 *
 * On top of that this file adds a short, fixed list of hooks and stops: write to
 * stdout, write to stderr, read a file as text, read a file as bytes (whole or a
 * slice by offset and length), stat a path, list a directory, read a symlink,
 * walk a file a line at a time (gzipped or not), and exit. Beside those are a
 * few that only compute — deflate, inflate, checksums, hashes and UTF-8 — which
 * take a buffer, return a buffer, and touch nothing else.
 *
 * There is deliberately no counterpart that creates or modifies a file,
 * opens a socket, starts a process or reads the environment — and none can be
 * reached by another route, because there is no other route to reach. stdout is
 * the only way data leaves a tinjs run.
 *
 * Everything friendlier than those hooks is in prelude.js, which the build turns
 * into prelude.h and which runs before the user's script.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "quickjs.h"
#include "miniz.h"
#include "digest.h"

#ifdef _WIN32
#	include <windows.h>
#	include <fcntl.h>
#	include <io.h>
#else
#	include <dirent.h>
#	include <time.h>
#	include <unistd.h>
#endif

/* MSVC's <sys/stat.h> has no S_ISDIR/S_ISREG; MinGW's already does, so this is
 * only filled in where it is actually missing. */
#ifndef S_ISDIR
#	define S_ISDIR(m) (((m) & _S_IFMT) == _S_IFDIR)
#endif
#ifndef S_ISREG
#	define S_ISREG(m) (((m) & _S_IFMT) == _S_IFREG)
#endif

#include "prelude.h"

#define TINJS_VERSION "0.1.0"

/* The memory and time limits are off for now, pending a decision about whether a
 * default belongs here at all: under tin, exec.timeoutMs is already the outer
 * bound on any command, and a second, shorter one that only tinjs has is a thing
 * to be sure about before imposing it. Everything that enforces them is still
 * here and still reachable with --memory and --timeout; what is commented out is
 * only the choice to apply them unasked.
 *
 * #define TINJS_DEFAULT_MEMORY_MB 256
 * #define TINJS_DEFAULT_TIMEOUT_S 60
 */
#define TINJS_DEFAULT_MEMORY_MB 0
#define TINJS_DEFAULT_TIMEOUT_S 0

/* The stack limit is not one of the pair above and stays on: the useful range is
 * bounded by the real thread stack underneath it, and without it deep recursion
 * runs off the end of that rather than raising a RangeError. */
#define TINJS_STACK_BYTES ((size_t)2 << 20)

/* Refuse to slurp a file larger than this. The JS heap limit does not cover a
 * malloc made out here, so a read of /dev/zero would otherwise be unbounded. */
#define TINJS_MAX_READ ((size_t)512 << 20)

static uint64_t now_ms(void)
{
#ifdef _WIN32
	return (uint64_t)GetTickCount64();
#else
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
#endif
}

typedef struct {
	uint64_t deadline_ms; /* 0 when no timeout was asked for */
	long limit_s;
	unsigned countdown;
	int fired;
} Deadline;

/*
 * Stop a script that is never going to finish.
 *
 * quickjs calls this from the interpreter loop, often enough that reading the
 * clock every time would show up in a profile, so the clock is only consulted
 * once every few thousand calls. The flag is what tells the reporter afterwards
 * that the InternalError quickjs raises here was a timeout and not the script's
 * own doing.
 */
static int on_interrupt(JSRuntime *rt, void *opaque)
{
	Deadline *dl = opaque;
	(void)rt;
	if (dl->deadline_ms == 0) return 0;
	if (dl->countdown > 0) {
		dl->countdown--;
		return 0;
	}
	dl->countdown = 8000;
	if (now_ms() < dl->deadline_ms) return 0;
	dl->fired = 1;
	return 1;
}

/*
 * Read a stream to the end.
 *
 * Growing a buffer rather than trusting a stat lets this work on the things that
 * have no size to report — pipes, /proc entries, a closed stdin — which is most
 * of what gets read in practice.
 */
static char *slurp(FILE *f, size_t *out_len, const char **err)
{
	size_t cap = 1 << 16, len = 0;
	char *buf = malloc(cap);
	if (!buf) {
		*err = "out of memory";
		return NULL;
	}
	for (;;) {
		if (len == cap) {
			if (cap >= TINJS_MAX_READ) {
				free(buf);
				*err = "file is too large to read";
				return NULL;
			}
			char *grown = realloc(buf, cap * 2);
			if (!grown) {
				free(buf);
				*err = "out of memory";
				return NULL;
			}
			buf = grown;
			cap *= 2;
		}
		size_t n = fread(buf + len, 1, cap - len, f);
		len += n;
		if (n == 0) {
			if (ferror(f)) {
				free(buf);
				*err = strerror(errno);
				return NULL;
			}
			break;
		}
	}
	*out_len = len;
	return buf;
}

/* Open and slurp a path named by a JS argument, throwing on the JS side if it
 * cannot be done. Returns malloc'd bytes the caller owns, or NULL with an
 * exception already pending. */
static char *slurp_path(JSContext *ctx, JSValueConst arg, size_t *out_len)
{
	const char *path = JS_ToCString(ctx, arg);
	if (!path) return NULL;

	FILE *f = fopen(path, "rb");
	if (!f) {
		JS_ThrowInternalError(ctx, "cannot read %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return NULL;
	}

	const char *err = NULL;
	char *buf = slurp(f, out_len, &err);
	fclose(f);
	if (!buf) JS_ThrowInternalError(ctx, "cannot read %s: %s", path, err);
	JS_FreeCString(ctx, path);
	return buf;
}

/* magic: 0 writes to stdout, 1 to stderr. */
static JSValue js_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	(void)this_val;
	if (argc < 1) return JS_UNDEFINED;

	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
	if (!s) return JS_EXCEPTION;

	fwrite(s, 1, len, magic ? stderr : stdout);
	JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue js_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "read() needs a path");

	size_t len;
	char *buf = slurp_path(ctx, argv[0], &len);
	if (!buf) return JS_EXCEPTION;

	JSValue out = JS_NewStringLen(ctx, buf, len);
	free(buf);
	return out;
}

/*
 * readBytes(path) reads the whole file, same as before. readBytes(path, offset)
 * reads from offset to the end, and readBytes(path, offset, length) reads at
 * most length bytes from there — short of length at EOF is not an error, the
 * same way a short fread() is not one. This is the point of the offset form:
 * pulling one header or one record out of a file too large to slurp does not
 * have to pay for the rest of it.
 */
static JSValue js_read_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "readBytes() needs a path");

	bool has_offset = argc >= 2 && !JS_IsUndefined(argv[1]);
	bool has_length = argc >= 3 && !JS_IsUndefined(argv[2]);

	int64_t offset = 0, length = 0;
	if (has_offset) {
		if (JS_ToInt64(ctx, &offset, argv[1])) return JS_EXCEPTION;
		if (offset < 0) return JS_ThrowRangeError(ctx, "readBytes() offset must not be negative");
	}
	if (has_length) {
		if (JS_ToInt64(ctx, &length, argv[2])) return JS_EXCEPTION;
		if (length < 0) return JS_ThrowRangeError(ctx, "readBytes() length must not be negative");
		if ((uint64_t)length > TINJS_MAX_READ)
			return JS_ThrowInternalError(ctx, "readBytes() length is too large to read");
	}

	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	FILE *f = fopen(path, "rb");
	if (!f) {
		JS_ThrowInternalError(ctx, "cannot read %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	if (has_offset) {
#ifdef _WIN32
		int seek_r = _fseeki64(f, offset, SEEK_SET);
#else
		int seek_r = fseeko(f, (off_t)offset, SEEK_SET);
#endif
		if (seek_r != 0) {
			JS_ThrowInternalError(ctx, "cannot read %s: %s", path, strerror(errno));
			JS_FreeCString(ctx, path);
			fclose(f);
			return JS_EXCEPTION;
		}
	}

	char *buf;
	size_t len;
	const char *err = NULL;

	if (has_length) {
		buf = malloc((size_t)length > 0 ? (size_t)length : 1);
		if (!buf) {
			err = "out of memory";
			len = 0;
		} else {
			len = fread(buf, 1, (size_t)length, f);
			if (len < (size_t)length && ferror(f)) err = strerror(errno);
		}
	} else {
		buf = slurp(f, &len, &err);
	}
	fclose(f);

	if (err) {
		JS_ThrowInternalError(ctx, "cannot read %s: %s", path, err);
		JS_FreeCString(ctx, path);
		free(buf);
		return JS_EXCEPTION;
	}

	JS_FreeCString(ctx, path);
	JSValue out = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)buf, len);
	free(buf);
	return out;
}

/* size, modtime, and what kind of thing a path is — the three questions a
 * script needs answered before it decides how (or whether) to read something,
 * without having to attempt the read first to find out. */
#ifdef _WIN32
typedef struct __stat64 tinjs_stat_t;
#	define tinjs_stat _stat64
#else
typedef struct stat tinjs_stat_t;
#	define tinjs_stat stat
#endif

/* Whether the path itself is a symlink, as opposed to what it points at. On
 * Windows any reparse point counts, which takes in junctions as well. */
static bool is_symlink(const char *path)
{
#ifdef _WIN32
	DWORD attrs = GetFileAttributesA(path);
	return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT);
#else
	struct stat st;
	return lstat(path, &st) == 0 && S_ISLNK(st.st_mode);
#endif
}

static JSValue js_stat(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "stat() needs a path");

	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	tinjs_stat_t st;
	if (tinjs_stat(path, &st) != 0) {
		JS_ThrowInternalError(ctx, "cannot stat %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	bool link = is_symlink(path);
	JS_FreeCString(ctx, path);

	JSValue out = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, out, "size", JS_NewInt64(ctx, (int64_t)st.st_size));
	JS_SetPropertyStr(ctx, out, "mtimeMs", JS_NewFloat64(ctx, (double)st.st_mtime * 1000.0));
	JS_SetPropertyStr(ctx, out, "isDirectory", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
	JS_SetPropertyStr(ctx, out, "isFile", JS_NewBool(ctx, S_ISREG(st.st_mode)));
	JS_SetPropertyStr(ctx, out, "isSymlink", JS_NewBool(ctx, link));
	return out;
}

/* One directory entry as readdir() hands it back: its name, and the same three
 * kind flags stat() gives, so a script walking a tree does not have to stat
 * every entry a second time to know whether to descend. isFile and isDirectory
 * describe what a link points at; a link that points at nothing is neither. */
static JSValue dir_entry(JSContext *ctx, const char *dir, const char *name)
{
	size_t dlen = strlen(dir), nlen = strlen(name);
	char *full = malloc(dlen + nlen + 2);
	if (!full) return JS_ThrowOutOfMemory(ctx);
	memcpy(full, dir, dlen);
	full[dlen] = '/';
	memcpy(full + dlen + 1, name, nlen + 1);

	tinjs_stat_t st;
	bool ok = tinjs_stat(full, &st) == 0;
	bool link = is_symlink(full);
	free(full);

	JSValue e = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, e, "name", JS_NewString(ctx, name));
	JS_SetPropertyStr(ctx, e, "isDirectory", JS_NewBool(ctx, ok && S_ISDIR(st.st_mode)));
	JS_SetPropertyStr(ctx, e, "isFile", JS_NewBool(ctx, ok && S_ISREG(st.st_mode)));
	JS_SetPropertyStr(ctx, e, "isSymlink", JS_NewBool(ctx, link));
	return e;
}

/* The entries of one directory, minus "." and "..", in whatever order the
 * filesystem gives them; prelude.js sorts them. */
static JSValue js_readdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "readdir() needs a path");

	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	JSValue out = JS_NewArray(ctx);
	uint32_t n = 0;

#ifdef _WIN32
	size_t plen = strlen(path);
	char *pattern = malloc(plen + 3);
	if (!pattern) {
		JS_FreeCString(ctx, path);
		JS_FreeValue(ctx, out);
		return JS_ThrowOutOfMemory(ctx);
	}
	memcpy(pattern, path, plen);
	memcpy(pattern + plen, "\\*", 3);
	WIN32_FIND_DATAA fd;
	HANDLE h = FindFirstFileA(pattern, &fd);
	free(pattern);
	if (h == INVALID_HANDLE_VALUE) {
		JS_ThrowInternalError(ctx, "cannot list %s: error %lu", path, (unsigned long)GetLastError());
		JS_FreeCString(ctx, path);
		JS_FreeValue(ctx, out);
		return JS_EXCEPTION;
	}
	do {
		if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
		JS_SetPropertyUint32(ctx, out, n++, dir_entry(ctx, path, fd.cFileName));
	} while (FindNextFileA(h, &fd));
	FindClose(h);
#else
	DIR *d = opendir(path);
	if (!d) {
		JS_ThrowInternalError(ctx, "cannot list %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		JS_FreeValue(ctx, out);
		return JS_EXCEPTION;
	}
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (!strcmp(ent->d_name, ".") || !strcmp(ent->d_name, "..")) continue;
		JS_SetPropertyUint32(ctx, out, n++, dir_entry(ctx, path, ent->d_name));
	}
	closedir(d);
#endif

	JS_FreeCString(ctx, path);
	return out;
}

/* Where a symlink points, as written in the link — not resolved, and possibly
 * relative to the directory the link is in. */
static JSValue js_readlink(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "readlink() needs a path");

#ifdef _WIN32
	return JS_ThrowInternalError(ctx, "readlink() is not supported on Windows");
#else
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	char buf[4096];
	ssize_t len = readlink(path, buf, sizeof(buf));
	if (len < 0) {
		JS_ThrowInternalError(ctx, "cannot readlink %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	JS_FreeCString(ctx, path);
	if ((size_t)len == sizeof(buf)) return JS_ThrowInternalError(ctx, "symlink target is too long");
	return JS_NewStringLen(ctx, buf, (size_t)len);
#endif
}

/* ------------------------------------------------------------- pure functions
 *
 * Everything from here to the line reader takes a Uint8Array (or a string) and
 * returns a new value computed from it. None of it opens, names or touches
 * anything outside the buffers it is handed. prelude.js turns strings and other
 * views into a Uint8Array before calling, so these only have to accept one. */

static uint8_t *bytes_arg(JSContext *ctx, JSValueConst v, size_t *len, const char *who)
{
	uint8_t *p = JS_GetUint8Array(ctx, len, v);
	if (!p) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		JS_ThrowTypeError(ctx, "%s() needs a Uint8Array", who);
	}
	return p;
}

/* magic: 0 MD5, 1 SHA-1, 2 SHA-256. The result is lowercase hex. */
static JSValue js_digest(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	static const char *names[] = {"md5", "sha1", "sha256"};
	(void)this_val;
	size_t len;
	uint8_t *p = bytes_arg(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &len, names[magic]);
	if (!p) return JS_EXCEPTION;

	char hex[65];
	if (magic == 0) digest_md5(p, len, hex);
	else if (magic == 1) digest_sha1(p, len, hex);
	else digest_sha256(p, len, hex);
	return JS_NewString(ctx, hex);
}

/* magic: 0 CRC-32, 1 Adler-32. */
static JSValue js_checksum(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	(void)this_val;
	size_t len;
	uint8_t *p = bytes_arg(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &len, magic ? "adler32" : "crc32");
	if (!p) return JS_EXCEPTION;
	mz_ulong sum = magic ? mz_adler32(MZ_ADLER32_INIT, p, len) : mz_crc32(MZ_CRC32_INIT, p, len);
	return JS_NewInt64(ctx, (int64_t)(uint32_t)sum);
}

static JSValue js_utf8_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, argc > 0 ? argv[0] : JS_UNDEFINED);
	if (!s) return JS_EXCEPTION;
	JSValue out = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)s, len);
	JS_FreeCString(ctx, s);
	return out;
}

static JSValue js_utf8_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	size_t len;
	uint8_t *p = bytes_arg(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &len, "decode");
	if (!p) return JS_EXCEPTION;
	return JS_NewStringLen(ctx, (const char *)p, len);
}

/* deflate(bytes, level, zlib): a raw deflate stream, or with zlib set the same
 * stream inside a zlib header and Adler-32 trailer. gzip's wrapper is built in
 * prelude.js out of this and crc32. */
static JSValue js_deflate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	size_t len;
	uint8_t *p = bytes_arg(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &len, "deflate");
	if (!p) return JS_EXCEPTION;

	int32_t level = MZ_DEFAULT_LEVEL;
	if (argc > 1 && JS_ToInt32(ctx, &level, argv[1])) return JS_EXCEPTION;
	if (level < 0 || level > 9) return JS_ThrowRangeError(ctx, "deflate() level must be 0 to 9");
	bool zlib = argc > 2 && JS_ToBool(ctx, argv[2]);

	int flags = (int)tdefl_create_comp_flags_from_zip_params(level, zlib ? 15 : -15, MZ_DEFAULT_STRATEGY);
	size_t out_len = 0;
	void *out = tdefl_compress_mem_to_heap(p, len, &out_len, flags);
	if (!out) return JS_ThrowInternalError(ctx, "deflate() failed");
	JSValue v = JS_NewUint8ArrayCopy(ctx, out, out_len);
	mz_free(out);
	return v;
}

/*
 * inflate(bytes, zlib): the inverse, returning [output, bytes consumed].
 *
 * The consumed count is what lets gunzip in prelude.js find the trailer after
 * the stream and the next member after that. The output grows by doubling and
 * stops at TINJS_MAX_READ, the same ceiling read() has, so a small file that
 * claims to expand to terabytes is an error rather than an allocation.
 */
static JSValue js_inflate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	size_t len;
	uint8_t *p = bytes_arg(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &len, "inflate");
	if (!p) return JS_EXCEPTION;
	bool zlib = argc > 1 && JS_ToBool(ctx, argv[1]);

	tinfl_decompressor *inf = malloc(sizeof(*inf));
	size_t cap = len * 4 > 4096 ? len * 4 : 4096;
	if (cap > TINJS_MAX_READ) cap = TINJS_MAX_READ;
	uint8_t *out = malloc(cap);
	if (!inf || !out) {
		free(inf);
		free(out);
		return JS_ThrowOutOfMemory(ctx);
	}
	tinfl_init(inf);

	const char *err = NULL;
	size_t in_pos = 0, out_len = 0;
	int flags = TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF | (zlib ? TINFL_FLAG_PARSE_ZLIB_HEADER : 0);
	for (;;) {
		size_t in_n = len - in_pos, out_n = cap - out_len;
		tinfl_status status = tinfl_decompress(inf, p + in_pos, &in_n, out, out + out_len, &out_n, flags);
		in_pos += in_n;
		out_len += out_n;
		if (status == TINFL_STATUS_DONE) break;
		if (status != TINFL_STATUS_HAS_MORE_OUTPUT) {
			err = status == TINFL_STATUS_ADLER32_MISMATCH ? "checksum mismatch" : "data is corrupt or truncated";
			break;
		}
		if (cap >= TINJS_MAX_READ) {
			err = "output is too large";
			break;
		}
		size_t grown_cap = cap * 2 > TINJS_MAX_READ ? TINJS_MAX_READ : cap * 2;
		uint8_t *grown = realloc(out, grown_cap);
		if (!grown) {
			err = "out of memory";
			break;
		}
		out = grown;
		cap = grown_cap;
	}
	free(inf);

	if (err) {
		free(out);
		return JS_ThrowInternalError(ctx, "inflate() failed: %s", err);
	}
	JSValue pair = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, pair, 0, JS_NewUint8ArrayCopy(ctx, out, out_len));
	JS_SetPropertyUint32(ctx, pair, 1, JS_NewInt64(ctx, (int64_t)in_pos));
	free(out);
	return pair;
}

/*
 * An open file being read one line at a time.
 *
 * read() answers "give me this file"; a log too large to hold answers to nothing
 * until there is a way to walk it, and this is that way. It is the only host
 * object tinjs hands out, and it is deliberately opaque: no seek, no mode, no
 * descriptor to recover, and nothing on it but "read one more line" and "close".
 * The iterator a script actually sees is built around it in prelude.js.
 *
 * `chunk` is the raw window read from the file; `line` is the line being
 * assembled out of one or more of those windows. Scanning the window with memchr
 * rather than taking a byte at a time is what makes a million-line file a moment
 * of work rather than a minute of it.
 */
#define TINJS_LINE_CHUNK ((size_t)64 << 10)
#define TINJS_LINE_START ((size_t)4 << 10)

/*
 * A gzip file being inflated on the way into the window.
 *
 * A file that starts with gzip's magic bytes is read through this instead of
 * directly, so lines("access.log.1.gz") is the same loop as on the plain log.
 * `in` is compressed bytes from the file; `dict` is miniz's 32KB circular
 * history, which each step of output lands in before being copied to the
 * window. Concatenated members — which is what `cat a.gz b.gz` makes, and what
 * gzip itself reads as one file — are followed one after another, and each
 * member's CRC-32 and length are checked against its trailer.
 */
#define TINJS_GZ_IN ((size_t)64 << 10)

typedef struct {
	tinfl_decompressor inf;
	uint8_t in[TINJS_GZ_IN];
	size_t in_pos, in_len;
	bool in_eof;
	uint8_t dict[TINFL_LZ_DICT_SIZE];
	size_t dict_ofs;
	mz_ulong crc;
	uint32_t size;
	bool in_member; /* false between members, where a header is expected next */
} GzipStream;

typedef struct {
	FILE *f; /* NULL once closed, which is also how end-of-file is remembered */
	GzipStream *gz; /* NULL for a file that is not gzipped */
	char *line;
	size_t line_cap;
	char *chunk;
	size_t chunk_len; /* bytes in the window */
	size_t chunk_pos; /* how far through the window we are */
} LineReader;

static JSClassID tinjs_line_reader_class_id;

static void line_reader_close(LineReader *lr)
{
	if (lr->f) {
		fclose(lr->f);
		lr->f = NULL;
	}
}

static void line_reader_finalizer(JSRuntime *rt, JSValueConst val)
{
	LineReader *lr = JS_GetOpaque(val, tinjs_line_reader_class_id);
	if (!lr) return;
	line_reader_close(lr);
	js_free_rt(rt, lr->gz);
	js_free_rt(rt, lr->line);
	js_free_rt(rt, lr->chunk);
	js_free_rt(rt, lr);
}

static const JSClassDef tinjs_line_reader_class = {
	.class_name = "LineReader",
	.finalizer = line_reader_finalizer,
};

/*
 * Make room for `need` bytes in the line being assembled.
 *
 * The ceiling is the one read() uses. A "line" that long is a file with no
 * newlines in it, which is exactly the case read() already refuses, and the two
 * should fail at the same place rather than at two numbers nobody can keep
 * straight.
 */
static int line_reader_reserve(JSContext *ctx, LineReader *lr, size_t need, const char **err)
{
	if (need <= lr->line_cap) return 0;
	if (need > TINJS_MAX_READ) {
		*err = "line is too long to read";
		return -1;
	}
	size_t cap = lr->line_cap;
	while (cap < need) cap *= 2;
	if (cap > TINJS_MAX_READ) cap = TINJS_MAX_READ;

	char *grown = js_realloc(ctx, lr->line, cap);
	if (!grown) {
		*err = "out of memory";
		return -1;
	}
	lr->line = grown;
	lr->line_cap = cap;
	return 0;
}

/* Move what is left of the input to the front and top it up from the file. */
static int gz_refill(LineReader *lr, const char **err)
{
	GzipStream *gz = lr->gz;
	if (gz->in_eof) return 0;
	size_t left = gz->in_len - gz->in_pos;
	memmove(gz->in, gz->in + gz->in_pos, left);
	gz->in_pos = 0;
	gz->in_len = left;
	size_t n = fread(gz->in + left, 1, TINJS_GZ_IN - left, lr->f);
	gz->in_len += n;
	if (n == 0) {
		if (ferror(lr->f)) {
			*err = strerror(errno);
			return -1;
		}
		gz->in_eof = true;
	}
	return 0;
}

/* One byte of input, or -1 at end of file (or on error, with *err set). */
static int gz_byte(LineReader *lr, const char **err)
{
	GzipStream *gz = lr->gz;
	if (gz->in_pos == gz->in_len) {
		if (gz_refill(lr, err) != 0 || gz->in_pos == gz->in_len) return -1;
	}
	return gz->in[gz->in_pos++];
}

/* Read a member header (RFC 1952, section 2.3). Returns 1 when a member starts,
 * 0 when the file is over, -1 on error. Anything after the last member that is
 * not another header is ignored, the way gzip -d treats trailing garbage. */
static int gz_header(LineReader *lr, const char **err)
{
	int b0 = gz_byte(lr, err);
	if (b0 < 0) return *err ? -1 : 0;
	int b1 = gz_byte(lr, err);
	if (b0 != 0x1f || b1 != 0x8b) return *err ? -1 : 0;

	int fixed[8];
	for (int i = 0; i < 8; i++) fixed[i] = gz_byte(lr, err);
	int method = fixed[0], flags = fixed[1];
	if (fixed[7] < 0) goto truncated;
	if (method != 8) {
		*err = "not a deflate gzip member";
		return -1;
	}
	if (flags & 4) { /* FEXTRA */
		int lo = gz_byte(lr, err), hi = gz_byte(lr, err);
		if (hi < 0) goto truncated;
		for (int n = lo | hi << 8; n > 0; n--)
			if (gz_byte(lr, err) < 0) goto truncated;
	}
	for (int bit = 8; bit <= 16; bit <<= 1) { /* FNAME, then FCOMMENT */
		if (!(flags & bit)) continue;
		int c;
		while ((c = gz_byte(lr, err)) > 0) {}
		if (c < 0) goto truncated;
	}
	if (flags & 2) { /* FHCRC */
		gz_byte(lr, err);
		if (gz_byte(lr, err) < 0) goto truncated;
	}

	GzipStream *gz = lr->gz;
	tinfl_init(&gz->inf);
	gz->dict_ofs = 0;
	gz->crc = MZ_CRC32_INIT;
	gz->size = 0;
	gz->in_member = true;
	return 1;

truncated:
	if (!*err) *err = "gzip data is truncated";
	return -1;
}

/* Fill the window with the next stretch of inflated bytes. Returns the count,
 * 0 when every member is done, -1 on error. */
static long gz_fill(LineReader *lr, const char **err)
{
	GzipStream *gz = lr->gz;
	for (;;) {
		if (!gz->in_member) {
			int r = gz_header(lr, err);
			if (r <= 0) return r;
		}

		if (gz->in_pos == gz->in_len && gz_refill(lr, err) != 0) return -1;
		size_t in_n = gz->in_len - gz->in_pos;
		size_t out_n = TINFL_LZ_DICT_SIZE - gz->dict_ofs;
		int flags = gz->in_eof ? 0 : TINFL_FLAG_HAS_MORE_INPUT;
		tinfl_status status = tinfl_decompress(&gz->inf, gz->in + gz->in_pos, &in_n, gz->dict,
		                                       gz->dict + gz->dict_ofs, &out_n, flags);
		gz->in_pos += in_n;

		if (out_n > 0) {
			memcpy(lr->chunk, gz->dict + gz->dict_ofs, out_n);
			gz->crc = mz_crc32(gz->crc, gz->dict + gz->dict_ofs, out_n);
			gz->size += (uint32_t)out_n;
			gz->dict_ofs = (gz->dict_ofs + out_n) & (TINFL_LZ_DICT_SIZE - 1);
		}

		if (status == TINFL_STATUS_DONE) {
			uint32_t want_crc = 0, want_size = 0;
			for (int i = 0; i < 8; i++) {
				int b = gz_byte(lr, err);
				if (b < 0) {
					if (!*err) *err = "gzip data is truncated";
					return -1;
				}
				if (i < 4) want_crc |= (uint32_t)b << (8 * i);
				else want_size |= (uint32_t)b << (8 * (i - 4));
			}
			if (want_crc != (uint32_t)gz->crc || want_size != gz->size) {
				*err = "gzip checksum mismatch";
				return -1;
			}
			gz->in_member = false;
		} else if (status == TINFL_STATUS_NEEDS_MORE_INPUT) {
			if (gz->in_eof) {
				*err = "gzip data is truncated";
				return -1;
			}
			if (gz_refill(lr, err) != 0) return -1;
		} else if (status < 0) {
			*err = status == TINFL_STATUS_FAILED_CANNOT_MAKE_PROGRESS ? "gzip data is truncated"
			                                                          : "gzip data is corrupt";
			return -1;
		}

		if (out_n > 0) return (long)out_n;
	}
}

/* Refill the window from the file, inflating on the way if it is gzipped. */
static long line_reader_fill(LineReader *lr, const char **err)
{
	if (lr->gz) return gz_fill(lr, err);
	size_t n = fread(lr->chunk, 1, TINJS_LINE_CHUNK, lr->f);
	if (n == 0 && ferror(lr->f)) {
		*err = strerror(errno);
		return -1;
	}
	return (long)n;
}

/* Read one line into lr->line, without its terminator. Returns 1 on a line, 0 at
 * end of file, -1 on error with *err set. */
static int line_reader_next(JSContext *ctx, LineReader *lr, size_t *out_len, const char **err)
{
	size_t len = 0;

	if (!lr->f) return 0;

	for (;;) {
		if (lr->chunk_pos == lr->chunk_len) {
			long n = line_reader_fill(lr, err);
			if (n < 0) return -1;
			lr->chunk_len = (size_t)n;
			lr->chunk_pos = 0;
			if (lr->chunk_len == 0) {
				/* A last line with no newline after it is still a line. */
				line_reader_close(lr);
				if (len == 0) return 0;
				break;
			}
		}

		char *from = lr->chunk + lr->chunk_pos;
		size_t avail = lr->chunk_len - lr->chunk_pos;
		char *nl = memchr(from, '\n', avail);
		size_t take = nl ? (size_t)(nl - from) : avail;

		if (take > 0) {
			if (line_reader_reserve(ctx, lr, len + take, err) != 0) return -1;
			memcpy(lr->line + len, from, take);
			len += take;
		}
		lr->chunk_pos += nl ? take + 1 : take;

		if (nl) break;
	}

	/* A file with CRLF endings reads the same as one with LF endings. */
	if (len > 0 && lr->line[len - 1] == '\r') len--;
	*out_len = len;
	return 1;
}

static JSValue js_open_lines(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "lines() needs a path");

	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	FILE *f = fopen(path, "rb");
	if (!f) {
		JS_ThrowInternalError(ctx, "cannot read %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	JS_FreeCString(ctx, path);

	LineReader *lr = js_mallocz(ctx, sizeof(*lr));
	if (!lr) {
		fclose(f);
		return JS_EXCEPTION;
	}
	lr->chunk = js_malloc(ctx, TINJS_LINE_CHUNK);
	lr->line = js_malloc(ctx, TINJS_LINE_START);
	if (!lr->chunk || !lr->line) {
		fclose(f);
		js_free(ctx, lr->chunk);
		js_free(ctx, lr->line);
		js_free(ctx, lr);
		return JS_EXCEPTION;
	}
	lr->line_cap = TINJS_LINE_START;
	lr->f = f;

	/* Peek at the first window: gzip's magic bytes mean everything goes through
	 * the inflater, and the bytes already read become its first input. */
	lr->chunk_len = fread(lr->chunk, 1, TINJS_LINE_CHUNK, f);
	if (lr->chunk_len >= 2 && (uint8_t)lr->chunk[0] == 0x1f && (uint8_t)lr->chunk[1] == 0x8b) {
		lr->gz = js_mallocz(ctx, sizeof(*lr->gz));
		if (!lr->gz) {
			fclose(f);
			js_free(ctx, lr->chunk);
			js_free(ctx, lr->line);
			js_free(ctx, lr);
			return JS_EXCEPTION;
		}
		/* The window is bigger than the input buffer, so the peek is split:
		 * what fits goes to the inflater, and the file is rewound to just after
		 * it so nothing is skipped. */
		size_t take = lr->chunk_len < TINJS_GZ_IN ? lr->chunk_len : TINJS_GZ_IN;
		memcpy(lr->gz->in, lr->chunk, take);
		lr->gz->in_len = take;
		if (take < lr->chunk_len) fseek(f, (long)take, SEEK_SET);
		lr->chunk_len = 0;
	}

	JSValue obj = JS_NewObjectClass(ctx, tinjs_line_reader_class_id);
	if (JS_IsException(obj)) {
		fclose(f);
		js_free(ctx, lr->chunk);
		js_free(ctx, lr->line);
		js_free(ctx, lr);
		return obj;
	}
	JS_SetOpaque(obj, lr);
	return obj;
}

static JSValue js_next_line(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "nextLine() needs a reader");

	LineReader *lr = JS_GetOpaque2(ctx, argv[0], tinjs_line_reader_class_id);
	if (!lr) return JS_EXCEPTION;

	size_t len = 0;
	const char *err = NULL;
	int r = line_reader_next(ctx, lr, &len, &err);
	if (r < 0) {
		line_reader_close(lr);
		return JS_ThrowInternalError(ctx, "cannot read a line: %s", err);
	}
	if (r == 0) return JS_NULL;
	return JS_NewStringLen(ctx, lr->line, len);
}

static JSValue js_close_lines(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_UNDEFINED;

	LineReader *lr = JS_GetOpaque2(ctx, argv[0], tinjs_line_reader_class_id);
	if (!lr) return JS_EXCEPTION;
	line_reader_close(lr);
	return JS_UNDEFINED;
}

static JSValue js_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	int32_t code = 0;
	if (argc > 0) JS_ToInt32(ctx, &code, argv[0]);
	fflush(stdout);
	exit((int)code);
	return JS_UNDEFINED; /* not reached */
}

/*
 * Build a context out of named intrinsics rather than calling JS_NewContext.
 *
 * The list is the same one JS_NewContext uses, and it is written out here for
 * the same reason the libc module is left out of the build: what a script can
 * see should be a decision somebody made on purpose, visible in one place, and
 * not a default that a later engine bump could quietly widen. None of these
 * reach outside the interpreter — they are Date, RegExp, JSON, Map/Set, typed
 * arrays, promises and the base objects.
 */
static JSContext *new_context(JSRuntime *rt)
{
	JSContext *ctx = JS_NewContextRaw(rt);
	if (!ctx) return NULL;

	if (JS_AddIntrinsicBaseObjects(ctx) || JS_AddIntrinsicDate(ctx) || JS_AddIntrinsicEval(ctx) ||
	    JS_AddIntrinsicRegExp(ctx) || JS_AddIntrinsicJSON(ctx) || JS_AddIntrinsicProxy(ctx) ||
	    JS_AddIntrinsicMapSet(ctx) || JS_AddIntrinsicTypedArrays(ctx) ||
	    JS_AddIntrinsicPromise(ctx) || JS_AddIntrinsicWeakRef(ctx) ||
	    JS_AddIntrinsicDOMException(ctx) || JS_AddIntrinsicAToB(ctx) || JS_AddPerformance(ctx)) {
		JS_FreeContext(ctx);
		return NULL;
	}
	return ctx;
}

/* Install the hooks as globalThis.__tin, where prelude.js picks them up and then
 * deletes the property. */
static int install_hooks(JSContext *ctx, int argc, char **argv)
{
	JSValue global = JS_GetGlobalObject(ctx);
	JSValue tin = JS_NewObject(ctx);

	JS_SetPropertyStr(ctx, tin, "write",
	                  JS_NewCFunctionMagic(ctx, js_write, "write", 1, JS_CFUNC_generic_magic, 0));
	JS_SetPropertyStr(ctx, tin, "writeErr",
	                  JS_NewCFunctionMagic(ctx, js_write, "writeErr", 1, JS_CFUNC_generic_magic, 1));
	JS_SetPropertyStr(ctx, tin, "read", JS_NewCFunction(ctx, js_read, "read", 1));
	JS_SetPropertyStr(ctx, tin, "readBytes", JS_NewCFunction(ctx, js_read_bytes, "readBytes", 3));
	JS_SetPropertyStr(ctx, tin, "stat", JS_NewCFunction(ctx, js_stat, "stat", 1));
	JS_SetPropertyStr(ctx, tin, "readdir", JS_NewCFunction(ctx, js_readdir, "readdir", 1));
	JS_SetPropertyStr(ctx, tin, "readlink", JS_NewCFunction(ctx, js_readlink, "readlink", 1));
	JS_SetPropertyStr(ctx, tin, "openLines", JS_NewCFunction(ctx, js_open_lines, "openLines", 1));
	JS_SetPropertyStr(ctx, tin, "nextLine", JS_NewCFunction(ctx, js_next_line, "nextLine", 1));
	JS_SetPropertyStr(ctx, tin, "closeLines", JS_NewCFunction(ctx, js_close_lines, "closeLines", 1));
	JS_SetPropertyStr(ctx, tin, "exit", JS_NewCFunction(ctx, js_exit, "exit", 1));

	// The pure ones: a buffer in, a value out, and nothing else touched.
	JS_SetPropertyStr(ctx, tin, "md5",
	                  JS_NewCFunctionMagic(ctx, js_digest, "md5", 1, JS_CFUNC_generic_magic, 0));
	JS_SetPropertyStr(ctx, tin, "sha1",
	                  JS_NewCFunctionMagic(ctx, js_digest, "sha1", 1, JS_CFUNC_generic_magic, 1));
	JS_SetPropertyStr(ctx, tin, "sha256",
	                  JS_NewCFunctionMagic(ctx, js_digest, "sha256", 1, JS_CFUNC_generic_magic, 2));
	JS_SetPropertyStr(ctx, tin, "crc32",
	                  JS_NewCFunctionMagic(ctx, js_checksum, "crc32", 1, JS_CFUNC_generic_magic, 0));
	JS_SetPropertyStr(ctx, tin, "adler32",
	                  JS_NewCFunctionMagic(ctx, js_checksum, "adler32", 1, JS_CFUNC_generic_magic, 1));
	JS_SetPropertyStr(ctx, tin, "utf8Encode", JS_NewCFunction(ctx, js_utf8_encode, "utf8Encode", 1));
	JS_SetPropertyStr(ctx, tin, "utf8Decode", JS_NewCFunction(ctx, js_utf8_decode, "utf8Decode", 1));
	JS_SetPropertyStr(ctx, tin, "deflate", JS_NewCFunction(ctx, js_deflate, "deflate", 3));
	JS_SetPropertyStr(ctx, tin, "inflate", JS_NewCFunction(ctx, js_inflate, "inflate", 2));

	JSValue args = JS_NewArray(ctx);
	for (int i = 0; i < argc; i++)
		JS_SetPropertyUint32(ctx, args, (uint32_t)i, JS_NewString(ctx, argv[i]));
	JS_SetPropertyStr(ctx, tin, "args", args);

	JS_SetPropertyStr(ctx, global, "__tin", tin);
	JS_FreeValue(ctx, global);
	return 0;
}

/* Print a thrown value the way a person reads it: the message, then the stack if
 * the value carries one. `prefix` names what went wrong. */
static void print_error_value(JSContext *ctx, JSValueConst v, const char *prefix)
{
	const char *msg = JS_ToCString(ctx, v);
	fprintf(stderr, "tinjs: %s%s\n", prefix, msg ? msg : "(no message)");
	if (msg) JS_FreeCString(ctx, msg);

	if (!JS_IsError(v)) return;

	JSValue stack = JS_GetPropertyStr(ctx, v, "stack");
	if (!JS_IsUndefined(stack) && !JS_IsNull(stack)) {
		const char *s = JS_ToCString(ctx, stack);
		if (s && *s) {
			fputs(s, stderr);
			if (s[strlen(s) - 1] != '\n') fputc('\n', stderr);
		}
		if (s) JS_FreeCString(ctx, s);
	}
	JS_FreeValue(ctx, stack);
}

static void print_exception(JSContext *ctx, const Deadline *dl)
{
	JSValue exc = JS_GetException(ctx);

	if (dl->fired) {
		fprintf(stderr, "tinjs: stopped after %ld seconds (--timeout)\n", dl->limit_s);
		JS_FreeValue(ctx, exc);
		return;
	}

	print_error_value(ctx, exc, "");
	JS_FreeValue(ctx, exc);
}

typedef struct {
	JSValue reason; /* the first one still outstanding, JS_UNDEFINED if none */
	int count;
} Rejection;

/*
 * Notice a promise that was rejected with nothing to catch it.
 *
 * Without this a script whose only work happens in an async function that throws
 * exits 0 having printed nothing, which is the worst way for a script to fail.
 * quickjs calls this again with is_handled set when a catch turns up later — an
 * await installs its handler a tick after the rejection — so the count has to be
 * allowed to come back down rather than treated as final on the first call.
 */
static void on_promise_rejection(JSContext *ctx, JSValueConst promise, JSValueConst reason,
                                 bool is_handled, void *opaque)
{
	Rejection *r = opaque;
	(void)promise;

	if (is_handled) {
		if (r->count > 0) r->count--;
		if (r->count == 0) {
			JS_FreeValue(ctx, r->reason);
			r->reason = JS_UNDEFINED;
		}
		return;
	}

	if (r->count == 0) r->reason = JS_DupValue(ctx, reason);
	r->count++;
}

/* Run everything the script queued — a resolved promise, an async function that
 * ran off the end of the script. Returns -1 with an exception pending. */
static int drain_jobs(JSRuntime *rt, JSContext **pctx)
{
	for (;;) {
		JSContext *job_ctx;
		int r = JS_ExecutePendingJob(rt, &job_ctx);
		if (r == 0) return 0;
		if (r < 0) {
			*pctx = job_ctx;
			return -1;
		}
	}
}

static void usage(FILE *out)
{
	fprintf(out,
	        "tinjs " TINJS_VERSION " — JavaScript that cannot write anything\n"
	        "\n"
	        "usage:\n"
	        "  tinjs [options] <script.js> [args...]\n"
	        "  tinjs [options] -e <code> [args...]\n"
	        "\n"
	        "options:\n"
	        "  -e, --eval CODE    run CODE instead of a file\n"
	        "      --memory MB    heap limit; off unless asked for\n"
	        "      --timeout SEC  wall-clock limit; off unless asked for\n"
	        "  -h, --help\n"
	        "  -v, --version\n"
	        "\n"
	        "in the script:\n"
	        "  read(path)         file contents as a string\n"
	        "  readBytes(path)    file contents as a Uint8Array\n"
	        "  readBytes(path, offset, length)\n"
	        "                     length bytes starting at offset, not the whole file\n"
	        "  stat(path)         { size, mtime, isDirectory, isFile, isSymlink }\n"
	        "  readdir(path)      [{ name, isDirectory, isFile, isSymlink }], sorted\n"
	        "  walk(path)         every entry below path, recursively, as { path, ... }\n"
	        "  readlink(path)     where a symlink points\n"
	        "  lines(path)        iterate the file a line at a time (.gz too)\n"
	        "  deflate/inflate, deflateRaw/inflateRaw, gzip/gunzip\n"
	        "                     compress and decompress bytes or strings\n"
	        "  crc32, adler32     checksums, as numbers\n"
	        "  md5, sha1, sha256  hashes, as hex strings\n"
	        "  TextEncoder, TextDecoder\n"
	        "                     utf-8 (and utf-16le/be, latin1 to decode)\n"
	        "  print(...)         a line on stdout; console.log is the same thing\n"
	        "  console.error(...) a line on stderr\n"
	        "  inspect(value)     the string print would have produced\n"
	        "  args               arguments after the script, as an array\n"
	        "  exit(code)         stop now\n"
	        "\n"
	        "Standard JavaScript is all present: RegExp, JSON, Map, Set, typed arrays,\n"
	        "Date, Math, promises, generators, classes, destructuring. There is no way\n"
	        "to write a file, open a socket, run a program or read the environment, and\n"
	        "no modules — one script, no imports, no require.\n");
}

static int parse_number(const char *s, long *out)
{
	char *end;
	errno = 0;
	long v = strtol(s, &end, 10);
	if (errno != 0 || end == s || *end != '\0' || v < 0) return -1;
	*out = v;
	return 0;
}

int main(int argc, char **argv)
{
	const char *eval_code = NULL;
	const char *script_path = NULL;
	long memory_mb = TINJS_DEFAULT_MEMORY_MB;
	long timeout_s = TINJS_DEFAULT_TIMEOUT_S;
	int i = 1;

	for (; i < argc; i++) {
		const char *a = argv[i];
		if (a[0] != '-' || a[1] == '\0') break;
		if (!strcmp(a, "--")) {
			i++;
			break;
		}
		if (!strcmp(a, "-h") || !strcmp(a, "--help")) {
			usage(stdout);
			return 0;
		}
		if (!strcmp(a, "-v") || !strcmp(a, "--version")) {
			printf("tinjs " TINJS_VERSION " (quickjs-ng %d.%d.%d)\n", QJS_VERSION_MAJOR,
			       QJS_VERSION_MINOR, QJS_VERSION_PATCH);
			return 0;
		}
		if (!strcmp(a, "-e") || !strcmp(a, "--eval")) {
			if (++i >= argc) {
				fprintf(stderr, "tinjs: %s needs code after it\n", a);
				return 2;
			}
			eval_code = argv[i++];
			break; /* everything left belongs to the script */
		}
		if (!strcmp(a, "--memory") || !strcmp(a, "--timeout")) {
			int is_memory = a[2] == 'm';
			if (++i >= argc || parse_number(argv[i], is_memory ? &memory_mb : &timeout_s) != 0) {
				fprintf(stderr, "tinjs: %s needs a whole number of %s\n", a,
				        is_memory ? "megabytes" : "seconds");
				return 2;
			}
			continue;
		}
		fprintf(stderr, "tinjs: unknown option %s (try --help)\n", a);
		return 2;
	}

	char *file_source = NULL;
	const char *source;
	size_t source_len;
	const char *name;

	if (eval_code) {
		source = eval_code;
		source_len = strlen(eval_code);
		name = "<eval>";
	} else {
		if (i >= argc) {
			usage(stderr);
			return 2;
		}
		script_path = argv[i++];
		FILE *f = fopen(script_path, "rb");
		if (!f) {
			fprintf(stderr, "tinjs: cannot read %s: %s\n", script_path, strerror(errno));
			return 1;
		}
		const char *err = NULL;
		file_source = slurp(f, &source_len, &err);
		fclose(f);
		if (!file_source) {
			fprintf(stderr, "tinjs: cannot read %s: %s\n", script_path, err);
			return 1;
		}
		// A leading #! is not JavaScript. Blanking the two characters rather than
		// skipping the line keeps every offset after it where it was, so the line
		// numbers in a stack trace still match the file on disk.
		if (source_len >= 2 && file_source[0] == '#' && file_source[1] == '!') {
			file_source[0] = '/';
			file_source[1] = '/';
		}
		source = file_source;
		name = script_path;
	}

#ifdef _WIN32
	// Hand stdout the bytes the script asked for, rather than a copy with every
	// \n turned into \r\n on the way past.
	_setmode(_fileno(stdout), _O_BINARY);
	_setmode(_fileno(stderr), _O_BINARY);
#endif

	JSRuntime *rt = JS_NewRuntime();
	if (!rt) {
		fprintf(stderr, "tinjs: cannot start the interpreter\n");
		free(file_source);
		return 1;
	}

	Deadline dl = {0, timeout_s, 0, 0};
	if (timeout_s > 0) dl.deadline_ms = now_ms() + (uint64_t)timeout_s * 1000u;
	JS_SetInterruptHandler(rt, on_interrupt, &dl);

	Rejection rejection = {JS_UNDEFINED, 0};
	JS_SetHostPromiseRejectionTracker(rt, on_promise_rejection, &rejection);
	JS_SetMaxStackSize(rt, TINJS_STACK_BYTES);
	if (memory_mb > 0) JS_SetMemoryLimit(rt, (size_t)memory_mb << 20);

	JS_NewClassID(rt, &tinjs_line_reader_class_id);
	if (JS_NewClass(rt, tinjs_line_reader_class_id, &tinjs_line_reader_class) < 0) {
		fprintf(stderr, "tinjs: cannot start the interpreter\n");
		JS_FreeRuntime(rt);
		free(file_source);
		return 1;
	}

	JSContext *ctx = new_context(rt);
	if (!ctx) {
		fprintf(stderr, "tinjs: cannot start the interpreter\n");
		JS_FreeRuntime(rt);
		free(file_source);
		return 1;
	}

	install_hooks(ctx, argc - i, argv + i);

	int status = 0;
	JSValue result = JS_Eval(ctx, (const char *)tinjs_prelude, sizeof(tinjs_prelude) - 1,
	                         "<prelude>", JS_EVAL_TYPE_GLOBAL);
	if (JS_IsException(result)) {
		print_exception(ctx, &dl);
		status = 1;
	}
	JS_FreeValue(ctx, result);

	if (status == 0) {
		result = JS_Eval(ctx, source, source_len, name, JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(result)) {
			print_exception(ctx, &dl);
			status = 1;
		}
		JS_FreeValue(ctx, result);
	}

	if (status == 0) {
		JSContext *job_ctx = ctx;
		if (drain_jobs(rt, &job_ctx) < 0) {
			print_exception(job_ctx, &dl);
			status = 1;
		}
	}

	if (status == 0 && rejection.count > 0) {
		print_error_value(ctx, rejection.reason, "unhandled promise rejection: ");
		status = 1;
	}
	JS_FreeValue(ctx, rejection.reason);

	fflush(stdout);
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);
	free(file_source);
	return status;
}
