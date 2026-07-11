/* sqlitefeed entry.
 *
 * yeetd installs the `tty` global only when a terminal is allocated; when the
 * output is piped (or forced headless with `yeet run -T`) it is absent. Branch
 * on that: interactive gets the dashboard, headless gets one JSON object per
 * completed statement on stdout — same probes, same correlation, two sinks.
 */
import { mount } from "yeet:tui";
import { Root } from "./app.jsx";
import { startJson } from "./json.js";

if (typeof tty === "undefined") {
  startJson();
} else {
  mount(Root);
}
await new Promise(() => {}); // keep the script alive
