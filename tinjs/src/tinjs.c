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
 * stdout, write to stderr, read a file as text, read a file as bytes, walk a file
 * a line at a time, and exit. There is deliberately no counterpart that creates
 * or modifies a file, opens a socket, starts a process or reads the environment —
 * and none can be reached by another route, because there is no other route to
 * reach. stdout is the only way data leaves a tinjs run.
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

#include "quickjs.h"

#ifdef _WIN32
#	include <windows.h>
#	include <fcntl.h>
#	include <io.h>
#else
#	include <time.h>
#	include <unistd.h>
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

static JSValue js_read_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "readBytes() needs a path");

	size_t len;
	char *buf = slurp_path(ctx, argv[0], &len);
	if (!buf) return JS_EXCEPTION;

	JSValue out = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)buf, len);
	free(buf);
	return out;
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

typedef struct {
	FILE *f; /* NULL once closed, which is also how end-of-file is remembered */
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

/* Read one line into lr->line, without its terminator. Returns 1 on a line, 0 at
 * end of file, -1 on error with *err set. */
static int line_reader_next(JSContext *ctx, LineReader *lr, size_t *out_len, const char **err)
{
	size_t len = 0;

	if (!lr->f) return 0;

	for (;;) {
		if (lr->chunk_pos == lr->chunk_len) {
			lr->chunk_len = fread(lr->chunk, 1, TINJS_LINE_CHUNK, lr->f);
			lr->chunk_pos = 0;
			if (lr->chunk_len == 0) {
				if (ferror(lr->f)) {
					*err = strerror(errno);
					return -1;
				}
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
	JS_SetPropertyStr(ctx, tin, "readBytes", JS_NewCFunction(ctx, js_read_bytes, "readBytes", 1));
	JS_SetPropertyStr(ctx, tin, "openLines", JS_NewCFunction(ctx, js_open_lines, "openLines", 1));
	JS_SetPropertyStr(ctx, tin, "nextLine", JS_NewCFunction(ctx, js_next_line, "nextLine", 1));
	JS_SetPropertyStr(ctx, tin, "closeLines", JS_NewCFunction(ctx, js_close_lines, "closeLines", 1));
	JS_SetPropertyStr(ctx, tin, "exit", JS_NewCFunction(ctx, js_exit, "exit", 1));

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
	        "  lines(path)        iterate the file a line at a time\n"
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
