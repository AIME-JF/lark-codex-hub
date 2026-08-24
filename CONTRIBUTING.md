# Contributing

Contributions should preserve the port-and-adapter boundary and fail-closed security defaults.

Before opening a pull request:

```bash
npm install
npm run check
```

Do not add raw shell execution, raw `lark-cli` passthrough, plaintext credential storage, or a second definition of an existing contract. Add new Feishu actions to the central discriminated schema and map them in the action broker.

Tests must use synthetic data. Never commit real Feishu IDs, tokens, message history, or workstation paths.
