# 243: TLS verification failures show Node's message and suggest `--use-system-ca`; a `sslrootcert` with no certificate in it isn't reported

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
The shared server has no TLS, so I put a small TLS-terminating proxy in front of it on `127.0.0.1:54899` (answers the SSLRequest with `S`, does TLS with a self-signed certificate for `CN=localhost` made with `openssl req -x509 ... -subj "/CN=localhost"` as `tls.crt`, and pipes to the server). Then, with target `qa` as `postgresTarget({ env: "QA_DATABASE_URL" })`:

```sh
echo garbage > bad.pem
openssl req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.crt -days 2 -subj "/CN=other"
U=postgres://qa3_fail_deployer:dep@127.0.0.1:54899/qa3_fail_main
QA_DATABASE_URL="$U?sslmode=verify-ca&sslrootcert=$PWD/bad.pem"   pnpm exec super-deploy status --target qa
QA_DATABASE_URL="$U?sslmode=verify-ca&sslrootcert=$PWD/other.crt" pnpm exec super-deploy status --target qa
QA_DATABASE_URL="$U?sslmode=verify-full"                          pnpm exec super-deploy status --target qa
```

## Expected
README, "TLS": with `verify-ca` the server's certificate "must be signed by the CA certificate in the file `sslrootcert` names". When it isn't, the error should say so, naming the `sslrootcert` file. A `sslrootcert` file holding no certificate at all should be refused as such, like a missing or unreadable one (`sslrootcert file ... can't be read: no such file or directory` works well).

## Actual
All three give the same message:

```
Error: The deployment adapter of target qa failed to connect: self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca
```

- With `bad.pem` (not a certificate), nothing says the file is unusable.
- With `other.crt` (the wrong CA), nothing names the `sslrootcert` file or says the server's certificate isn't signed by it.
- The `--use-system-ca` hint is Node's. It doesn't apply when `sslrootcert` is given, and the README doesn't say how to pass a Node flag to `pnpm exec super-deploy`.

The rest worked: `verify-ca` and `verify-full` with the right `tls.crt` connected; `verify-full` to `127.0.0.1` with a cert for `localhost` failed with Node's "Hostname/IP does not match certificate's altnames"; invalid `sslmode` (`Require`, `bogus`), `verify-ca` without `sslrootcert`, and a missing, unreadable or directory `sslrootcert` were all refused clearly.
