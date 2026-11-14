<script setup lang="ts">
import { useData, withBase } from 'vitepress';
const { frontmatter } = useData();
</script>

<template>
  <div v-if="frontmatter.history" class="custom-block warning page-banner">
    <p class="custom-block-title">Historical document</p>
    <p>Design history; this page may not match the app. See the <a :href="withBase('/guide/getting-started')">user guide</a> and the <a :href="withBase('/templates/')">template API</a> for current behaviour.</p>
  </div>
</template>
