import { assert } from "chai";
import { LicenseOutcome, classifyResponse } from "../src/modules/license";
import { decideAction } from "../src/modules/enforcement";

const DAY = 24 * 60 * 60 * 1000;
const TOLERANCE = 3 * DAY;
const NOW = 1_760_000_000_000;

/** Outcomes that carry no entitlement information — the clock decides. */
const TRANSIENT: LicenseOutcome[] = [
  "unreachable",
  "server-error",
  "rate-limited",
  "no-zotero-user",
];

describe("subscription enforcement", function () {
  describe("classifyResponse", function () {
    it("maps an authoritative active verdict", function () {
      assert.equal(
        classifyResponse(200, { status: "active", authoritative: true }),
        "active",
      );
    });

    it("maps an authoritative expired verdict", function () {
      assert.equal(
        classifyResponse(200, { status: "expired", authoritative: true }),
        "expired",
      );
    });

    it("maps an authoritative invalid verdict", function () {
      assert.equal(
        classifyResponse(200, { status: "invalid", authoritative: true }),
        "invalid-credentials",
      );
    });

    it("maps 429 to rate-limited", function () {
      assert.equal(
        classifyResponse(429, { status: "expired" }),
        "rate-limited",
      );
    });

    it("maps 5xx to server-error even with an expired body", function () {
      assert.equal(
        classifyResponse(500, { status: "expired", authoritative: true }),
        "server-error",
      );
      assert.equal(classifyResponse(503, null), "server-error");
    });

    it("maps a non-object body to server-error", function () {
      assert.equal(
        classifyResponse(403, "<html>Forbidden</html>"),
        "server-error",
      );
      assert.equal(classifyResponse(200, null), "server-error");
    });

    it("maps an unrecognised status to server-error", function () {
      assert.equal(
        classifyResponse(200, { status: "banana", authoritative: true }),
        "server-error",
      );
    });

    // A WAF or proxy can return a 403 body; only the server asserting
    // `authoritative` counts as an entitlement decision.
    it("ignores a status that is not marked authoritative", function () {
      assert.equal(
        classifyResponse(200, { status: "expired" }),
        "server-error",
      );
    });

    it("accepts a legacy valid:true body", function () {
      assert.equal(classifyResponse(200, { valid: true }), "active");
    });

    // The safety interlock: a backend that has not yet shipped the new
    // contract must never be able to trigger a mass uninstall.
    it("degrades legacy valid:false to server-error, NOT expired", function () {
      assert.equal(classifyResponse(200, { valid: false }), "server-error");
    });

    it("never returns expired for a 429 carrying an expired body", function () {
      assert.notEqual(
        classifyResponse(429, { status: "expired", authoritative: true }),
        "expired",
      );
    });
  });

  describe("decideAction", function () {
    it("keeps on active", function () {
      assert.equal(
        decideAction("active", NOW - 9 * DAY, NOW, 3).action,
        "keep",
      );
    });

    it("uninstalls on an authoritative verdict, ignoring the clock", function () {
      assert.equal(decideAction("expired", NOW, NOW, 3).action, "uninstall");
      assert.equal(
        decideAction("invalid-credentials", NOW, NOW, 3).action,
        "uninstall",
      );
    });

    it("keeps every transient outcome inside the tolerance window", function () {
      for (const outcome of TRANSIENT) {
        const d = decideAction(outcome, NOW - 2 * DAY, NOW, 2, TOLERANCE);
        assert.equal(d.action, "keep-and-warn", outcome);
        assert.equal(d.daysRemaining, 1, outcome);
      }
    });

    // 429 is never an *immediate* uninstall, but it must not stop the clock
    // either — otherwise a poisoned endpoint is an unlimited bypass.
    it("uninstalls every transient outcome past the tolerance window", function () {
      for (const outcome of TRANSIENT) {
        const d = decideAction(outcome, NOW - 4 * DAY, NOW, 2, TOLERANCE);
        assert.equal(d.action, "uninstall", outcome);
        assert.equal(d.daysElapsed, 4, outcome);
      }
    });

    it("never uninstalls a transient outcome on a fresh sync", function () {
      for (const outcome of TRANSIENT) {
        assert.notEqual(
          decideAction(outcome, NOW, NOW, 2, TOLERANCE).action,
          "uninstall",
          outcome,
        );
      }
    });

    it("does not uninstall exactly at the boundary", function () {
      const d = decideAction("unreachable", NOW - TOLERANCE, NOW, 2, TOLERANCE);
      assert.equal(d.action, "keep-and-warn");
    });

    it("uninstalls one millisecond past the boundary", function () {
      const d = decideAction(
        "unreachable",
        NOW - TOLERANCE - 1,
        NOW,
        2,
        TOLERANCE,
      );
      assert.equal(d.action, "uninstall");
    });

    // A missing timestamp is not evidence of a lapse. Deleting on the strength
    // of unset state would wipe styles for anyone whose prefs were reset.
    it("never uninstalls when lastSyncOk is unset", function () {
      assert.equal(
        decideAction("unreachable", null, NOW, 5, TOLERANCE).action,
        "keep-and-warn",
      );
      assert.equal(
        decideAction("unreachable", null, NOW, 0, TOLERANCE).action,
        "keep",
      );
    });

    it("treats a future lastSyncOk as not-elapsed rather than overflowing", function () {
      const d = decideAction("unreachable", NOW + 5 * DAY, NOW, 2, TOLERANCE);
      assert.equal(d.action, "keep-and-warn");
      assert.equal(d.daysElapsed, 0);
    });
  });
});
