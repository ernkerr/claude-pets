## gstack (optional — maintainer workflow)

The maintainer uses [gstack](https://github.com/garrytan/gstack) for AI-assisted
work in this repo. **It is not required to contribute** — you can build, test,
and open PRs without it. If you happen to have it installed, the routing and
skills below apply; if not, ignore this section and work normally.

To install it (optional):

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

### Web browsing

If gstack is installed, prefer its `/browse` skill for web browsing.

### Available gstack skills

`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`,
`/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`,
`/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`,
`/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`,
`/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/codex`,
`/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`,
`/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

Use `~/.claude/skills/gstack/...` for gstack file paths (the global path).

## Skill routing (when gstack is installed)

These routing rules apply only if the gstack skills above are available. When the
user's request matches an available skill, invoke it via the Skill tool.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
