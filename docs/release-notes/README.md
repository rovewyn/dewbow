# Release notes

These files contain release-specific changes, supported upgrade sources, state-reset exceptions, rollback requirements and known limitations. Consult both the source and target versions before upgrading. General versioning and publication procedures live in [Versioning and releases](../releasing.md); persistent-state rules live in [Management storage and compatibility](../storage.md).

Find the current development target in `[workspace.package].version` in the root `Cargo.toml`, or run `npm run version:check` to print and verify it. Replace `<version>` in `docs/release-notes/<version>.md` with that exact value. Create the matching unreleased note when setting the next development target; the index below includes both planned and published versions.

- [0.2.0](0.2.0.md) - published; decentralized Networks and the compatibility baseline
- [0.1.0](0.1.0.md) - first published release

An unreleased note is a plan, not evidence that a tag or release artifact exists. Published versions and available artifacts are listed on [GitHub Releases](https://github.com/rovewyn/dewbow/releases).
