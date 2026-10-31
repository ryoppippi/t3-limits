# t3-limits

Read usage limits from a running [T3 Code](https://github.com/pingdotgg/t3code)
server:

```sh
nix run github:ryoppippi/t3-limits -- --json
```

See the [setup, authentication, and report guide](docs/guide.md).

This temporary CLI fills the gap while T3 Code has no MCP usage-limits tool.
It will no longer be needed after upstream
[PR #28212](https://github.com/pingdotgg/t3code/pull/28212) merges.
