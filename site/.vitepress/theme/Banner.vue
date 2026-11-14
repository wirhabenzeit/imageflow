<script setup lang="ts">
import { useData, withBase } from 'vitepress';
const { frontmatter } = useData();
</script>

<template>
  <div v-if="frontmatter.history" class="custom-block warning page-banner">
    <p class="custom-block-title">Historical document</p>
    <p>This page records how ImageFlow was designed. It is kept for background and may not match the app. The <a :href="withBase('/guide/getting-started')">user guide</a> and the <a :href="withBase('/templates/')">template API</a> describe current behaviour.</p>
  </div>
  <div v-else-if="frontmatter.preview" class="custom-block info page-banner">
    <p class="custom-block-title">Before the first release</p>
    <p>The template API (contract 1) can still change until ImageFlow's first public release, when its baseline is fixed. See <a :href="withBase('/decisions/0008-baseline-freeze-at-release')">decision 0008</a>.</p>
  </div>
</template>
