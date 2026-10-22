# Timescale database CA

`timescale-ca.pem` is a public CA certificate, used by direct operator and CI
connections to `tsdb.cloud.timescale.com` and its subdomains. It contains no
private key or database credentials. The Worker connects through Hyperdrive.

| Property | Value |
| --- | --- |
| Subject and issuer | `O=Timescale Inc, CN=ca.timescale.com` |
| SHA-256 fingerprint | `06:5A:75:0D:0D:64:F6:2D:AC:DC:97:9E:3B:83:D2:11:95:40:71:EA:59:B8:F3:40:7C:4E:87:CA:68:34:64:57` |
| Valid from | 2025-01-23 15:43:39 UTC |
| Valid until | 2027-10-20 15:43:39 UTC |
| Captured | 2026-10-22 |

The initial certificate was exported from the user-configured Timescale
endpoint using PostgreSQL's credential-free TLS handshake, following the chain
extraction approach in [Tiger Data's SSL guide](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/strict-ssl).
This bootstrap is **trust on first use**: the fingerprint was not independently
authenticated through the provider's control plane. The CA constraint,
self-signature, issuer, and validity were checked, then a second credential-free
connection verified the service certificate and hostname against this CA.

The saved certificate is the trust anchor for subsequent connections, which
enforce `verify-full`. CI never downloads or automatically trusts a replacement
certificate. Routine server-certificate renewal under this CA needs no change.
A different or expired CA fails verification and requires a reviewed pin update.

To inspect the pin:

```sh
openssl x509 -in apps/api/certs/timescale-ca.pem -noout -subject -issuer -dates -fingerprint -sha256
```

For a CA rotation, export the new chain using the provider's documented
procedure, review its provenance and SHA-256 fingerprint, and verify the service
hostname using the new CA. Update the PEM, fingerprint above, and regression
test together. `DATABASE_CA_FILE` (local) and `DATABASE_CA_PEM` (CI) provide
explicit overrides for another CA. Keep certificate verification enabled.
