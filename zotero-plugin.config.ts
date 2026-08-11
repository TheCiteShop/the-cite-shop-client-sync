import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*", "*.csl", "customers.json"],
    define: {
      ...pkg.config,
      author: pkg.author.name,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  release: {
    // 0.0.1 is the first release of this plugin, but the repository carries the
    // full history of the template it was derived from. With no earlier tag to
    // diff against, the default commit walk reaches the root and produces ~150
    // entries of upstream template history. Supply the notes directly instead.
    // Remove this once v0.0.1 is tagged — from then on the default is correct.
    changelog: () =>
      [
        "Initial release.",
        "",
        "- License validation via email and license key",
        "- Browse, install, and update purchased citation styles within Zotero",
        "- Subscription enforcement: the license is re-checked at startup, daily,",
        "  and when the settings pane is opened",
        "- Purchased styles are removed if the subscription ends, or if no license",
        "  check has succeeded for 3 days. Only purchased styles are ever touched",
        "- Dark mode support",
      ].join("\n"),
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
