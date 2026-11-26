# Parameters

`p.*` helpers create plain, serializable schema objects; the editor generates controls from them, and the `spread` builder infers render-context types from them. A spread declared as a plain object gets a broad context.

| Helper | Value | Options |
| --- | --- | --- |
| `p.boolean` | `boolean` | `default`, `shows` (on a photo box: `'caption'`, see below) |
| `p.integer` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.number` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.string` | `string` | `default`, `multiline`, `maxLength`, `placeholder`, `markdown` ([Formatted text](formatted-text.md#formatted-text-formatted-text)) |
| `p.enum` | one of `options` | `default`, `options` (an array of values or a value-to-label map), optional `labels` for arrays |
| `p.color` | `#rrggbb` | `default` |
| `p.date` | ISO date `YYYY-MM-DD` | `default`, `min`, `max`, `precision` (`day` or `month`) |
| `p.file` | file ID, or `''` when none is assigned | `accept` (lowercase extensions such as `'.gpx'`); see File parameters |
| `p.list` | array of items, each `{ id, ...fields }` | `item` (the fields), `min`, `max`, `default` (items, `[]` when omitted); see List parameters |

Every parameter has a `label` and a `default` (`p.file` supplies `''`, `p.list` `[]`); a saved value outside the constraints is reported and replaced by the default for rendering, but kept in `project.json`.

Any parameter, at any scope, may also have a `description`: plain help text of up to 1000 characters (trimmed, not empty), for people and agents alike. Say what the value means, which way it goes and when to change it, so an agent asked to "zoom the map out a bit" knows which parameter to lower:

```ts
zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: 8, step: .1,
  description: 'Higher values zoom in. 1 shows the whole route; 2 shows half its width.' }),
```

A yes/no parameter of a photo box that prints the photo's caption says so with `shows: 'caption'`:

```ts
hero: box.photo('Main photograph', { showCaption: p.boolean({ label: 'Show caption', default: false, shows: 'caption' }) }),
```

Any placed photo's caption can be edited from the page (**Caption…** beside the box's settings, **Edit Caption…** in its context menu). With `shows`, entering the first caption of a photo also switches the parameter on, as a caption would otherwise be saved and not printed. Changing a caption, or removing it, leaves the parameter alone. `shows` has no effect elsewhere, and ImageFlow 1.0.0-beta.24 and earlier ignore it.

Descriptions appear with the parameter's type, range, `step`, `unit` and options in `get_authoring_context` (under `template`) and in `inspect_book`'s parameter view. In the editor, a field shows its parameter's description only as its hover tooltip, so the settings stay uncluttered; write it for agents first. A `description` on a `controls` entry is shown under the field instead and replaces it there; control descriptions have the same limits. Descriptions never change defaults, allowed values or saved data. Put units in `unit`, not in the description.

Scopes: `parameters` at template level (document), on a spread definition (spread instance), on a box or element (element instance). Values are stored in `project.json` at the matching scope. There is no inheritance between scopes.
