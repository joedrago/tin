#!/bin/sh
# The half of tinjs's behaviour that cannot be tested from inside a script:
# exit codes, the limits, and what lands on stderr. $1 is the tinjs binary.
set -u

TINJS="${1:?usage: cli.sh /path/to/tinjs}"
HERE=$(dirname "$0")
pass=0
fail=0

check() {
	name=$1
	expected_status=$2
	expected_out=$3
	shift 3
	actual_out=$("$@" 2>/tmp/tinjs-cli-err)
	actual_status=$?
	if [ "$actual_status" != "$expected_status" ]; then
		echo "FAIL $name: exit $actual_status, wanted $expected_status"
		fail=$((fail + 1))
	elif [ "$actual_out" != "$expected_out" ]; then
		echo "FAIL $name: stdout [$actual_out], wanted [$expected_out]"
		fail=$((fail + 1))
	else
		pass=$((pass + 1))
	fi
}

# stderr has to contain a given string, and stdout is not checked.
check_err() {
	name=$1
	expected_status=$2
	needle=$3
	shift 3
	"$@" >/dev/null 2>/tmp/tinjs-cli-err
	actual_status=$?
	if [ "$actual_status" != "$expected_status" ]; then
		echo "FAIL $name: exit $actual_status, wanted $expected_status"
		fail=$((fail + 1))
	elif ! grep -q "$needle" /tmp/tinjs-cli-err; then
		echo "FAIL $name: stderr lacks [$needle]: $(cat /tmp/tinjs-cli-err)"
		fail=$((fail + 1))
	else
		pass=$((pass + 1))
	fi
}

check "eval prints"          0 "2"       "$TINJS" -e 'print(1 + 1)'
check "console.log"          0 "hi"      "$TINJS" -e 'console.log("hi")'
check "exit code"            3 ""        "$TINJS" -e 'exit(3)'
check "exit after output"    2 "before"  "$TINJS" -e 'print("before"); exit(2)'
check "args after -e"        0 "a,b,c"   "$TINJS" -e 'print(args.join(","))' a b c
check "args are not options" 0 "-e,--x"  "$TINJS" -e 'print(args.join(","))' -e --x
check "script file"          0 "42"      "$TINJS" "$HERE/fixtures/answer.js"
check "args after script"    0 "x,y"     "$TINJS" "$HERE/fixtures/echo-args.js" x y
check "shebang is skipped"   0 "shebang" "$TINJS" "$HERE/fixtures/shebang.js"
check "stderr is not stdout" 0 ""        "$TINJS" -e 'console.error("to stderr")'

# console.error really does reach stderr rather than vanishing.
check_err "console.error"    0 "to stderr" "$TINJS" -e 'console.error("to stderr")'

# Failures: an uncaught throw, a syntax error, and a bad option are distinct.
check_err "uncaught throw"   1 "boom"        "$TINJS" -e 'throw new Error("boom")'
check_err "stack trace"      1 "at <eval>"   "$TINJS" -e 'throw new Error("boom")'
check_err "syntax error"     1 "SyntaxError" "$TINJS" -e 'function ('
check_err "unknown option"   2 "unknown option" "$TINJS" --nope -e 'print(1)'
check_err "missing file"     1 "cannot read" "$TINJS" /no/such/script.js
check_err "rejected promise" 1 "unhandled"   "$TINJS" -e 'Promise.reject(new Error("unhandled"))'

# The limits are off unless asked for, and still work when they are asked for.
check "no memory limit by default" 0 "400" "$TINJS" -e 'print(new ArrayBuffer(400 * 1024 * 1024).byteLength >> 20)'

check_err "timeout stops a loop" 1 "timeout" "$TINJS" --timeout 1 -e 'for (;;) {}'
check_err "memory limit"         1 "memory"  "$TINJS" --memory 16 -e 'const a = []; for (;;) a.push(new Array(100000).fill(7));'

# Reading works; writing does not exist to be tried.
check "read a fixture"  0 "4" "$TINJS" -e 'print(JSON.parse(read(args[0])).length)' "$HERE/fixtures/people.json"
check "stdin"           0 "piped" sh -c "echo piped | '$TINJS' -e 'print(readStdin().trim())'"
check "closed stdin"    0 "0"     sh -c "'$TINJS' -e 'print(readStdin().length)' </dev/null"

echo "cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
