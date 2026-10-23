// TUG widget: <script src="https://tug.38-49-216-59.sslip.io/embed.js" data-symbol="ETH-USD"></script>
// data-symbol: a Strike market (ETH-USD) or "all" (the five widest gaps). data-theme: light | dark (default: the
// visitor's setting). It adds one iframe from TUG's site; no cookies, nothing else is loaded.
(function () {
  var s = document.currentScript;
  if (!s) return;
  var origin = new URL(s.src).origin;
  var symbol = (s.getAttribute("data-symbol") || "all").replace(/[^A-Za-z0-9-]/g, "");
  var theme = s.getAttribute("data-theme");
  var f = document.createElement("iframe");
  f.src = origin + "/embed/" + symbol + (theme === "light" || theme === "dark" ? "?theme=" + theme : "");
  f.title = "TUG: Strike's copy picks vs fade picks, " + symbol;
  f.loading = "lazy";
  f.style.cssText = "width:100%;max-width:520px;border:0;border-radius:12px;height:" + (symbol.toLowerCase() === "all" ? "420px" : "128px");
  s.parentNode.insertBefore(f, s.nextSibling);
})();
