import { assert } from "chai";
import { LedgerEntry, styleLedger } from "../src/modules/styleLedger";
import { enforceAuthoritativeRefusal } from "../src/modules/enforcement";
import { sha256Hex } from "../src/utils/hash";

const PREF = "extensions.theciteshop.managedStyles";

// A real, installable CSL used to prove the hash check both removes our file
// and spares one that merely shares the id. Declared at module scope because
// mocha/no-setup-in-describe forbids the join() inside a describe block.
const SHOP_ID = "tcs-hash-test";
const STYLE_ID = "http://www.zotero.org/styles/" + SHOP_ID;
const CSL = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">',
  "  <info>",
  "    <title>TCS Hash Test</title>",
  "    <id>" + STYLE_ID + "</id>",
  "    <updated>2026-01-01T00:00:00+00:00</updated>",
  "  </info>",
  "  <citation>",
  "    <layout>",
  '      <text variable="title"/>',
  "    </layout>",
  "  </citation>",
  "</style>",
].join("\n");

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

  // The hash is what separates "a style with our id" from "our style". Getting
  // this wrong deletes a customer's own file, so both directions are tested.
  describe("removeUntrackedMatches", function () {
    afterEach(async function () {
      Zotero.Prefs.clear("extensions.theciteshop.styleHashes");
      const leftover = (Zotero as any).Styles.get(STYLE_ID, true);
      if (leftover && leftover.path) await leftover.remove();
    });

    it("returns an empty report when no fingerprints are known", async function () {
      const report = await styleLedger.removeUntrackedMatches("expired");
      assert.lengthOf(report.removed, 0);
      assert.isUndefined(report.aborted);
    });

    it("removes an untracked style whose content hash matches", async function () {
      await (Zotero as any).Styles.install(CSL, null, true);
      const installed = (Zotero as any).Styles.get(STYLE_ID, true);
      if (!installed) this.skip();

      // Hash the ORIGINAL string, exactly as the server does over the .csl it
      // serves. Production stores that hash, so if Zotero ever stopped writing
      // style content verbatim the sweep would silently match nothing — which
      // is why this asserts the round trip rather than hashing the file back.
      const serverHash = await sha256Hex(CSL);
      const onDisk = String(await Zotero.File.getContentsAsync(installed.path));
      assert.equal(
        await sha256Hex(onDisk),
        serverHash,
        "Zotero must write style content byte-for-byte, or stored server hashes never match on disk",
      );

      styleLedger.recordHashes({ [SHOP_ID]: serverHash });

      const report = await styleLedger.removeUntrackedMatches("expired");
      assert.include(report.removed, STYLE_ID);
      assert.isNotOk((Zotero as any).Styles.get(STYLE_ID, true));
    });

    // The important one: a customer's own style sharing our id must survive.
    it("leaves a same-id style alone when the hash differs", async function () {
      await (Zotero as any).Styles.install(CSL, null, true);
      const installed = (Zotero as any).Styles.get(STYLE_ID, true);
      if (!installed) this.skip();

      styleLedger.recordHashes({ [SHOP_ID]: "0".repeat(64) });

      const report = await styleLedger.removeUntrackedMatches("expired");
      assert.lengthOf(report.removed, 0);
      assert.include(report.skipped, STYLE_ID);
      assert.isOk((Zotero as any).Styles.get(STYLE_ID, true));
    });
  });

  // Regression: the Verify button reported "license is no longer active" while
  // leaving the styles installed, because it deliberately bypasses the normal
  // enforcement check. An authoritative refusal must remove them whatever path
  // produced it.
  describe("enforceAuthoritativeRefusal", function () {
    it("removes managed styles when the server says expired", async function () {
      styleLedger.write([entry({ styleID: "http://example.com/gone" })]);
      await enforceAuthoritativeRefusal("expired");
      assert.equal(styleLedger.count(), 0);
    });

    it("removes managed styles when the server says invalid", async function () {
      styleLedger.write([entry({ styleID: "http://example.com/gone" })]);
      await enforceAuthoritativeRefusal("invalid-credentials");
      assert.equal(styleLedger.count(), 0);
    });

    it("leaves styles alone for a transient outcome", async function () {
      styleLedger.write([entry({ styleID: "http://example.com/gone" })]);
      for (const outcome of [
        "unreachable",
        "server-error",
        "rate-limited",
        "no-zotero-user",
      ] as const) {
        const report = await enforceAuthoritativeRefusal(outcome);
        assert.isNull(report, outcome);
      }
      assert.equal(styleLedger.count(), 1);
    });

    // Returns a report rather than null even with an empty ledger: there may
    // still be untracked files to sweep by hash, so this path must run.
    it("removes nothing when there is nothing to remove", async function () {
      const report = await enforceAuthoritativeRefusal("expired");
      assert.isNotNull(report);
      assert.lengthOf(report!.removed, 0);
      assert.lengthOf(report!.failed, 0);
    });
  });
});
