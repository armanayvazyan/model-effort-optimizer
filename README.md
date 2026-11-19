# model-effort-optimizer

A Claude Code mod that routes every prompt to the **model** and **effort level** it actually needs.

Before your prompt's first request leaves, a small Haiku call classifies it and picks:

| Model  | Typical work |
| ------ | ------------ |
| Haiku  | lookups, one-liners, renames, formatting, shell one-offs |
| Sonnet | routine coding, edits in a few files, tests, docs, clear-error debugging |
| Opus   | design decisions, unclear bugs, wide refactors, security, concurrency |
| Fable  | the rare hardest case: long unattended builds, deep research, many-tradeoff design |

…and an effort level from `low` to `max`. Approvals and continuations ("ok", "go on") keep the current route.

## Modes

- **ask** (default): when the pick differs from what you're on, a dialog asks before Claude starts: use it once, use it and stop asking, or keep current.
- **auto**: reroutes on its own, no dialog.
- **off**: does nothing.

After a reroute, a line above the prompt shows `⇢ Routed to Opus · high from Sonnet · medium` with an **Undo** button, and the footer shows the active route.

## Commands

```
/model-effort-optimizer          status
/model-effort-optimizer ask      ask before rerouting
/model-effort-optimizer auto     reroute automatically
/model-effort-optimizer off      disable
/model-effort-optimizer reset    unpin; follow your model/effort pickers again
```

## How it works

The route is applied per request inside the session. **Nothing in your settings changes**: your default model stays as is. The app's model and effort menus keep showing your own choice (a chat can't move them), so the footer label is the source of truth. Changing either menu yourself hands control back to you. Subagents are left alone.

**Cost note:** switching models means the next request can't reuse the previous model's prompt cache, so frequent switches cost more. The classifier itself is one short Haiku call per prompt.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install model-effort-optimizer --marketplace armanayvazyan/model-effort-optimizer
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install model-effort-optimizer --marketplace armanayvazyan/model-effort-optimizer
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `armanayvazyan/model-effort-optimizer` → **Add plugin**.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
