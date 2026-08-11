import { assert } from "chai";
import { LedgerEntry, styleLedger } from "../src/modules/styleLedger";

const PREF = "extensions.theciteshop.managedStyles";

function setRaw(value: string) {
  Zotero.Prefs.set(PREF, value);
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    shopId: "test-style",
    styleID: "http://www.zotero.org/styles/test-style",
    title: "Test Style",
    installedAt: Date.now(),
    preexisting: false,
    ...over,
  };
}

describe("styleLedger", function () {
  afterEach(function () {
    Zotero.Prefs.clear(PREF);
  });

  it("round-trips entries", function () {
    const e = entry();
    styleLedger.write([e]);
    const read = styleLedger.read();
    assert.lengthOf(read, 1);
    assert.equal(read[0].styleID, e.styleID);
    assert.equal(read[0].title, "Test Style");
  });

  it("returns [] when unset", function () {
    Zotero.Prefs.clear(PREF);
    assert.deepEqual(styleLedger.read(), []);
  });

  // read() runs inside the startup enforcement check; a throw here would take
  // the whole check down.
  it("does not throw on corrupt JSON", function () {
    setRaw("not json at all");
    assert.doesNotThrow(() => styleLedger.read());
    assert.deepEqual(styleLedger.read(), []);
  });

  it("rejects an unrecognized envelope version", function () {
    setRaw(JSON.stringify({ v: 99, entries: [entry()] }));
    assert.deepEqual(styleLedger.read(), []);
  });

  it("rejects a non-array entries field", function () {
    setRaw(JSON.stringify({ v: 1, entries: "nope" }));
    assert.deepEqual(styleLedger.read(), []);
  });

  it("drops malformed entries individually but keeps good ones", function () {
    setRaw(
      JSON.stringify({
        v: 1,
        entries: [null, { title: "no styleID" }, entry({ shopId: "keeper" })],
      }),
    );
    const read = styleLedger.read();
    assert.lengthOf(read, 1);
    assert.equal(read[0].shopId, "keeper");
  });

  it("upserts by styleID rather than duplicating", function () {
    styleLedger.record(entry({ title: "First" }));
    styleLedger.record(entry({ title: "Second" }));
    const read = styleLedger.read();
    assert.lengthOf(read, 1);
    assert.equal(read[0].title, "Second");
  });

  // An update must never flip a style from "we own it" to "pre-existing",
  // which would exempt it from removal.
  it("preserves the original preexisting flag across re-records", function () {
    styleLedger.record(entry({ preexisting: true }));
    styleLedger.record(entry({ preexisting: false }));
    assert.isTrue(styleLedger.read()[0].preexisting);
  });

  it("reports has() and count() correctly", function () {
    assert.equal(styleLedger.count(), 0);
    const e = entry();
    styleLedger.record(e);
    assert.isTrue(styleLedger.has(e.styleID));
    assert.isFalse(styleLedger.has("http://example.com/nope"));
    assert.equal(styleLedger.count(), 1);
  });

  // Zotero.Styles.get() returns false — not null/undefined — on a miss.
  // A `!= null` check would pass on false and then call .remove() on a
  // boolean. This is the likeliest single bug in the feature.
  it("treats a missing style as already-gone without throwing", async function () {
    styleLedger.record(entry({ styleID: "http://example.com/does-not-exist" }));
    // An unhandled rejection here fails the test on its own — no need for
    // chai-as-promised, which this project does not depend on.
    const report = await styleLedger.removeAll("expired");
    assert.isUndefined(report.aborted, "should not abort");
    assert.lengthOf(report.failed, 0, "must not be recorded as a failure");
    assert.include(report.alreadyGone, "http://example.com/does-not-exist");
    // The entry is dropped, since the style genuinely is not there.
    assert.equal(styleLedger.count(), 0);
  });

  it("drops already-gone entries but retains nothing spurious", async function () {
    styleLedger.write([
      entry({ shopId: "a", styleID: "http://example.com/a" }),
      entry({ shopId: "b", styleID: "http://example.com/b" }),
    ]);
    const report = await styleLedger.removeAll("tolerance-exceeded");
    assert.lengthOf(report.alreadyGone, 2);
    assert.equal(styleLedger.count(), 0);
  });

  it("removeSome leaves untargeted entries alone", async function () {
    styleLedger.write([
      entry({ shopId: "a", styleID: "http://example.com/a" }),
      entry({ shopId: "b", styleID: "http://example.com/b" }),
    ]);
    await styleLedger.removeSome(
      ["http://example.com/a"],
      "entitlement-revoked",
    );
    const read = styleLedger.read();
    assert.lengthOf(read, 1);
    assert.equal(read[0].styleID, "http://example.com/b");
  });

  it("prune leaves the ledger untouched when nothing is installed", function () {
    // These style IDs do not exist in Zotero, so prune should drop them —
    // but it must not throw, and must not wipe on an unloaded-data error.
    styleLedger.write([entry({ styleID: "http://example.com/ghost" })]);
    assert.doesNotThrow(() => styleLedger.prune());
  });
});
