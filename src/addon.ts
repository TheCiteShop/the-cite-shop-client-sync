import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
    /**
     * Subscription enforcement state. Plugin-scoped and created once, which is
     * what makes duplicate enforcement timers structurally impossible.
     */
    license: {
      timerId?: ReturnType<typeof setTimeout>;
      /** Re-entrancy guard — startup, timer and prefs checks can overlap. */
      enforcing?: boolean;
      lastOutcome?: string;
      lastCheckAt?: number;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      license: {},
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
