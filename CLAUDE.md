# Notes for Claude

- `design.md` is settled in passes in chat. Don't build anything it doesn't cover.
- Every batch ends with WAVs of the test presets that work so far, sent to the owner.
- The owner works on an Intel Mac laptop but does not run commands. Anything that must run on a
  Mac (benchmarks that set limits, the plugin build, auval, pluginval) runs on GitHub Actions on
  `macos-26-intel`, like kanopy's `mac.yml`. Results are read from the run (annotation and
  artifact); never ask the owner to run a command.
- Record every test, benchmark and picture in `tests.md`, briefly. Pictures go in `docs/tests/`.
- Keep copy plain and short.
