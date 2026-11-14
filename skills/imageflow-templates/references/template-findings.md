# Template findings

A template reports problems with its input, such as an assigned file it cannot parse, with `issue()`. Spread the result onto a rendered node, or onto `Spread`, `PhotoBox`, `MarkdownBox` or `Element`, which forward it to their own node; a hidden node works in export:

```tsx
<span hidden {...issue({
  code: 'gpx-invalid', message: source.name + ' has no track.',
  element: 'route', parameter: 'track', file: trackId, details: { points: 0 },
  suggestion: 'Assign a GPX file that contains a track or route.',
})} />
```

- `code` is lowercase (`a-z`, digits, `-`). The Book check and `check_book` report it as `template:<code>`, so it cannot collide with platform codes.
- The location is the given `box` or `element`, or else the box or element that contains the node. `parameter` names the parameter, and `file` the file ID of a file parameter; it is reported as the finding's `source`.
- `severity` is `warning` by default. `error` blocks print export, like other layout errors.
- `details` carries measured or related values (strings or numbers). `suggestion` is advice for a person or agent; ImageFlow never applies it.
- A finding is reported once per spread render, however many identical nodes carry it. Findings render from the same input every time, so editor, check and export report the same ones.

A plain `data-issue="…"` attribute still works. It reports a `template-issue` warning on the containing box or element. An `issue()` value that fails validation is reported as `template-issue-invalid`.
