import {readFile} from 'node:fs/promises';
const html = await readFile(new URL('../public/index.html', import.meta.url),'utf8');
const source = ['getStatusBadgeStyle','renderSemanticStatusBadge'].map(name=>{
  const start=html.indexOf('        function '+name+'(');
  return html.slice(start,html.indexOf('\n        }',start)+10);
}).join('\n');
export const semanticBadges = new Function(source+'\nreturn {getStatusBadgeStyle,renderSemanticStatusBadge};')();
