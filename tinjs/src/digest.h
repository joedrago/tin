/*
 * MD5, SHA-1 and SHA-256 over one buffer, written out as lowercase hex.
 *
 * Pure computation: no state survives a call, nothing is allocated, and
 * nothing outside the two buffers is touched. `hex` needs room for twice the
 * digest size plus a NUL — 33, 41 and 65 bytes respectively.
 */
#ifndef TINJS_DIGEST_H
#define TINJS_DIGEST_H

#include <stddef.h>
#include <stdint.h>

void digest_md5(const uint8_t *data, size_t len, char *hex);
void digest_sha1(const uint8_t *data, size_t len, char *hex);
void digest_sha256(const uint8_t *data, size_t len, char *hex);

#endif
