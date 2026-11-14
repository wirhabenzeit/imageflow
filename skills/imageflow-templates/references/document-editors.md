# Document editors

A template can supply an editor for document parameters, for values that belong to the whole book but are best edited where the book shows them. The wall calendar's marked dates are one document parameter, edited by clicking the days of any month page:

```tsx
function MarkedDaysEditor({ values, set, context }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  const month = monthFor(context); // the same helper the month page's render uses
  // ... toggle a date of `month` in values.markedDates with set({ markedDates }) ...
}

export default defineTemplate({
  parameters: documentParameters,
  editors: { markedDays: { label: 'Marked days', parameters: ['markedDates'], component: MarkedDaysEditor } },
  spreads: ({ spread }) => ({
    month: spread({ /* ... */ render: (ctx) => <ol {...ctx.edit('document.markedDates')}>{/* the days */}</ol> }),
  }),
});
```

- **Opening it:** a node marked only with document parameters one editor owns, such as `ctx.edit('document.markedDates')`, opens that editor in the same non-modal panel as element editors, at the bottom of the canvas, with the clicked spread's `context`. So does the node's entry in the sidebar's list. A node that also shows other parameters keeps its popover.
- **Ownership:** each document parameter belongs to at most one editor, and the editor's parameters get no generated control in the template controls, which say where they are edited instead. They stay ordinary document parameters: saved data, validation, Undo and MCP's `set_parameter` are unchanged. Loading the template reports an editor that names an undeclared parameter, or a parameter two editors claim.
- **Props:** `values` (only the editor's own document parameters, with the draft applied) and `set(changes)` for them. Every other setting is read from `context.document`, so there is one current copy of each; the calendar's picker reads its language there. The other props are `context`, `format` (the context's), `readOnly`, `commit`, `cancel`, `Control` and `importFile`, as for element editors. There is no `spread` or `setSpread`; a document editor edits only document parameters. `DocumentEditorProps<D, K>` types the props from the document parameters `D` and the IDs the editor lists `K`.
- **Conflicts:** the rules of element editors apply, with the document editor's own parameters as its values. The context refreshes on a reorder, another photo, another format or another document setting. An outside change to the parameters it edits (Undo, Reload, an agent) stops it until it is reopened. Deleting its spread, or switching that spread to another layout (which removes the node it was opened from), closes it. A save queued before such a change is not applied, so an old draft never overwrites newer values.
- **Example:** the calendar starter's day picker, shown [on the page](editing-on-the-page.md#editing-on-the-page): clicking a day on a month page marks it and turns that column of days into buttons, in the page's own type (the click that opens a document editor on the page also acts in it, at the same place). A click marks a date once, for the year of the page, or unmarks it; ⌥-click marks or unmarks it every year. A plain click never changes a yearly mark. In the panel (its fallback) it is a month grid with a list that offers *Unmark every year* (or *Mark every year* for a one-off date). Removing a yearly mark keeps a one-off mark of the same day. The full text stays available under *All marked days*. Included in the contract-1 baseline.
