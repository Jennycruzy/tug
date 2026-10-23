# Using TUG's data on your own page

Free, no key, no cookies. Data refreshes every 5 minutes.

## The widget

One market:

```html
<script src="https://tug.38-49-216-59.sslip.io/embed.js" data-symbol="ETH-USD"></script>
```

The five markets where Strike's copy picks and fade picks disagree most:

```html
<script src="https://tug.38-49-216-59.sslip.io/embed.js" data-symbol="all" data-theme="dark"></script>
```

`data-theme` is `light` or `dark` (default: the visitor's setting). The script adds one iframe from TUG's site
and nothing else. Or embed the iframe directly: `<iframe src="https://tug.38-49-216-59.sslip.io/embed/ETH-USD"
style="width:100%;height:128px;border:0"></iframe>`.

## The API

```js
const r = await fetch("https://tug.38-49-216-59.sslip.io/api/v1/tug");
const { markets } = await r.json();
// each market: symbol, copy {long, short, lean, n}, fade {…}, gap, tradable, TUG's position
```

Every endpoint is in the [OpenAPI document](https://tug.38-49-216-59.sslip.io/api/openapi.json); a plain-text
guide for agents is at [/llms.txt](https://tug.38-49-216-59.sslip.io/llms.txt). 60 requests per minute.

## On a copy-trading page

Next to a trader Strike lists as a copy pick, the widget shows whether that market's copy picks as a group lean
the same way as Strike's fade picks or against them, which is the gap TUG trades.
