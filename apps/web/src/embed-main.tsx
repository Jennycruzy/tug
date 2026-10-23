import { render } from "preact";
import { Embed } from "./embed.js";
import "./styles.css";

// The widget's own small entry (embed.html, served for /embed/<symbol>); ?theme=light|dark forces a theme.
const symbol = window.location.pathname.match(/^\/embed\/([A-Za-z0-9-]+)$/)?.[1] ?? "all";
const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
render(<Embed symbol={symbol} />, document.getElementById("app")!);
