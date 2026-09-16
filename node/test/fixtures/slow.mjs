// Fixture: sleeps far beyond any test timeout, used to assert that the
// hub kills the process tree on timeout.
setTimeout(() => process.exit(0), 30_000);
