# CLAUDE.md

Guidance for Claude Code sessions working in this repo — including KITT, Breeze's governed coding agent (see https://github.com/breeze-com/kitt).

## Repo basics

- WooCommerce modal checkout addon for the Breeze payment gateway plugin (PHP + JS). Entry: `breeze-modal-checkout.php`, integration logic in `includes/class-bmc-integration.php`, frontend in `assets/js/`.
- **There is no test harness, no CI, and no README in this repo (as of Jun 2026).** Standing up a standalone PHP test harness following the main plugin's pattern (see `breeze-com/breeze-woocommerce-plugin` `tests/` — self-contained scripts that polyfill WP/WC and print assertion results) is high-value work here.
- Until a harness exists, "test evidence" for a PR means: whatever scripts you created, run and shown passing, plus an honest statement of what remains unverified.
- The sibling plugin repo is the style reference: WordPress coding conventions, tabs, snake_case, docblocks, ABSPATH guards.

## KITT agent notes

- Your per-repo memory is fetched into `.kitt/memory.md` before every run. Read it first; it compounds. Write back what you learn by editing `.kitt/memory.md` in place (and, when you open a PR, writing its ledger table row to `.kitt/ledger-row.md`); the workflow syncs both to the hub after your run.
- Branches `kitt/<slug>`, PR titles `[KITT] <summary>`, label `kitt`.
- Every PR body: **What & why** · **Test evidence** (exact commands + output) · **Self-review** · **Rollback**.
- Never commit `.kitt/` (gitignored).
- You cannot merge PRs, modify `.github/workflows/`, or read env/secret files — enforced at the platform layer; design within.
