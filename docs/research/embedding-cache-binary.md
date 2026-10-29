# Exact embedding-cache payload decoding

## Failure and acceptance

The Redis embedding cache used a Float32Array view of the returned Buffer's
backing allocation. That constructor requires a four-byte-aligned byteOffset,
but the locked ioredis RESP parser returns slices at arbitrary offsets. A valid
16-byte bulk reply begins after a five-byte header and silently becomes a cache
miss in the previous implementation. A payload with extra trailing bytes can
instead be silently truncated into a partial vector.

Copy the exact Buffer view into aligned storage before decoding. Reject empty,
non-buffer, non-multiple-of-four and nonfinite payloads as misses. Do not publish
empty or nonfinite Float32 vectors, including finite JS values that overflow
on conversion. Preserve the existing keys, TTL, Float32 representation and
fail-soft Redis behavior.

## Reproduction

Run `node --test tests/unit/embedding-cache*.test.js` after `npm ci`.
The regression uses both synthetic Buffer views and the locked redis-parser
3.0.0 used by ioredis, fed an actual RESP bulk response. No Redis server, model
or external service is required. On main 956b122 the 14 new cases yield 11
failures and 3 passes; with the fix all 24 existing/new cache cases pass.

## Limits

The on-wire native-endian Float32 format is deliberately unchanged. This is not
an endian migration, dimension/model/endpoint attestation, checksum, or general
input schema validator. Finite corrupted values cannot be detected. Existing
set-input coercion remains unchanged. Copying introduces an allocation per cache
hit; no latency/cost improvement has been measured. Live Redis and model calls
are not claimed by the offline tests. No persistence schema, authorization or
embedding-publication concurrency behavior changes.
