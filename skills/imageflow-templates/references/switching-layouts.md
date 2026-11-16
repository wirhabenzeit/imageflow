# Switching layouts

The editor can switch a full sheet between one spread layout and two page layouts without changing its pagination. Choosing a page layout applies to the selected side, and choosing a spread layout merges both pages. Ordinary opening and closing pages stay single units. See [Page layouts](page-layouts.md) for the editor controls and current automation limits.

Within a spread or page state, switching layouts keeps the ID-based state below. A sheet also remembers its spread state and each page state independently.

**An ID is the identity.** A box, element or parameter ID means the same thing in every layout that declares it, within its scope: spread parameters, the boxes of a spread and each box's parameters, the elements of a spread and each element's parameters. Each spread or page state keeps values keyed by these IDs; its layout decides which are shown. The same box ID on two facing page states names two independent assignments. Templates need no extra declarations, roles or migration code for this.

- **Same ID, same type.** A box ID has the same box type (photo or Markdown) in every layout, and a parameter ID has the same parameter type in every layout within its scope. A template that breaks this fails to load with an error naming both layouts. Labels, defaults and constraints (`min`/`max`, `step`, `maxLength`, `multiline`, enum `options`, date `precision`, file `accept`) may differ, so a layout can offer fewer columns or a shorter title than another.
- **Different meaning, different ID.** Reusing an ID shares its value. A closing page would declare `closingLine` rather than `heading`, because a closing line is not the spread heading. Differently named boxes are never matched automatically, and box order plays no part: a two-photo layout shows the boxes whose IDs it declares.
- **Content.** Photo and Markdown assignments show in every layout with a box of that ID. Content a layout has no box for stays in its spread or page state, is listed in the Inspector under *Set aside*, and shows again in any layout that has the box. Switching never deletes content, and sources stay in the project.
- **Placing kept content.** *Place in…* (or dragging the item onto a box of the same spread) moves kept content into a box of the current layout. If the box shows something, the two swap, so that content is kept instead of lost. A move is not a copy: the item is no longer kept, so it cannot appear twice when you switch back. Its crop focus moves with it; its per-layout crops were made for the old box's frames and do not. Box parameters belong to the box ID and stay. Dragging a kept item onto another spread, or a source from the strip onto any box, places another use of the source instead. *Discard* removes kept content from the spread; the source stays in the project, and Undo brings it back. Element settings kept for other layouts are listed by element name.
- **Latest edit wins.** There is one value per ID, so an edit made in any layout is what every later layout sees. Replacing a photo in one layout replaces it for all of them; an older assignment cannot come back by switching. Removing a photo or text is a real edit; visiting a layout without that box is not.
- **Parameters.** Spread, box and element parameter values follow the same rule. A value the current layout does not declare stays stored and returns with a layout that does. Values are stored only once set, so a layout whose parameter was never set shows its own default.
- **Rejected values.** When a stored value fails the target layout's constraints (for example a 120-character title where the layout allows 60, or a column count it does not offer), the value is kept unchanged, the layout uses its default, the switch says so, and the Book check warns. Setting the field in that layout replaces the value.
- **Crops.** A crop belongs to the layout it was set in, because frames differ. Returning to a layout restores its crop. A layout without its own crop fills its frame around the centre of the crop set last (the *focus*), clamped to the frame. Assigning another photo to a box starts over: no crop of the previous photo applies to it. Resetting a crop, or setting a centred fill, clears the focus.
- **Text flow.** Continuation is recomputed for the whole book after a switch, from the Markdown boxes each spread now shows.
- **Element editors.** Custom element editors never store their own state; their parameters follow the rules above.

## Between spreads and pages

A layout change reads only the layouts it replaces. Changing one page never takes content from, or changes, the page that stays visible. Splitting replaces the spread layout; merging replaces both shown page layouts.

For each ID the new layout declares, the value comes from:

1. A replaced layout that shows the ID, **including an empty box or a default parameter**. When merging, a stored value beats an empty/default; between two values the selected side wins, or the left side without a selection. A value moves to only one target; when splitting, the chosen side takes first.
2. The target state's own memory, when the replaced layouts did not show that ID.
3. For a page, the spread's stored memory that no shown layout uses.

Moving a box transfers its complete state: assignment, box parameters, focus and per-layout crops. It leaves its source state. Content the target stored for that ID moves to **Replaced**, with its original location, rather than silently returning on a later switch. Parameter values are overwritten like ordinary edits. Cleared boxes and reset/default parameters carry over as empty/default, so an older stored value cannot reappear by switching.

Content no target takes stays stored where it was. **Set aside** lists it by location: on the spread, on the left page or on the right page. **Replaced** lists overwritten content separately. **Place in…** explicitly returns either kind of content to a compatible shown box, including the facing page; an occupied destination swaps its assignment back. **Discard** removes that item, and Undo restores it.

For example, splitting a spread whose `hero` holds photo A into a left photo page moves A to the left. The right is blank until a layout is chosen or its remembered page returns. Giving the right a text layout never changes the left photo. Merging two pages with different `hero` photos uses the selected page's photo, while preserving the other content for later. Every change is one Undo step, restoring all stored states and replaced content exactly.

Selecting a layout is one edit: Undo restores the previous layout with everything it showed. Pointing at a layout in the picker shows what switching would do, for example *2 photos carried over · 2 photos kept outside this layout · text will reflow*. A selected photo or open edit popover on the spread closes when its layout changes, and an open element editor reports that its values changed, so nothing is saved into a layout it was not opened for.

State that no layout of the template declares (after the template drops a box, element or parameter) stays in `project.json` and is reported in the Book check rather than removed.
