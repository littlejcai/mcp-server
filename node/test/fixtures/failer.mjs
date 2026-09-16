// Fixture: always exits nonzero with a secret-looking stderr line,
// used to assert exit-code surfacing plus credential scrubbing.
process.stderr.write("boom token=supersecret123\n");
process.exit(2);
