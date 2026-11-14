# Writing templates

Templates define a book's layouts, print formats, settings and editors in TypeScript and React. Each book has its own `template/` folder. Edit it while the book is open to see changes and errors in ImageFlow.

## Start here

1. Create a book from **Photobook** and open `template/index.tsx` in your editor. Included declarations and `tsconfig.json` provide type checking without installing packages.
2. Read [Package](../template-api/package.md) and [Declaration](../template-api/declaration.md).
3. Adapt an [example template](../examples). `minimal.tsx` is the smallest complete example. Examples use generic fonts; bundle fonts before [print export](../template-api/css-contract.md#fonts-and-output).
4. Use the Book check to catch layout and content issues.
5. Import the finished template folder into the [library](../guide/templates.md) to create new books or share it.

For help from an agent, see [Connecting agents](../guide/agents.md) and the [authoring workflow](../template-api/authoring-workflow.md).

## Template API reference

These topics are also available through ImageFlow's MCP tools and the template skill.

<TopicList />

<div v-if="false">

On GitHub, browse [`template-api`](../template-api) or read [the full reference](../template-api.md).

</div>

Templates run code inside ImageFlow. Only open books and templates you trust.
