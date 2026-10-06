/*
 * MD5, SHA-1 and SHA-256, straight from RFC 1321, RFC 3174 and FIPS 180-4.
 *
 * All three are Merkle–Damgård over 64-byte blocks with the same padding — a
 * 0x80 byte, zeros, then the message length in bits — and differ only in the
 * compression function and in whether that length (and the output words) are
 * little-endian (MD5) or big-endian (the SHAs). So the padding is written once
 * in run_blocks() and each algorithm supplies only its block function.
 */

#include "digest.h"

#include <string.h>

typedef void (*block_fn)(uint32_t *state, const uint8_t *block);

static uint32_t rol(uint32_t x, int n)
{
	return (x << n) | (x >> (32 - n));
}

static uint32_t ror(uint32_t x, int n)
{
	return (x >> n) | (x << (32 - n));
}

static uint32_t load_be(const uint8_t *p)
{
	return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

static uint32_t load_le(const uint8_t *p)
{
	return (uint32_t)p[3] << 24 | (uint32_t)p[2] << 16 | (uint32_t)p[1] << 8 | p[0];
}

/* Feed every whole block, then the padded tail, then write the state out as hex. */
static void run_blocks(uint32_t *state, int words, block_fn block, int big_endian,
                       const uint8_t *data, size_t len, char *hex)
{
	static const char digits[] = "0123456789abcdef";
	uint8_t tail[128];
	size_t whole = len & ~(size_t)63;
	size_t rest = len - whole;

	for (size_t i = 0; i < whole; i += 64) block(state, data + i);

	/* The tail takes two blocks when the length will not fit after the 0x80. */
	size_t tail_len = rest < 56 ? 64 : 128;
	memset(tail, 0, sizeof(tail));
	memcpy(tail, data + whole, rest);
	tail[rest] = 0x80;
	uint64_t bits = (uint64_t)len * 8;
	for (int i = 0; i < 8; i++) {
		int shift = big_endian ? 56 - 8 * i : 8 * i;
		tail[tail_len - 8 + i] = (uint8_t)(bits >> shift);
	}
	block(state, tail);
	if (tail_len == 128) block(state, tail + 64);

	for (int w = 0; w < words; w++) {
		for (int b = 0; b < 4; b++) {
			int shift = big_endian ? 24 - 8 * b : 8 * b;
			uint8_t byte = (uint8_t)(state[w] >> shift);
			*hex++ = digits[byte >> 4];
			*hex++ = digits[byte & 15];
		}
	}
	*hex = '\0';
}

/* ------------------------------------------------------------------------ MD5 */

static void md5_block(uint32_t *s, const uint8_t *p)
{
	static const uint32_t K[64] = {
		0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
		0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
		0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
		0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
		0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
		0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
		0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
		0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
	};
	static const int R[16] = {7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21};
	uint32_t m[16];
	for (int i = 0; i < 16; i++) m[i] = load_le(p + 4 * i);

	uint32_t a = s[0], b = s[1], c = s[2], d = s[3];
	for (int i = 0; i < 64; i++) {
		uint32_t f;
		int g;
		switch (i >> 4) {
		case 0: f = (b & c) | (~b & d); g = i; break;
		case 1: f = (d & b) | (~d & c); g = (5 * i + 1) & 15; break;
		case 2: f = b ^ c ^ d; g = (3 * i + 5) & 15; break;
		default: f = c ^ (b | ~d); g = (7 * i) & 15; break;
		}
		uint32_t t = d;
		d = c;
		c = b;
		b = b + rol(a + f + K[i] + m[g], R[(i >> 4) * 4 + (i & 3)]);
		a = t;
	}
	s[0] += a;
	s[1] += b;
	s[2] += c;
	s[3] += d;
}

void digest_md5(const uint8_t *data, size_t len, char *hex)
{
	uint32_t s[4] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
	run_blocks(s, 4, md5_block, 0, data, len, hex);
}

/* ---------------------------------------------------------------------- SHA-1 */

static void sha1_block(uint32_t *s, const uint8_t *p)
{
	uint32_t w[80];
	for (int i = 0; i < 16; i++) w[i] = load_be(p + 4 * i);
	for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

	uint32_t a = s[0], b = s[1], c = s[2], d = s[3], e = s[4];
	for (int i = 0; i < 80; i++) {
		uint32_t f, k;
		if (i < 20) {
			f = (b & c) | (~b & d);
			k = 0x5a827999;
		} else if (i < 40) {
			f = b ^ c ^ d;
			k = 0x6ed9eba1;
		} else if (i < 60) {
			f = (b & c) | (b & d) | (c & d);
			k = 0x8f1bbcdc;
		} else {
			f = b ^ c ^ d;
			k = 0xca62c1d6;
		}
		uint32_t t = rol(a, 5) + f + e + k + w[i];
		e = d;
		d = c;
		c = rol(b, 30);
		b = a;
		a = t;
	}
	s[0] += a;
	s[1] += b;
	s[2] += c;
	s[3] += d;
	s[4] += e;
}

void digest_sha1(const uint8_t *data, size_t len, char *hex)
{
	uint32_t s[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
	run_blocks(s, 5, sha1_block, 1, data, len, hex);
}

/* -------------------------------------------------------------------- SHA-256 */

static void sha256_block(uint32_t *s, const uint8_t *p)
{
	static const uint32_t K[64] = {
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	};
	uint32_t w[64];
	for (int i = 0; i < 16; i++) w[i] = load_be(p + 4 * i);
	for (int i = 16; i < 64; i++) {
		uint32_t s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
		uint32_t s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}

	uint32_t a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
	for (int i = 0; i < 64; i++) {
		uint32_t t1 = h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
		uint32_t t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
		h = g;
		g = f;
		f = e;
		e = d + t1;
		d = c;
		c = b;
		b = a;
		a = t1 + t2;
	}
	s[0] += a;
	s[1] += b;
	s[2] += c;
	s[3] += d;
	s[4] += e;
	s[5] += f;
	s[6] += g;
	s[7] += h;
}

void digest_sha256(const uint8_t *data, size_t len, char *hex)
{
	uint32_t s[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
	run_blocks(s, 8, sha256_block, 1, data, len, hex);
}
