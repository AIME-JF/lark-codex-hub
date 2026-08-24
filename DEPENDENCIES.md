# Runtime dependencies

- `@larksuiteoapi/node-sdk`: official Feishu/Lark Node.js SDK, MIT license.
- `better-sqlite3`: SQLite binding for Node.js, MIT license.
- `zod`: runtime schema validation, MIT license.

Development dependencies and their transitive licenses are recorded by `package-lock.json`. Release builds should run `npm audit` and generate an SBOM with `npm sbom --sbom-format cyclonedx`.
