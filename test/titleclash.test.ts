import { assert } from "chai";

/**
 * Pins two Zotero install behaviors we depend on. Both were established
 * empirically after a misreading of Zotero's source led to a spurious
 * "this will delete your style" warning being shipped.
 *
 * `_install` looks for an existing style by id, filename, or title and then
 * calls `existingFile.remove(false)`. That line cannot fire: it assigns
 * `existingStyle.file`, and `Zotero.Style` has no `.file` property — only
 * `.path` and `.fileName`. It is dead code left from the nsIFile era.
 *
 * The practical upshot:
 *   - same id      -> file IS replaced, because the filename derives from the
 *                     id and putContentsAsync overwrites it
 *   - same title,
 *     different id -> both styles coexist; nothing is deleted
 *
 * If Zotero ever repairs that branch, the second test here starts failing and
 * we will know to reinstate a warning.
 */

function csl(id: string, title: string, marker: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">',
    "  <info>",
    "    <title>" + title + "</title>",
    "    <id>http://www.zotero.org/styles/" + id + "</id>",
    "    <summary>" + marker + "</summary>",
    "    <updated>2026-01-01T00:00:00+00:00</updated>",
    "  </info>",
    "  <citation><layout><text variable='title'/></layout></citation>",
    "</style>",
  ].join("\n");
}

const ID_A = "http://www.zotero.org/styles/tcs-clash-a";
const ID_B = "http://www.zotero.org/styles/tcs-clash-b";
const SHARED_TITLE = "TCS Clash Probe";

describe("Zotero install behavior", function () {
  afterEach(async function () {
    for (const id of [ID_A, ID_B]) {
      const s = (Zotero as any).Styles.get(id, true);
      if (s && s.path) await s.remove();
    }
  });

  it("replaces the file when the style id is the same", async function () {
    await (Zotero as any).Styles.install(
      csl("tcs-clash-a", "First Title", "ORIGINAL"),
      null,
      true,
    );
    await (Zotero as any).Styles.install(
      csl("tcs-clash-a", "Second Title", "REPLACEMENT"),
      null,
      true,
    );

    const style = (Zotero as any).Styles.get(ID_A, true);
    assert.isOk(style);
    const content = String(await Zotero.File.getContentsAsync(style.path));
    assert.include(content, "REPLACEMENT");
    assert.notInclude(content, "ORIGINAL");
  });

  // This is why the plugin does NOT warn about title collisions: there is
  // nothing to warn about.
  it("leaves a same-title style with a different id installed", async function () {
    await (Zotero as any).Styles.install(
      csl("tcs-clash-a", SHARED_TITLE, "A"),
      null,
      true,
    );
    await (Zotero as any).Styles.install(
      csl("tcs-clash-b", SHARED_TITLE, "B"),
      null,
      true,
    );

    assert.isOk(
      (Zotero as any).Styles.get(ID_A, true),
      "Zotero does not delete a same-title style; if this fails, Zotero's behavior changed",
    );
    assert.isOk((Zotero as any).Styles.get(ID_B, true));
  });
});
