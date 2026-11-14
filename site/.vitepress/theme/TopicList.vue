<script setup lang="ts">
import { withBase } from 'vitepress';
import topics from '../../../docs/template-api/topics.json';

// Rendered from the same manifest the MCP server and the agent skill use.
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`([^`]+)`/g, '<code>$1</code>');
</script>

<template>
  <table class="topic-list">
    <thead><tr><th>Topic</th><th>What it covers</th></tr></thead>
    <tbody>
      <tr v-for="topic in topics" :key="topic.id">
        <td><a :href="withBase('/template-api/' + topic.id)" v-html="html(topic.title)"></a></td>
        <td v-html="html(topic.summary)"></td>
      </tr>
    </tbody>
  </table>
</template>
