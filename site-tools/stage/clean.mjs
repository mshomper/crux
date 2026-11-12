#!/usr/bin/env node
// Deletes the staged demo folder in temp (stage.mjs made it). Stop the hub and the overlay first.
//   node site-tools/stage/clean.mjs
import { rmSync, existsSync } from 'node:fs';
import { root } from './paths.mjs';

rmSync(root, { recursive: true, force: true });
console.log(`${root} ${existsSync(root) ? 'is still there' : 'is gone'}`);
