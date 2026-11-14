// The built-in templates, each a sample book in the app's `sample/` folder whose `template/` the library lists.
// Their name and description come from the template itself. The list lives in `sample/starters.json` so the release
// script (scripts/released-templates.mjs) reads the same list.
import list from '../sample/starters.json';

export const starters: readonly { folder: string; defaultName: string }[] = list;
