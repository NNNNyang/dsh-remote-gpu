// Print the probe command that index.js would run.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
const start = src.indexOf('const DEFAULT_COMMAND = [')
const open = src.indexOf('[', start)
const end = src.indexOf("].join(' ')", open)
const fragments = eval(src.slice(open, end + 1))
process.stdout.write(fragments.join(' ') + '\n')
